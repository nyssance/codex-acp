import { describe, expect, test } from "bun:test";

import {
    acknowledgePrompt,
    addPrompt,
    applyUpdate,
    createSession,
    type MessageItem,
    type ToolItem,
} from "../session";
import { SessionStore } from "../store";

function apply(
    session: ReturnType<typeof createSession>,
    update: Record<string, unknown>,
) {
    return applyUpdate(session, update as never);
}

function item<T extends MessageItem | ToolItem>(
    session: ReturnType<typeof createSession>,
    id: string,
): T {
    const found = session.items.find((entry) => entry.id === id);
    if (!found) throw new Error(`no item ${id}`);
    return found as T;
}

describe("_meta follows the ACP v2 patch rule", () => {
    test("an object patches by top-level key: an omitted key is unchanged, a present key is replaced whole, nested objects are not merged", () => {
        let session = createSession("s", "/tmp");
        session = apply(session, {
            sessionUpdate: "tool_call_update",
            toolCallId: "t",
            name: "Bash",
            status: "pending",
            _meta: {
                alwith: { runInBackground: true },
                claudeCode: { toolName: "Bash" },
            },
        });
        session = apply(session, {
            sessionUpdate: "tool_call_update",
            toolCallId: "t",
            _meta: { alwith: { terminalDisplay: { command: "sleep 5" } } },
        });
        expect(item<ToolItem>(session, "t")._meta).toEqual({
            alwith: { terminalDisplay: { command: "sleep 5" } },
            claudeCode: { toolName: "Bash" },
        });
    });

    test("a key set to null is removed; omitted _meta keeps everything; a whole null clears everything", () => {
        let session = createSession("s", "/tmp");
        session = apply(session, {
            sessionUpdate: "tool_call_update",
            toolCallId: "t",
            name: "Read",
            _meta: {
                alwith: { tags: ["a"], n: 1 },
                claudeCode: { toolName: "Read" },
            },
        });
        session = apply(session, {
            sessionUpdate: "tool_call_update",
            toolCallId: "t",
            status: "in_progress",
        });
        expect(item<ToolItem>(session, "t")._meta).toEqual({
            alwith: { tags: ["a"], n: 1 },
            claudeCode: { toolName: "Read" },
        });
        session = apply(session, {
            sessionUpdate: "tool_call_update",
            toolCallId: "t",
            _meta: { claudeCode: null },
        });
        expect(item<ToolItem>(session, "t")._meta).toEqual({
            alwith: { tags: ["a"], n: 1 },
        });
        session = apply(session, {
            sessionUpdate: "tool_call_update",
            toolCallId: "t",
            _meta: { alwith: null },
        });
        expect(item<ToolItem>(session, "t")._meta).toBeNull();
        session = apply(session, {
            sessionUpdate: "tool_call_update",
            toolCallId: "t",
            _meta: { alwith: { n: 2 } },
        });
        session = apply(session, {
            sessionUpdate: "tool_call_update",
            toolCallId: "t",
            _meta: null,
        });
        expect(item<ToolItem>(session, "t")._meta).toBeNull();
    });

    test("message chunks patch the message's metadata too, so an agent sends each top-level key complete on every chunk", () => {
        let session = createSession("s", "/tmp");
        const chunk = (text: string, _meta: unknown) =>
            apply(session, {
                sessionUpdate: "agent_message_chunk",
                messageId: "m",
                content: { type: "text", text },
                _meta,
            });
        session = chunk("你", { alwith: { model: "opus" } });
        session = chunk("好", { alwith: { model: "opus", uuid: "u-1" } });
        expect(item<MessageItem>(session, "m")._meta).toEqual({
            alwith: { model: "opus", uuid: "u-1" },
        });
        // Chunk metadata is chunk-scoped: a chunk's null never clears what the message has.
        session = chunk("！", null);
        expect(item<MessageItem>(session, "m")._meta).toEqual({
            alwith: { model: "opus", uuid: "u-1" },
        });
        session = apply(session, {
            sessionUpdate: "agent_message",
            messageId: "m",
            _meta: null,
        });
        expect(item<MessageItem>(session, "m")._meta).toBeNull();
    });

    test("plan and compaction items carry _meta too; alwith-cli puts the persisted timestamps and compact_metadata there", () => {
        let session = createSession("s", "/tmp");
        session = apply(session, {
            sessionUpdate: "compaction_update",
            compactionId: "c",
            status: "completed",
            _meta: {
                alwith: {
                    timestamp: "2026-09-14T00:00:00Z",
                    compactMetadata: { pre_tokens: 120000 },
                },
            },
        });
        expect(item(session, "c")._meta).toEqual({
            alwith: {
                timestamp: "2026-09-14T00:00:00Z",
                compactMetadata: { pre_tokens: 120000 },
            },
        });
        session = apply(session, {
            sessionUpdate: "plan_update",
            plan: { planId: "p", entries: [] },
            _meta: { codex: { a: 1 } },
        });
        session = apply(session, {
            sessionUpdate: "plan_update",
            plan: { planId: "p", entries: [] },
            _meta: null,
        });
        expect(item(session, "p")._meta).toBeNull();
    });

    test("terminals and the session keep their own _meta under the same rule", () => {
        let session = createSession("s", "/tmp");
        session = apply(session, {
            sessionUpdate: "terminal_update",
            terminalId: "term",
            command: "ls",
            _meta: { codex: { a: 1 } },
        });
        session = apply(session, {
            sessionUpdate: "terminal_output_chunk",
            terminalId: "term",
            data: "",
            _meta: null,
        });
        session = apply(session, {
            sessionUpdate: "terminal_update",
            terminalId: "term",
            _meta: { codex: { reconciled: true } },
        });
        expect(session.terminals.term?._meta).toEqual({
            codex: { reconciled: true },
        });
        session = apply(session, {
            sessionUpdate: "session_info_update",
            _meta: {
                codex: { readState: { firstUnread: null, revision: "r1" } },
            },
        });
        session = apply(session, {
            sessionUpdate: "session_info_update",
            title: "T",
        });
        expect(session._meta).toEqual({
            codex: { readState: { firstUnread: null, revision: "r1" } },
        });
        expect(session.title).toBe("T");
    });
});

