import { describe, expect, test } from "bun:test";

import {
    applyUpdate,
    createSession,
    type FoldPolicy,
    INTERRUPTED,
    markInterrupted,
    type ToolItem,
} from "../session";
import { SessionStore } from "../store";

function tool(session: ReturnType<typeof createSession>, id: string): ToolItem {
    const item = session.items.find(
        (entry) => entry.kind === "tool" && entry.id === id,
    );
    if (item?.kind !== "tool") throw new Error(`no tool ${id}`);
    return item;
}

function startTool(
    session: ReturnType<typeof createSession>,
    id: string,
    extra: Record<string, unknown> = {},
    policy?: FoldPolicy,
) {
    return applyUpdate(
        session,
        {
            sessionUpdate: "tool_call_update",
            toolCallId: id,
            status: "in_progress",
            ...extra,
        } as never,
        { policy },
    );
}

function idle(session: ReturnType<typeof createSession>, policy?: FoldPolicy) {
    return applyUpdate(
        session,
        {
            sessionUpdate: "state_update",
            state: "idle",
            stopReason: "end_turn",
        } as never,
        {
            policy,
        },
    );
}

/** alwith-cli's rule: background runs are marked in `_meta.alwith.runInBackground`; Monitor can only be recognised by tool name. */
const alwith: FoldPolicy = {
    outlivesTurn: (entry) => {
        const meta = entry._meta?.alwith;
        const background =
            typeof meta === "object" &&
            meta !== null &&
            (meta as { runInBackground?: unknown }).runInBackground === true;
        return background || entry.name === "Monitor";
    },
};

describe("turn sealing", () => {
    test("tools still open when the turn ends become completed; the protocol does not guarantee a final frame for every tool", () => {
        let session = createSession("s", "/tmp");
        session = startTool(session, "t1");
        expect(tool(session, "t1").status).toBe("in_progress");

        session = idle(session);
        expect(tool(session, "t1").status).toBe("completed");
    });

    test("tools that already reached a final state are not rewritten", () => {
        let session = createSession("s", "/tmp");
        session = startTool(session, "t1", { status: "failed" });
        session = idle(session);
        expect(tool(session, "t1").status).toBe("failed");
    });

    test("tools that outlive the turn are not sealed at the turn boundary; sealing them would hide the real result forever", () => {
        let session = createSession("s", "/tmp");
        session = startTool(
            session,
            "bg",
            { _meta: { alwith: { runInBackground: true } } },
            alwith,
        );
        session = startTool(session, "watch", { name: "Monitor" }, alwith);
        session = startTool(session, "plain", {}, alwith);

        session = idle(session, alwith);

        expect(tool(session, "bg").status).toBe("in_progress");
        expect(tool(session, "watch").status).toBe("in_progress");
        expect(tool(session, "plain").status).toBe("completed");
    });

    test("without a rule all tools are treated alike; the package does not guess dialects", () => {
        let session = createSession("s", "/tmp");
        session = startTool(session, "bg", {
            _meta: { alwith: { runInBackground: true } },
        });
        session = idle(session);
        expect(tool(session, "bg").status).toBe("completed");
    });
});

describe("reaping at load", () => {
    test("without a live process, dangling turn-outliving tools become interrupted", () => {
        let session = createSession("s", "/tmp");
        session = startTool(
            session,
            "bg",
            { _meta: { alwith: { runInBackground: true } } },
            alwith,
        );
        session = startTool(session, "done", { status: "completed" }, alwith);

        session = markInterrupted(session, alwith);

        expect(tool(session, "bg").status).toBe(INTERRUPTED);
        expect(tool(session, "done").status).toBe("completed");
    });

    test("ordinary tools are not its concern; they were already sealed at the turn boundary", () => {
        let session = createSession("s", "/tmp");
        session = startTool(session, "plain", {}, alwith);
        const next = markInterrupted(session, alwith);
        expect(next).toBe(session);
    });

    test("returns the same object when nothing changed, so the renderer need not redraw", () => {
        const session = createSession("s", "/tmp");
        expect(markInterrupted(session, alwith)).toBe(session);
    });
});

