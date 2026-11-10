import {afterEach, expect, it, vi} from "vitest";
import {
    connectSession,
    codexResponse,
    createThread,
    createTurn,
    turnStarted,
    turnCompleted,
    sessionId,
    turnId,
    type PromptSession,
} from "./v2-prompt-harness";
const clients: PromptSession[] = [];
afterEach(() => {
    for (const client of clients.splice(0)) client.connection.close();
});
it("starts the native thread in the requested mode", async () => {
    const start = vi.fn(async () => codexResponse("thread/start"));
    const client = await connectSession(2, {
        newSessionMeta: {codex: {mode: "read-only"}},
        codexResponses: {"thread/start": start},
    });
    clients.push(client);
    expect(start).toHaveBeenCalledWith(expect.objectContaining({sandbox: "read-only"}));
    expect(client.agent.getSessionState(sessionId).agentMode.id).toBe("read-only");
});
it("retries only the latest eligible failed turn without duplicating user input", async () => {
    const client = await connectSession();
    clients.push(client);
    const failed = {
        ...createTurn("failed", "failed-turn"),
        error: {
            message: "busy",
            codexErrorInfo: "serverOverloaded",
            additionalDetails: null,
            misalignment: null,
        },
    };
    client.setCodexResponse("thread/turns/list", async () => ({
        data: [failed],
        nextCursor: null,
        backwardsCursor: null,
    }));
    client.setCodexResponse("thread/read", async () => ({
        thread: createThread(),
        readState: null,
    }));
    await expect(
        client.request("_codex/session_retry", {
            sessionId,
            turnId: "stale-turn",
            trigger: "automatic",
        }),
    ).rejects.toThrow("latest turn");
    expect(client.turnStartParams).toHaveLength(0);
    client.setTurnStart(async () => ({turn: createTurn("inProgress")}));
    const retry = client.request("_codex/session_retry", {
        sessionId,
        turnId: "failed-turn",
        trigger: "automatic",
    });
    await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(1));
    expect(client.turnStartParams[0]).toMatchObject({
        input: [],
        turnTrigger: "capacity_retry_automatic",
    });
    client.emit(turnStarted());
    await retry;
    client.emit(turnCompleted());
    await client.promptRunFinished();
});
