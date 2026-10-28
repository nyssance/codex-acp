import { afterEach, expect, it, vi } from "vitest";
import { createSession, SessionStore, textOf } from "../../client/protocol";
import type { ThreadItem } from "../../app-server/v2";
import {
    connectSession,
    createTurn,
    itemCompleted,
    itemStarted,
    sessionId,
    settle,
    userMessageItem,
    type PromptSession,
} from "./v2-prompt-harness";

let client: PromptSession;
afterEach(() => client?.connection.close());

it("reserves native message order, keeps phases and records bounded turn timing before idle", async () => {
    client = await connectSession();
    const response = client.sendPrompt([{ type: "text", text: "Go" }]);
    await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(1));
    client.emit({
        method: "turn/started",
        params: {
            threadId: sessionId,
            turn: { ...createTurn("inProgress"), startedAt: 100 },
        },
    });
    const userId = client.turnStartParams[0]!["clientUserMessageId"] as string;
    client.emit(itemCompleted(userMessageItem(userId)));
    await response;
    const message = (
        id: string,
        text: string,
        phase: "commentary" | "final_answer",
    ): Extract<ThreadItem, { type: "agentMessage" }> => ({
        type: "agentMessage",
        id,
        text,
        phase,
        memoryCitation: null,
        delivery: null,
        questions: null,
    });
    client.emit(itemStarted(message("commentary", "", "commentary")));
    client.emit({
        method: "item/agentMessage/delta",
        params: {
            threadId: sessionId,
            turnId: "turn-1",
            itemId: "commentary",
            delta: "Working",
        },
    });
    client.emit(itemCompleted(message("commentary", "Working", "commentary")));
    const final = message("answer", "Answer", "final_answer");
    const started = itemStarted({ ...final, text: "" });
    if (started.method !== "item/started")
        throw new Error("Expected item start");
    client.emit({
        ...started,
        params: { ...started.params, startedAtMs: 103000 },
    });
    client.emit(itemCompleted(final));
    client.emit({
        method: "turn/completed",
        params: {
            threadId: sessionId,
            turn: {
                ...createTurn("completed"),
                startedAt: 100,
                completedAt: 105,
                durationMs: 5000,
            },
        },
    });
    await client.promptRunFinished();
    await settle();
    const updates = client.transcript.flatMap((entry) =>
        "sessionUpdate" in entry ? [entry.sessionUpdate] : [],
    );
    const commentary = updates.filter(
        (update) => "messageId" in update && update.messageId === "commentary",
    );
    expect(commentary.map((update) => update.sessionUpdate)).toEqual([
        "agent_message",
        "agent_message_chunk",
        "agent_message",
    ]);
    for (const update of commentary)
        expect(update._meta).toMatchObject({ codex: { phase: "commentary" } });
    const timed = updates.findLast(
        (update) => "messageId" in update && update.messageId === "answer",
    );
    expect(timed).toMatchObject({
        _meta: {
            codex: {
                turnId: "turn-1",
                phase: "final_answer",
                messageCompleted: true,
                turnStartedAt: 100000,
                turnCompletedAt: 105000,
                turnDurationMs: 5000,
                workDurationMs: 3000,
            },
        },
    });
    expect(updates.at(-1)).toMatchObject({
        sessionUpdate: "state_update",
        state: "idle",
    });
    const store = new SessionStore();
    store.set(createSession(sessionId, "/work"));
    for (const update of updates) store.accept(sessionId, update);
    const session = store.get(sessionId);
    expect(session.items.map((item) => item.id)).toEqual([
        userId,
        "commentary",
        "answer",
    ]);
    const answer = session.items[2]!;
    expect(answer.kind === "assistant" && textOf(answer.content)).toBe(
        "Answer",
    );
});