describe("SessionStore carries the rule", () => {
    test("accept folds with the store's rule, and markInterrupted reports whether anything changed", () => {
        const store = new SessionStore(alwith);
        store.set(createSession("s", "/tmp"));
        store.accept("s", {
            sessionUpdate: "tool_call_update",
            toolCallId: "bg",
            status: "in_progress",
            _meta: { alwith: { runInBackground: true } },
        } as never);
        store.accept("s", {
            sessionUpdate: "state_update",
            state: "idle",
            stopReason: "end_turn",
        } as never);
        expect(tool(store.get("s"), "bg").status).toBe("in_progress");

        expect(store.markInterrupted("s")).toBe(true);
        expect(tool(store.get("s"), "bg").status).toBe(INTERRUPTED);
        expect(store.markInterrupted("s")).toBe(false);
    });
});

describe("tool output as delta or full", () => {
    const output = (text: string) => [
        { type: "content", content: { type: "text", text } },
    ];
    const push = (
        session: ReturnType<typeof createSession>,
        text: string,
        policy?: FoldPolicy,
    ) =>
        applyUpdate(
            session,
            {
                sessionUpdate: "tool_call_update",
                toolCallId: "t1",
                content: output(text),
            } as never,
            {
                policy,
            },
        );

    test("full by default: a later frame replaces the earlier one, with the same replacement semantics as name and similar fields", () => {
        let session = createSession("s", "/tmp");
        session = push(session, "第一行");
        session = push(session, "第二行");
        expect(tool(session, "t1").content).toEqual(output("第二行") as never);
    });

    test("declared deltas append; alwith-cli sends only the new part per frame, so replacing would leave only the last line", () => {
        const appending: FoldPolicy = { toolContent: "append" };
        let session = createSession("s", "/tmp");
        session = push(session, "第一行", appending);
        session = push(session, "第二行", appending);
        expect(tool(session, "t1").content).toEqual([
            ...output("第一行"),
            ...output("第二行"),
        ] as never);
    });

    test("in delta mode an empty array means no new output, not a clear", () => {
        const appending: FoldPolicy = { toolContent: "append" };
        let session = createSession("s", "/tmp");
        session = push(session, "第一行", appending);
        session = applyUpdate(
            session,
            {
                sessionUpdate: "tool_call_update",
                toolCallId: "t1",
                content: [],
            } as never,
            {
                policy: appending,
            },
        );
        expect(tool(session, "t1").content).toEqual(output("第一行") as never);
    });

    test("in both modes explicit null clears and an omitted field is left alone", () => {
        for (const policy of [{}, { toolContent: "append" as const }]) {
            let session = createSession("s", "/tmp");
            session = push(session, "第一行", policy);
            session = applyUpdate(
                session,
                {
                    sessionUpdate: "tool_call_update",
                    toolCallId: "t1",
                    status: "completed",
                } as never,
                { policy },
            );
            expect(tool(session, "t1").content).toEqual(
                output("第一行") as never,
            );
            session = applyUpdate(
                session,
                {
                    sessionUpdate: "tool_call_update",
                    toolCallId: "t1",
                    content: null,
                } as never,
                {
                    policy,
                },
            );
            expect(tool(session, "t1").content).toEqual([]);
        }
    });
});

/** alwith-cli's parentage rule. */
const alwithWithParents: FoldPolicy = {
    ...alwith,
    parentOf: (entry) => {
        const meta = entry._meta?.claudeCode;
        const parent =
            typeof meta === "object" && meta !== null
                ? (meta as { parentToolUseId?: unknown }).parentToolUseId
                : null;
        return typeof parent === "string" ? parent : null;
    },
};

describe("outliving the turn is inherited along the parent chain", () => {
    const background = { _meta: { alwith: { runInBackground: true } } };
    const childOf = (parent: string) => ({
        _meta: { claudeCode: { parentToolUseId: parent } },
    });

    test("steps launched by a background subagent live and die with it: not sealed at the turn boundary", () => {
        let session = startTool(
            createSession("s", "/tmp"),
            "agent",
            { name: "Agent", ...background },
            alwithWithParents,
        );
        session = startTool(
            session,
            "step",
            { name: "Read", ...childOf("agent") },
            alwithWithParents,
        );
        session = idle(session, alwithWithParents);
        expect(tool(session, "agent").status).toBe("in_progress");
        expect(tool(session, "step").status).toBe("in_progress");
    });

    test("reaped together with it, grandchildren included", () => {
        let session = startTool(
            createSession("s", "/tmp"),
            "agent",
            { name: "Agent", ...background },
            alwithWithParents,
        );
        session = startTool(
            session,
            "step",
            { name: "Agent", ...childOf("agent") },
            alwithWithParents,
        );
        session = startTool(
            session,
            "leaf",
            { name: "Read", ...childOf("step") },
            alwithWithParents,
        );
        session = markInterrupted(session, alwithWithParents);
        expect(tool(session, "agent").status).toBe(INTERRUPTED);
        expect(tool(session, "step").status).toBe(INTERRUPTED);
        expect(tool(session, "leaf").status).toBe(INTERRUPTED);
    });

    test("steps of a foreground subagent are sealed at the turn boundary as usual", () => {
        let session = startTool(
            createSession("s", "/tmp"),
            "agent",
            { name: "Agent" },
            alwithWithParents,
        );
        session = startTool(
            session,
            "step",
            { name: "Read", ...childOf("agent") },
            alwithWithParents,
        );
        session = idle(session, alwithWithParents);
        expect(tool(session, "step").status).toBe("completed");
    });

    test("a parentage cycle does not loop forever", () => {
        let session = startTool(
            createSession("s", "/tmp"),
            "a",
            { name: "X", ...childOf("b") },
            alwithWithParents,
        );
        session = startTool(
            session,
            "b",
            { name: "Y", ...childOf("a") },
            alwithWithParents,
        );
        expect(() => idle(session, alwithWithParents)).not.toThrow();
    });
});

