import { describe, expect, test } from "bun:test";

import {
    AgentRequests,
    METHOD_NOT_FOUND,
    REQUEST_CANCELLED,
} from "../requests";

type Sent = {
    id: unknown;
    result?: unknown;
    error?: { code: number; message: string };
};

function ledger() {
    const sent: Sent[] = [];
    const requests = new AgentRequests((id, result, error) =>
        sent.push({ id, result, error }),
    );
    return { requests, sent };
}

const permission = (id: unknown, sessionId: string, toolCallId: string) => ({
    id,
    method: "session/request_permission",
    params: {
        sessionId,
        title: "Run ls",
        subject: { type: "tool_call", toolCall: { toolCallId } },
        options: [{ optionId: "yes", name: "Yes", kind: "allow_once" }],
    },
});

const form = (
    id: unknown,
    sessionId: string | null,
    elicitationId?: string,
) => ({
    id,
    method: "elicitation/create",
    params: {
        mode: "form",
        message: "Which?",
        requestedSchema: { type: "object", properties: {} },
        ...(sessionId === null ? {} : { sessionId }),
        ...(elicitationId === undefined ? {} : { elicitationId }),
    },
});

describe("receiving requests", () => {
    test("permissions and elicitations go into the book, queryable by session and by tool call", () => {
        const { requests } = ledger();
        requests.receive(permission(1, "s1", "t1"));
        requests.receive(form(2, "s1", "e1"));
        requests.receive(permission(3, "s2", "t2"));
        expect(requests.list().map((r) => r.kind)).toEqual([
            "permission",
            "elicitation",
            "permission",
        ]);
        expect(requests.forSession("s1")).toHaveLength(2);
        expect(requests.permissionFor("t2")?.sessionId).toBe("s2");
        expect(requests.elicitation("e1")?.key).toBe("2");
    });

    test("an unknown request gets -32601 instead of leaving the agent waiting", () => {
        const { requests, sent } = ledger();
        requests.receive({ id: 7, method: "fs/read_text_file", params: {} });
        expect(sent).toEqual([
            {
                id: 7,
                result: undefined,
                error: {
                    code: METHOD_NOT_FOUND,
                    message: "method not found: fs/read_text_file",
                },
            },
        ]);
        expect(requests.list()).toEqual([]);
    });

    test('9 and "9" are two different ids', () => {
        const { requests } = ledger();
        requests.receive(permission(9, "s", "a"));
        requests.receive(permission("9", "s", "b"));
        expect(requests.list()).toHaveLength(2);
    });

    test("a permission without sessionId throws instead of recording an ownerless entry", () => {
        const { requests } = ledger();
        expect(() =>
            requests.receive({
                id: 1,
                method: "session/request_permission",
                params: { subject: {} },
            }),
        ).toThrow("missing sessionId");
    });

    test("the batch the Runtime hands over on attach counts as just received", () => {
        const { requests } = ledger();
        requests.receiveAll([permission(1, "s", "a"), form(2, null)]);
        expect(requests.list()).toHaveLength(2);
        expect(requests.get("2")?.sessionId).toBeNull();
    });
});