describe("locally shown user messages and their claim by the agent's echo", () => {
    test("addPrompt immediately adds a pending user message with exactly what the user sent", () => {
        const session = addPrompt(
            createSession("s", "/tmp"),
            [{ type: "text", text: "hi" }],
            "local-1",
        );
        const prompt = item<MessageItem>(session, "local-1");
        expect(prompt.kind).toBe("user");
        expect(prompt.echo).toBe("pending");
        expect(prompt.replayed).toBe(false);
    });

    test("the agent's echo only claims the id without adding another item; local content is authoritative (mentions and images alike)", () => {
        let session = addPrompt(
            createSession("s", "/tmp"),
            [{ type: "text", text: "@file hi" }],
            "local-1",
        );
        session = apply(session, {
            sessionUpdate: "user_message",
            messageId: "agent-7",
            content: [
                {
                    type: "text",
                    text: "Resource link: name=file, uri=file:///f\nhi",
                },
            ],
            _meta: { alwith: { uuid: "u-7" } },
        });
        session = acknowledgePrompt(session, "local-1", "agent-7");
        expect(session.items).toHaveLength(1);
        const prompt = item<MessageItem>(session, "agent-7");
        expect(prompt.echo).toBe("adopted");
        expect(prompt.content).toEqual([{ type: "text", text: "@file hi" }]);
        expect(prompt._meta).toEqual({ alwith: { uuid: "u-7" } });
    });

    test("a notification before the agent's echo still claims precisely by receipt", () => {
        let session = addPrompt(
            createSession("s", "/tmp"),
            [{ type: "text", text: "hello" }],
            "local-1",
        );
        session = apply(session, {
            sessionUpdate: "agent_message_chunk",
            messageId: "notice-1",
            content: {
                type: "text",
                text: "Warning: model metadata unavailable",
            },
        });
        session = apply(session, {
            sessionUpdate: "user_message",
            messageId: "agent-1",
            content: [{ type: "text", text: "hello" }],
        });

        session = acknowledgePrompt(session, "local-1", "agent-1");
        expect(session.items.map((entry) => entry.id)).toEqual([
            "notice-1",
            "agent-1",
        ]);
        const prompt = item<MessageItem>(session, "agent-1");
        expect(prompt.echo).toBe("adopted");
        expect(prompt.content).toEqual([{ type: "text", text: "hello" }]);
    });

    test("after the claim, frames with the same id only contribute _meta; an echo split into chunks does not change local content", () => {
        let session = addPrompt(
            createSession("s", "/tmp"),
            [{ type: "text", text: "hi" }],
            "local-1",
        );
        session = acknowledgePrompt(session, "local-1", "a");
        session = apply(session, {
            sessionUpdate: "user_message_chunk",
            messageId: "a",
            content: { type: "text", text: "hi" },
        });
        session = apply(session, {
            sessionUpdate: "user_message_chunk",
            messageId: "a",
            content: { type: "image", data: "…", mimeType: "image/png" },
            _meta: { alwith: { timestamp: "t" } },
        });
        expect(session.items).toHaveLength(1);
        const prompt = item<MessageItem>(session, "a");
        expect(prompt.content).toEqual([{ type: "text", text: "hi" }]);
        expect(prompt._meta).toEqual({ alwith: { timestamp: "t" } });
    });

    test("without a pending local message the agent's user message becomes a new item, as in history replay", () => {
        let session = createSession("s", "/tmp");
        session = apply(session, {
            sessionUpdate: "user_message_chunk",
            messageId: "h1",
            content: { type: "text", text: "old" },
        });
        session = apply(session, {
            sessionUpdate: "user_message_chunk",
            messageId: "h1",
            content: { type: "text", text: "er" },
        });
        const prompt = item<MessageItem>(session, "h1");
        expect(prompt.echo).toBeNull();
        // User message chunks are whole-block replays, not streaming deltas: each is its own block
        expect(prompt.content).toEqual([
            { type: "text", text: "old" },
            { type: "text", text: "er" },
        ]);
    });

    test("on user message replay each content block is its own frame, so resource links do not run into one line", () => {
        let session = createSession("s", "/tmp");
        const chunk = (text: string) =>
            apply(session, {
                sessionUpdate: "user_message_chunk",
                messageId: "h",
                content: { type: "text", text },
            });
        session = chunk("Resource link: name=a.ts, uri=file:///p/a.ts");
        session = chunk("Resource link: name=b.ts, uri=file:///p/b.ts");
        session = chunk("hi");
        expect(item<MessageItem>(session, "h").content).toHaveLength(3);
    });

    test("a message without a receipt stays pending and is not claimed by other messages", () => {
        let session = addPrompt(
            createSession("s", "/tmp"),
            [{ type: "text", text: "one" }],
            "l1",
        );
        session = apply(session, {
            sessionUpdate: "agent_message_chunk",
            messageId: "a1",
            content: { type: "text", text: "1" },
        });
        session = apply(session, {
            sessionUpdate: "state_update",
            state: "idle",
            stopReason: "end_turn",
        });
        session = addPrompt(session, [{ type: "text", text: "two" }], "l2");
        expect(session.items.map((entry) => entry.id)).toEqual([
            "l1",
            "a1",
            "l2",
        ]);
        expect(item<MessageItem>(session, "l1").echo).toBe("pending");
    });

    test("SessionStore.addPrompt returns a local id, replaced by the agent's id in items once the echo arrives", () => {
        const store = new SessionStore();
        store.set(createSession("s", "/tmp"));
        const localId = store.addPrompt("s", [{ type: "text", text: "hi" }]);
        expect(store.get("s").items[0]?.id).toBe(localId);
        store.accept("s", {
            sessionUpdate: "user_message",
            messageId: "agent-1",
            content: [],
        } as never);
        store.acknowledgePrompt("s", localId, "agent-1");
        expect(store.get("s").items.map((entry) => entry.id)).toEqual([
            "agent-1",
        ]);
    });
});

