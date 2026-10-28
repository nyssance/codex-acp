import { describe, expect, test } from "bun:test";

import { isText, textOf } from "../blocks";
import {
    addPrompt,
    applyUpdate,
    createSession,
    DISCONNECTED,
    INTERRUPTED,
    markDisconnected,
    terminalOf,
    type ToolItem,
} from "../session";
import { SessionStore } from "../store";

function text(session: ReturnType<typeof createSession>, index = 0): string {
    const item = session.items[index];
    if (
        !item ||
        (item.kind !== "assistant" &&
            item.kind !== "user" &&
            item.kind !== "thought")
    )
        return "";
    const block = item.content[0];
    return block !== undefined && isText(block) ? block.text : "";
}

describe("ACP transcript", () => {
    test("same item IDs remain isolated across interleaved sessions", () => {
        const store = new SessionStore();
        for (const id of ["a", "b"]) store.set(createSession(id, "/tmp"));
        for (const [id, value] of [
            ["a", "A"],
            ["b", "B"],
            ["a", "1"],
            ["b", "2"],
        ] as const) {
            store.accept(id, {
                sessionUpdate: "agent_message_chunk",
                messageId: "same",
                content: { type: "text", text: value },
            });
        }
        expect(text(store.get("a"))).toBe("A1");
        expect(text(store.get("b"))).toBe("B2");
        store.accept("a", {
            sessionUpdate: "state_update",
            state: "requires_action",
        });
        expect(store.get("b").state).toBe("idle");
    });

    test("a full agent_message replaces accumulated chunks and later chunks append", () => {
        let session = createSession("a", "/tmp");
        session = applyUpdate(session, {
            sessionUpdate: "agent_message_chunk",
            messageId: "m",
            content: { type: "text", text: "par" },
        });
        session = applyUpdate(session, {
            sessionUpdate: "agent_message",
            messageId: "m",
            content: [{ type: "text", text: "partial" }],
        });
        session = applyUpdate(session, {
            sessionUpdate: "agent_message_chunk",
            messageId: "m",
            content: { type: "text", text: "!" },
        });
        expect(session.items).toHaveLength(1);
        expect(text(session)).toBe("partial!");
    });

    test("updates never mutate the previous session object", () => {
        const before = createSession("a", "/tmp");
        const after = applyUpdate(before, {
            sessionUpdate: "agent_message_chunk",
            messageId: "m",
            content: { type: "text", text: "x" },
        });
        expect(before.items).toHaveLength(0);
        expect(after.items).toHaveLength(1);
        expect(after).not.toBe(before);
    });

    test("tool upserts keep omitted fields and clear explicit nulls", () => {
        let session = createSession("a", "/tmp");
        session = applyUpdate(session, {
            sessionUpdate: "tool_call_update",
            toolCallId: "t",
            name: "shell",
            title: "ls -la",
            kind: "execute",
            status: "in_progress",
            rawInput: { command: "ls" },
        });
        session = applyUpdate(session, {
            sessionUpdate: "tool_call_update",
            toolCallId: "t",
            status: "completed",
            rawOutput: "ok",
        });
        const tool = session.items[0];
        if (tool?.kind !== "tool") throw new Error("expected a tool item");
        expect(tool.title).toBe("ls -la");
        expect(tool.status).toBe("completed");
        expect(tool.rawInput).toEqual({ command: "ls" });
        expect(tool.rawOutput).toBe("ok");
        session = applyUpdate(session, {
            sessionUpdate: "tool_call_update",
            toolCallId: "t",
            title: null,
        });
        expect((session.items[0] as typeof tool).title).toBeNull();
    });

    test("a failed turn keeps stopReason and the raw _meta until the next turn starts", () => {
        let session = createSession("a", "/tmp");
        session = applyUpdate(session, {
            sessionUpdate: "state_update",
            state: "idle",
            stopReason: "_error",
            _meta: {
                codex: {
                    error: {
                        message: "boom",
                        category: "network",
                        retryable: true,
                    },
                },
            },
        });
        // The package states only what the protocol knows: this turn ended with `_error`, and `_meta` is passed through as is.
        // "boom / network / retryable" is Codex's dialect; the app reads it itself.
        expect(session.error).toEqual({
            stopReason: "_error",
            error: null,
            meta: {
                codex: {
                    error: {
                        message: "boom",
                        category: "network",
                        retryable: true,
                    },
                },
            },
        });
        session = applyUpdate(session, {
            sessionUpdate: "state_update",
            state: "running",
        });
        expect(session.error).toBeNull();
    });

    test("plans upsert by id and can be removed", () => {
        let session = createSession("a", "/tmp");
        session = applyUpdate(session, {
            sessionUpdate: "plan_update",
            plan: {
                type: "items",
                planId: "p",
                entries: [
                    { content: "step", priority: "medium", status: "pending" },
                ],
            },
        });
        session = applyUpdate(session, {
            sessionUpdate: "plan_update",
            plan: {
                type: "items",
                planId: "p",
                entries: [
                    {
                        content: "step",
                        priority: "medium",
                        status: "completed",
                    },
                ],
            },
        });
        expect(session.items).toHaveLength(1);
        session = applyUpdate(session, {
            sessionUpdate: "plan_removed",
            planId: "p",
        });
        expect(session.items).toHaveLength(0);
    });
});