describe("answering", () => {
    test("answers with the original id and leaves the book; a second answer sends nothing", () => {
        const { requests, sent } = ledger();
        requests.receive(permission("p-1", "s", "t"));
        expect(
            requests.answerPermission("t", {
                outcome: "selected",
                optionId: "yes",
            }),
        ).toBe(true);
        expect(sent).toEqual([
            {
                id: "p-1",
                result: { outcome: { outcome: "selected", optionId: "yes" } },
                error: undefined,
            },
        ]);
        expect(requests.answerPermission("t", { outcome: "cancelled" })).toBe(
            false,
        );
        expect(sent).toHaveLength(1);
    });

    test("_meta travels with the reply", () => {
        const { requests, sent } = ledger();
        requests.receive(permission(1, "s", "t"));
        requests.answerPermission(
            "t",
            { outcome: "cancelled" },
            { alwith: { reason: "x" } },
        );
        expect(sent[0]?.result).toEqual({
            outcome: { outcome: "cancelled" },
            _meta: { alwith: { reason: "x" } },
        });
    });

    test("elicitations are answered by key", () => {
        const { requests, sent } = ledger();
        requests.receive(form(5, "s", "e"));
        expect(
            requests.answer("5", { action: "accept", content: { a: 1 } }),
        ).toBe(true);
        expect(sent[0]).toEqual({
            id: 5,
            result: { action: "accept", content: { a: 1 } },
            error: undefined,
        });
    });

    test("a newly booked entry is notified on its own; answering is not notified", () => {
        const { requests } = ledger();
        const received: string[] = [];
        requests.onReceived((request) =>
            received.push(`${request.kind}:${request.key}`),
        );
        requests.receive(permission(1, "s", "t"));
        requests.receive(form(2, "s", "e"));
        requests.answerPermission("t", { outcome: "cancelled" });
        expect(received).toEqual(["permission:1", "elicitation:2"]);
    });

    test("every change to the book notifies once", () => {
        const { requests } = ledger();
        const seen: number[] = [];
        requests.onChange((pending) => seen.push(pending.length));
        requests.receive(permission(1, "s", "t"));
        requests.answerPermission("t", { outcome: "cancelled" });
        expect(seen).toEqual([1, 0]);
    });
});

describe("agent withdrawal and completion", () => {
    test("$/cancel_request: replies -32800, leaves the book and tells the app to close the dialog; an unknown id is a no-op", () => {
        const { requests, sent } = ledger();
        const withdrawn: string[] = [];
        requests.onWithdrawn((request) => withdrawn.push(request.key));
        requests.receive(permission(1, "s", "t"));
        requests.onNotification("$/cancel_request", { requestId: 1 });
        expect(sent).toEqual([
            {
                id: 1,
                result: undefined,
                error: {
                    code: REQUEST_CANCELLED,
                    message: "Request cancelled",
                },
            },
        ]);
        expect(withdrawn).toEqual(["1"]);
        expect(requests.list()).toEqual([]);
        requests.onNotification("$/cancel_request", { requestId: 404 });
        expect(sent).toHaveLength(1);
    });

    test("$/cancel_request without requestId throws; the protocol field is requestId, not id", () => {
        const { requests } = ledger();
        expect(() =>
            requests.onNotification("$/cancel_request", { id: 1 }),
        ).toThrow("missing requestId");
    });

    test("elicitation/complete: closes a still pending elicitation (cancel) and ignores answered ones", () => {
        const { requests, sent } = ledger();
        requests.receive(form(1, "s", "e-1"));
        requests.onNotification("elicitation/complete", {
            elicitationId: "e-1",
        });
        expect(sent).toEqual([
            { id: 1, result: { action: "cancel" }, error: undefined },
        ]);
        requests.onNotification("elicitation/complete", {
            elicitationId: "e-1",
        });
        expect(sent).toHaveLength(1);
    });
});

describe("Stop and release", () => {
    test("cancelSession: that session's permissions get cancelled and elicitations get cancel; other sessions are untouched", () => {
        const { requests, sent } = ledger();
        requests.receive(permission(1, "s1", "a"));
        requests.receive(form(2, "s1", "e"));
        requests.receive(permission(3, "s2", "b"));
        requests.cancelSession("s1");
        expect(sent).toEqual([
            {
                id: 1,
                result: { outcome: { outcome: "cancelled" } },
                error: undefined,
            },
            { id: 2, result: { action: "cancel" }, error: undefined },
        ]);
        expect(requests.list().map((r) => r.key)).toEqual(["3"]);
    });

    test("release: answers nothing and returns the released entries", () => {
        const { requests, sent } = ledger();
        requests.receive(permission(1, "s", "a"));
        requests.receive(form(2, null));
        const released = requests.release();
        expect(released.map((r) => r.key)).toEqual(["1", "2"]);
        expect(sent).toEqual([]);
        expect(requests.list()).toEqual([]);
    });
});