test("identical concurrent prompts are matched by response, including reversed replies", () => {
    let session = addPrompt(
        createSession("s", "/tmp"),
        [{ type: "text", text: "same" }],
        "local-1",
    );
    session = addPrompt(session, [{ type: "text", text: "same" }], "local-2");
    session = apply(session, {
        sessionUpdate: "user_message",
        messageId: "remote-1",
        content: [],
    });
    session = apply(session, {
        sessionUpdate: "user_message",
        messageId: "remote-2",
        content: [],
    });
    expect(item<MessageItem>(session, "local-1").echo).toBe("pending");
    expect(item<MessageItem>(session, "local-2").echo).toBe("pending");
    session = acknowledgePrompt(session, "local-2", "remote-2");
    session = acknowledgePrompt(session, "local-1", "remote-1");
    expect(session.items.map((item) => item.id)).toEqual([
        "remote-1",
        "remote-2",
    ]);
    expect(
        session.items.every(
            (item) => item.kind === "user" && item.content[0]?.type === "text",
        ),
    ).toBe(true);
});

test("an unrelated live user message never consumes an optimistic prompt", () => {
    let session = addPrompt(createSession("s", "/tmp"), [], "local");
    session = apply(session, {
        sessionUpdate: "user_message",
        messageId: "other-client",
        content: [],
    });
    session = acknowledgePrompt(session, "local", "own");
    expect(session.items.map((item) => item.id)).toEqual([
        "own",
        "other-client",
    ]);
});