describe("a turn-outliving tool takes its status only from frames that also declare outliving the turn", () => {
    const flagged = { _meta: { alwith: { runInBackground: true } } };

    test('the unmarked completed within the turn only means "sent to the background" and is not final', () => {
        let session = startTool(
            createSession("s", "/tmp"),
            "bg",
            { name: "Bash", ...flagged },
            alwith,
        );
        session = applyUpdate(
            session,
            {
                sessionUpdate: "tool_call_update",
                toolCallId: "bg",
                status: "completed",
            } as never,
            { policy: alwith },
        );
        expect(tool(session, "bg").status).toBe("in_progress");
        expect(tool(session, "bg").endedAt).toBeNull();
    });

    test("the marked frame after the turn is the real final state, failed included", () => {
        let session = startTool(
            createSession("s", "/tmp"),
            "bg",
            { name: "Bash", ...flagged },
            alwith,
        );
        session = idle(session, alwith);
        session = applyUpdate(
            session,
            {
                sessionUpdate: "tool_call_update",
                toolCallId: "bg",
                status: "failed",
                ...flagged,
            } as never,
            { policy: alwith },
        );
        expect(tool(session, "bg").status).toBe("failed");
        expect(tool(session, "bg").endedAt).not.toBeNull();
    });

    test("Monitor is recognised by name; every frame of it counts as declared, so its status updates as usual", () => {
        let session = startTool(
            createSession("s", "/tmp"),
            "m",
            { name: "Monitor" },
            alwith,
        );
        session = applyUpdate(
            session,
            {
                sessionUpdate: "tool_call_update",
                toolCallId: "m",
                status: "failed",
            } as never,
            {
                policy: alwith,
            },
        );
        expect(tool(session, "m").status).toBe("failed");
    });

    test("other fields (output, title) are unaffected by this rule and are taken as usual", () => {
        let session = startTool(
            createSession("s", "/tmp"),
            "bg",
            { name: "Bash", ...flagged },
            alwith,
        );
        session = applyUpdate(
            session,
            {
                sessionUpdate: "tool_call_update",
                toolCallId: "bg",
                status: "completed",
                title: "launched",
                content: [
                    {
                        type: "content",
                        content: { type: "text", text: "pid 42" },
                    },
                ],
            } as never,
            { policy: alwith },
        );
        expect(tool(session, "bg").status).toBe("in_progress");
        expect(tool(session, "bg").title).toBe("launched");
        expect(tool(session, "bg").content).toHaveLength(1);
    });
});

