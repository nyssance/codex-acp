import { describe, expect, test } from "bun:test";

import type * as acp from "@agentclientprotocol/sdk/experimental/v2/unstable";

import {
    replayCursorFor,
    replayIdOf,
    replayReceiptOf,
    supportsSeqCursor,
} from "../replay";
import { applyUpdate, createSession } from "../session";
import { SessionStore } from "../store";

const agent = (cursor?: string): acp.InitializeResponse => ({
    protocolVersion: 2,
    info: { name: "alwith-cli", version: "2.9.75" },
    capabilities: cursor
        ? { _meta: { alwith: { replay: { version: 1, cursor } } } }
        : {},
});

describe("record position", () => {
    test("appliedThrough follows the largest _meta.alwith.seq any frame carried and never goes back", () => {
        let session = createSession("s", "/tmp");
        expect(session.appliedThrough).toBe(-1);
        session = applyUpdate(session, {
            sessionUpdate: "user_message",
            messageId: "u",
            content: [{ type: "text", text: "q" }],
            _meta: { alwith: { seq: 4 } },
        });
        session = applyUpdate(session, {
            sessionUpdate: "tool_call_update",
            toolCallId: "t",
            status: "completed",
            _meta: { alwith: { seq: 2 } },
        });
        expect(session.appliedThrough).toBe(4);
        session = applyUpdate(session, {
            sessionUpdate: "agent_message_chunk",
            messageId: "m",
            content: { type: "text", text: "a" },
        });
        expect(session.appliedThrough).toBe(4);
    });

    test("the cursor continues from the record position only when the agent can and the session holds something", () => {
        let session = createSession("s", "/tmp");
        expect(replayCursorFor(agent("_alwith/seq"), session)).toEqual({
            type: "start",
        });
        session = applyUpdate(session, {
            sessionUpdate: "user_message",
            messageId: "u",
            content: [{ type: "text", text: "q" }],
            _meta: { alwith: { seq: 7 } },
        });
        expect(replayCursorFor(agent("_alwith/seq"), session)).toEqual({
            type: "_alwith/seq",
            after: 7,
        });
        expect(replayCursorFor(agent(), session)).toEqual({ type: "start" });
        expect(supportsSeqCursor(agent("_other"))).toBe(false);
    });

    test("a partial replay keeps what the session holds; a replay from the start empties it; the receipt moves the position to the cut", () => {
        const store = new SessionStore();
        store.set(createSession("s", "/tmp"));
        store.accept("s", {
            sessionUpdate: "user_message",
            messageId: "u",
            content: [{ type: "text", text: "q" }],
            _meta: { alwith: { seq: 3 } },
        });
        store.beginReplay("s", 3);
        expect(store.get("s").items).toHaveLength(1);
        expect(store.get("s").restoring).toBe(true);
        store.accept("s", {
            sessionUpdate: "agent_message_chunk",
            messageId: "m",
            content: { type: "text", text: "late" },
            _meta: { alwith: { seq: 5 }, replay: { id: "r1" } },
        });
        store.endReplay("s", { replayId: "r1", after: 3, cut: 9 });
        const caughtUp = store.get("s");
        expect(caughtUp.items.map((item) => item.id)).toEqual(["u", "m"]);
        expect(caughtUp.items[1]?.replayed).toBe(true);
        expect(caughtUp.appliedThrough).toBe(9);
        expect(caughtUp.restoring).toBe(false);
        expect(caughtUp.attached).toBe(true);
        store.beginReplay("s", "start");
        expect(store.get("s").items).toEqual([]);
        expect(store.get("s").appliedThrough).toBe(-1);
        store.endReplay("s", null);
        expect(store.get("s").appliedThrough).toBe(-1);
    });

    test("the receipt is read from the resume response and a frame names its replay", () => {
        expect(replayReceiptOf({})).toBeNull();
        expect(
            replayReceiptOf({
                _meta: {
                    alwith: { replay: { replayId: "r", after: -1, cut: 12 } },
                },
            }),
        ).toEqual({
            replayId: "r",
            after: -1,
            cut: 12,
        });
        expect(() =>
            replayReceiptOf({
                _meta: { alwith: { replay: { replayId: "r" } } },
            }),
        ).toThrow("malformed replay receipt");
        expect(
            replayIdOf({
                sessionUpdate: "plan_update",
                plan: { type: "items", planId: "p", entries: [] },
                _meta: { replay: { id: "r" } },
            }),
        ).toBe("r");
        expect(
            replayIdOf({
                sessionUpdate: "plan_update",
                plan: { type: "items", planId: "p", entries: [] },
            }),
        ).toBeNull();
    });
});