test("the same remote ID cannot be assigned to two requests", () => {
    let session = addPrompt(createSession("s", "/tmp"), [], "first");
    session = addPrompt(session, [], "second");
    session = acknowledgePrompt(session, "first", "remote");
    expect(() => acknowledgePrompt(session, "second", "remote")).toThrow(
        "already belongs",
    );
});

test("queued local messages do not capture the current answer or its idle usage", () => {
    const store = new SessionStore();
    store.set(createSession("s", "/tmp"));
    const first = store.addPrompt("s", []);
    store.acknowledgePrompt("s", first, "a");
    store.accept("s", {
        sessionUpdate: "user_message",
        messageId: "a",
        content: [],
    } as never);
    const second = store.addPrompt("s", []);
    store.accept("s", {
        sessionUpdate: "agent_message_chunk",
        messageId: "answer",
        content: { type: "text", text: "first answer" },
    } as never);
    store.accept("s", {
        sessionUpdate: "state_update",
        state: "idle",
        stopReason: "end_turn",
    } as never);
    const [a, b] = store.turns("s");
    expect(a?.entries.map((item) => item.id)).toEqual(["answer"]);
    expect(a?.endedAt).not.toBeNull();
    expect(b?.prompt?.id).toBe(second);
    expect(b?.entries).toEqual([]);
    expect(b?.endedAt).toBeNull();
});

test("notice neither enters history nor changes task state", () => {
    const session = createSession("s", "/tmp");
    expect(
        apply(session, {
            sessionUpdate: "notice",
            title: "Advisory",
            severity: "warning",
        }),
    ).toBe(session);
});

for (const sessionUpdate of [
    "user_message",
    "agent_message",
    "agent_thought",
]) {
    test(`${sessionUpdate} omitted fields preserve, null clears, later chunks append`, () => {
        let session = createSession("s", "/tmp");
        session = apply(session, {
            sessionUpdate,
            messageId: "m",
            content: [{ type: "text", text: "old" }],
            _meta: { alwith: { uuid: "old" } },
        });
        const before = item<MessageItem>(session, "m");
        session = apply(session, { sessionUpdate, messageId: "m" });
        expect(item<MessageItem>(session, "m").content).toEqual(before.content);
        expect(item<MessageItem>(session, "m")._meta).toEqual(before._meta);
        session = apply(session, {
            sessionUpdate,
            messageId: "m",
            content: null,
            _meta: null,
        });
        expect(item<MessageItem>(session, "m").content).toEqual([]);
        expect(item<MessageItem>(session, "m")._meta).toBeNull();
        session = apply(session, {
            sessionUpdate: `${sessionUpdate}_chunk`,
            messageId: "m",
            content: { type: "text", text: "new" },
        });
        expect(item<MessageItem>(session, "m").content).toEqual([
            { type: "text", text: "new" },
        ]);
    });
}