describe("end time", () => {
    test("endedAt is stamped when a tool reaches a final state, including tools sealed at the turn boundary", () => {
        let session = startTool(createSession("s", "/tmp"), "a");
        session = startTool(session, "b");
        expect(tool(session, "a").endedAt).toBeNull();
        session = applyUpdate(session, {
            sessionUpdate: "tool_call_update",
            toolCallId: "a",
            status: "completed",
        } as never);
        expect(tool(session, "a").endedAt).not.toBeNull();
        session = idle(session);
        expect(tool(session, "b").endedAt).not.toBeNull();
    });

    test("a tool that already has endedAt keeps it when another final frame arrives", () => {
        let session = startTool(createSession("s", "/tmp"), "a");
        session = applyUpdate(session, {
            sessionUpdate: "tool_call_update",
            toolCallId: "a",
            status: "completed",
        } as never);
        const first = tool(session, "a").endedAt;
        session = applyUpdate(session, {
            sessionUpdate: "tool_call_update",
            toolCallId: "a",
            status: "completed",
        } as never);
        expect(tool(session, "a").endedAt).toBe(first);
    });

    test("at turn end the time is recorded against the user message that started the turn and is readable in turns()", () => {
        const store = new SessionStore();
        store.set(createSession("s", "/tmp"));
        const localId = store.addPrompt("s", [{ type: "text", text: "go" }]);
        store.acknowledgePrompt("s", localId, "user");
        store.accept("s", {
            sessionUpdate: "user_message",
            messageId: "user",
            content: [],
        } as never);
        store.accept("s", {
            sessionUpdate: "agent_message_chunk",
            messageId: "a",
            content: { type: "text", text: "ok" },
        } as never);
        expect(store.turns("s")[0]?.endedAt).toBeNull();
        store.accept("s", {
            sessionUpdate: "state_update",
            state: "idle",
            stopReason: "end_turn",
        } as never);
        const [turn] = store.turns("s");
        expect(turn?.startedAt).not.toBeNull();
        expect(turn?.endedAt).not.toBeNull();
        expect(turn.endedAt!).toBeGreaterThanOrEqual(turn.startedAt!);
    });

    test("a replay from the start clears the previous run's turn times together with usage", () => {
        const store = new SessionStore();
        store.set(createSession("s", "/tmp"));
        const localId = store.addPrompt("s", [{ type: "text", text: "go" }]);
        store.acknowledgePrompt("s", localId, "user");
        store.accept("s", {
            sessionUpdate: "user_message",
            messageId: "user",
            content: [],
        } as never);
        store.accept("s", {
            sessionUpdate: "state_update",
            state: "idle",
            stopReason: "end_turn",
        } as never);
        store.beginReplay("s");
        expect(store.get("s").turnEndedAt).toEqual({});
        expect(store.get("s").turnUsage).toEqual({});
    });
});

describe("times strictly increase", () => {
    test("events in the same millisecond are still ordered: items before the end < end time < items after", () => {
        const store = new SessionStore();
        store.set(createSession("s", "/tmp"));
        const localId = store.addPrompt("s", [{ type: "text", text: "go" }]);
        store.acknowledgePrompt("s", localId, "user");
        store.accept("s", {
            sessionUpdate: "user_message",
            messageId: "user",
            content: [],
        } as never);
        store.accept("s", {
            sessionUpdate: "agent_message_chunk",
            messageId: "a",
            content: { type: "text", text: "1" },
        } as never);
        store.accept("s", {
            sessionUpdate: "state_update",
            state: "idle",
            stopReason: "end_turn",
        } as never);
        store.accept("s", {
            sessionUpdate: "agent_message_chunk",
            messageId: "b",
            content: { type: "text", text: "2" },
        } as never);
        const [turn] = store.turns("s");
        const [before, after] = turn.entries;
        expect(before.at).toBeLessThan(turn.endedAt!);
        expect(after.at).toBeGreaterThan(turn.endedAt!);
    });

    test("a tool's final time is not earlier than its arrival, and later items are not earlier than it", () => {
        let session = startTool(createSession("s", "/tmp"), "a");
        session = applyUpdate(session, {
            sessionUpdate: "tool_call_update",
            toolCallId: "a",
            status: "completed",
        } as never);
        session = startTool(session, "b");
        expect(tool(session, "a").endedAt!).toBeGreaterThan(
            tool(session, "a").at,
        );
        expect(tool(session, "b").at).toBeGreaterThan(
            tool(session, "a").endedAt!,
        );
    });
});

describe("the end time is recorded only once", () => {
    test("when the agent's own idle follows a user Stop, the turn still ends at the moment the user stopped", () => {
        const store = new SessionStore();
        store.set(createSession("s", "/tmp"));
        const localId = store.addPrompt("s", [{ type: "text", text: "go" }]);
        store.acknowledgePrompt("s", localId, "user");
        store.accept("s", {
            sessionUpdate: "user_message",
            messageId: "user",
            content: [],
        } as never);
        store.accept("s", {
            sessionUpdate: "state_update",
            state: "idle",
            stopReason: "cancelled",
        } as never);
        const first = store.turns("s")[0].endedAt;
        store.accept("s", {
            sessionUpdate: "state_update",
            state: "idle",
            stopReason: "end_turn",
        } as never);
        expect(store.turns("s")[0].endedAt).toBe(first);
    });
});