describe("chunks without a messageId", () => {
    test("adjacent messages of the same kind merge; anything in between starts a new item, so later text never jumps ahead of a tool", () => {
        let session = createSession("s", "/tmp");
        const feed = (update: Record<string, unknown>) =>
            (session = applyUpdate(session, update as never));
        feed({
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "先读" },
        });
        feed({
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "文件" },
        });
        feed({
            sessionUpdate: "tool_call_update",
            toolCallId: "t",
            name: "Read",
            status: "completed",
        });
        feed({
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "再搜" },
        });
        feed({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "完成" },
        });
        const shape = session.items.map((item) =>
            item.kind === "user" ||
            item.kind === "assistant" ||
            item.kind === "thought"
                ? `${item.kind}:${textOf(item.content)}`
                : item.kind,
        );
        expect(shape).toEqual([
            "thought:先读文件",
            "tool",
            "thought:再搜",
            "assistant:完成",
        ]);
    });

    test("does not merge into the locally shown user message", () => {
        let session = addPrompt(
            createSession("s", "/tmp"),
            [{ type: "text", text: "hi" }],
            "local",
        );
        session = applyUpdate(session, {
            sessionUpdate: "user_message_chunk",
            content: { type: "text", text: "x" },
        } as never);
        expect(session.items).toHaveLength(2);
        expect(session.items[0]?.id).toBe("local");
    });
});

describe("tool terminals", () => {
    test("found through the terminal reference in the output, never guessed from the tool id", () => {
        let session = createSession("s", "/tmp");
        const feed = (update: Record<string, unknown>) =>
            (session = applyUpdate(session, update as never));
        feed({
            sessionUpdate: "tool_call_update",
            toolCallId: "call-1",
            name: "Bash",
            content: [{ type: "terminal", terminalId: "term-9" }],
        });
        feed({
            sessionUpdate: "terminal_update",
            terminalId: "term-9",
            command: "ls",
        });
        feed({
            sessionUpdate: "terminal_update",
            terminalId: "call-1",
            command: "decoy",
        });
        const tool = session.items.find((item) => item.kind === "tool");
        expect(
            tool?.kind === "tool"
                ? terminalOf(tool, session.terminals)?.command
                : null,
        ).toBe("ls");
    });

    test("null when there is no reference or the referenced terminal has not arrived", () => {
        let session = createSession("s", "/tmp");
        session = applyUpdate(session, {
            sessionUpdate: "tool_call_update",
            toolCallId: "call-1",
            name: "Read",
        } as never);
        const tool = session.items[0];
        expect(
            tool?.kind === "tool"
                ? terminalOf(tool, session.terminals)
                : undefined,
        ).toBeNull();
    });
});

describe("ACP alpha.8", () => {
    test("standard error retains JSON-RPC details and clears on running", () => {
        const error = {
            code: -32603,
            message: "Provider failed",
            data: { retryable: true },
        };
        const failed = applyUpdate(createSession("s", "/tmp"), {
            sessionUpdate: "state_update",
            state: "idle",
            stopReason: "error",
            error,
        });
        expect(failed.error).toEqual({
            stopReason: "error",
            error,
            meta: null,
        });
        expect(
            applyUpdate(failed, {
                sessionUpdate: "state_update",
                state: "running",
            }).error,
        ).toBeNull();
    });
    test("request limits fail while an absent stop reason stays unknown", () => {
        const session = createSession("s", "/tmp");
        expect(
            applyUpdate(session, {
                sessionUpdate: "state_update",
                state: "idle",
                stopReason: "max_turn_requests",
            }).error?.stopReason,
        ).toBe("max_turn_requests");
        expect(
            applyUpdate(session, {
                sessionUpdate: "state_update",
                state: "idle",
            }).lastStopReason,
        ).toBeNull();
    });
    test("message identity includes the message type", () => {
        let session = createSession("s", "/tmp");
        session = applyUpdate(session, {
            sessionUpdate: "user_message",
            messageId: "same",
            content: [{ type: "text", text: "user" }],
        });
        session = applyUpdate(session, {
            sessionUpdate: "agent_message_chunk",
            messageId: "same",
            content: { type: "text", text: "answer" },
        });
        session = applyUpdate(session, {
            sessionUpdate: "agent_thought_chunk",
            messageId: "same",
            content: { type: "text", text: "thought" },
        });
        expect(session.items.map((item) => [item.kind, item.id])).toEqual([
            ["user", "same"],
            ["assistant", "same"],
            ["thought", "same"],
        ]);
        expect([0, 1, 2].map((index) => text(session, index))).toEqual([
            "user",
            "answer",
            "thought",
        ]);
    });
    test("summary-first compaction preserves position, chunks, patch omission and explicit clears", () => {
        let session = createSession("s", "/tmp");
        session = applyUpdate(session, {
            sessionUpdate: "compaction_summary_chunk",
            compactionId: "c",
            content: { type: "text", text: "first" },
        });
        const first = session;
        session = applyUpdate(session, {
            sessionUpdate: "agent_message_chunk",
            messageId: "m",
            content: { type: "text", text: "after" },
        });
        session = applyUpdate(session, {
            sessionUpdate: "compaction_summary_chunk",
            compactionId: "c",
            content: { type: "text", text: "second" },
        });
        session = applyUpdate(session, {
            sessionUpdate: "compaction_update",
            compactionId: "c",
            status: "failed",
            error: "failure",
            _meta: { source: "agent" },
        });
        session = applyUpdate(session, {
            sessionUpdate: "compaction_update",
            compactionId: "c",
            status: "completed",
        });
        expect(session.items[0]).toMatchObject({
            kind: "compaction",
            at: first.items[0].at,
            summary: [
                { type: "text", text: "first" },
                { type: "text", text: "second" },
            ],
            error: "failure",
            _meta: { source: "agent" },
        });
        expect(first.items[0]).toMatchObject({
            status: "in_progress",
            summary: [{ type: "text", text: "first" }],
            error: null,
        });
        session = applyUpdate(session, {
            sessionUpdate: "compaction_update",
            compactionId: "c",
            status: "completed",
            summary: [{ type: "text", text: "replacement" }],
            error: null,
            _meta: null,
        });
        expect(session.items[0]).toMatchObject({
            summary: [{ type: "text", text: "replacement" }],
            error: null,
            _meta: null,
        });
        session = applyUpdate(session, {
            sessionUpdate: "compaction_update",
            compactionId: "c",
            status: "completed",
            summary: null,
        });
        expect(session.items[0]).toMatchObject({ summary: [] });
    });
});

describe("markDisconnected", () => {
    test("a running turn is recorded as disconnected; an idle session only loses its attachment", () => {
        let session = createSession("s", "/tmp");
        session = applyUpdate(session, {
            sessionUpdate: "state_update",
            state: "running",
        } as never);
        const lost = markDisconnected(session);
        expect(lost.state).toBe("idle");
        expect(lost.attached).toBe(false);
        expect(lost.error).toEqual({
            stopReason: DISCONNECTED,
            error: null,
            meta: null,
        });
        const idle = markDisconnected({
            ...createSession("t", "/tmp"),
            attached: true,
        });
        expect(idle.error).toBeNull();
        expect(idle.attached).toBe(false);
    });
});

describe("markTerminated", () => {
    test("a writer instance's termination interrupts the tools it left running and the turn it never closed, up to its final seq", () => {
        let session = createSession("s", "/tmp");
        const frame = (update: Record<string, unknown>) => {
            session = applyUpdate(session, update as never);
        };
        frame({
            sessionUpdate: "user_message",
            messageId: "u1",
            content: [{ type: "text", text: "q" }],
            _meta: { alwith: { seq: 0 } },
        });
        frame({ sessionUpdate: "state_update", state: "running" });
        frame({
            sessionUpdate: "tool_call_update",
            toolCallId: "t1",
            name: "Bash",
            status: "in_progress",
            _meta: { alwith: { seq: 1 } },
        });
        frame({
            sessionUpdate: "tool_call_update",
            toolCallId: "t2",
            name: "Read",
            status: "completed",
            _meta: { alwith: { seq: 2 } },
        });
        frame({
            sessionUpdate: "session_info_update",
            _meta: {
                alwith: {
                    seq: 3,
                    instanceTerminated: { instanceId: "i-1", finalSeq: 2 },
                },
            },
        });
        const tools = session.items.filter((item) => item.kind === "tool");
        expect(tools.map((tool) => [tool.id, tool.status])).toEqual([
            ["t1", INTERRUPTED],
            ["t2", "completed"],
        ]);
        expect(session.state).toBe("idle");
        expect(session.error).toEqual({
            stopReason: INTERRUPTED,
            error: null,
            meta: {
                alwith: {
                    instanceTerminated: { instanceId: "i-1", finalSeq: 2 },
                },
            },
        });
        expect("u1" in session.turnEndedAt).toBe(true);
        expect(session.appliedThrough).toBe(3);
        // A successor's work after the final seq is untouched by an earlier instance's termination.
        frame({
            sessionUpdate: "user_message",
            messageId: "u2",
            content: [{ type: "text", text: "again" }],
            _meta: { alwith: { seq: 4 } },
        });
        frame({
            sessionUpdate: "tool_call_update",
            toolCallId: "t3",
            name: "Bash",
            status: "in_progress",
            _meta: { alwith: { seq: 5 } },
        });
        frame({
            sessionUpdate: "session_info_update",
            _meta: {
                alwith: {
                    seq: 6,
                    instanceTerminated: { instanceId: "i-0", finalSeq: 2 },
                },
            },
        });
        expect(
            (session.items.find((item) => item.id === "t3") as ToolItem).status,
        ).toBe("in_progress");
        expect("u2" in session.turnEndedAt).toBe(false);
    });
});
