import {afterEach, describe, expect, it, vi} from "vitest";
import {keyedPromptId} from "../../AcpV2Prompt";
import {
    connectSession, createThread, createTurn, cwd, itemCompleted, sessionId, settle, turnCompleted, turnFinished, turnStarted, userMessageItem,
    type PromptSession,
} from "./v2-prompt-harness";
import {expectConformingV2SessionUpdates} from "./v2-session-update-guard";

const prompt = [{type: "text", text: "Hello"}];
const key = "a-client-generated-submission-key";
const params = {sessionId, prompt, idempotencyKey: key};

describe("ACP v2 keyed prompts", () => {
    let h: PromptSession | undefined;
    afterEach(() => {
        h?.connection.close();
        h = undefined;
        expectConformingV2SessionUpdates();
    });

    it("shares the original receipt with concurrent and later retries, even while work is running", async () => {
        h = await connectSession();
        const first = h.request("session/prompt", params);
        const retry = h.request("session/prompt", params);
        await vi.waitFor(() => expect(h!.turnStartParams).toHaveLength(1));
        const messageId = h.turnStartParams[0]!["clientUserMessageId"] as string;
        expect(messageId).not.toContain(key);
        h.emit(turnStarted());
        h.emit(itemCompleted(userMessageItem(messageId)));
        expect(await Promise.all([first, retry])).toEqual([{messageId}, {messageId}]);
        await expect(h.request("session/prompt", params)).resolves.toEqual({messageId});
        expect(h.turnStartParams).toHaveLength(1);
        expect(h.scopedUpdates.filter(({update}) => update.sessionUpdate === "user_message_chunk")).toHaveLength(1);
        expect(JSON.stringify(h.wireMessages)).not.toContain(key);
        h.emit(turnCompleted());
        await h.promptRunFinished();
    });

    it("does not forget the key when a cancelled request has already been dispatched to Codex", async () => {
        h = await connectSession();
        const abort = new AbortController();
        const seen = vi.spyOn(h.agent, "promptV2");
        const first = h.request("session/prompt", params, abort.signal);
        const retry = h.request("session/prompt", params);
        await vi.waitFor(() => {
            expect(seen).toHaveBeenCalledTimes(2);
            expect(h!.turnStartParams).toHaveLength(1);
        });
        abort.abort();
        // Flush the cancellation before Codex reports insertion. Best-effort withdrawal
        // cannot retract input that Codex has already accepted for delivery.
        await h.request("session/list", {});
        const messageId = h.turnStartParams[0]!["clientUserMessageId"] as string;
        h.emit(turnStarted());
        h.emit(itemCompleted(userMessageItem(messageId)));
        expect(await Promise.all([first, retry])).toEqual([{messageId}, {messageId}]);
        expect(h.turnInterruptCalls()).toEqual([]);
        h.emit(turnCompleted());
        await h.promptRunFinished();
    });

    it("retries a hook-blocked steer and shares the receipt only after native insertion", async () => {
        h = await connectSession();
        const blocker = h.sendPrompt([{type: "text", text: "Block the queue"}]);
        await vi.waitFor(() => expect(h!.turnStartParams).toHaveLength(1));
        h.emit(turnStarted());
        h.emit(itemCompleted(userMessageItem(h.turnStartParams[0]!["clientUserMessageId"] as string)));
        await blocker;

        const steer = vi.fn(async () => ({}));
        h.setCodexResponse("turn/steer", steer);
        const messageId = keyedPromptId(sessionId, key);
        const blocked = h.request("session/prompt", params);
        const concurrent = h.request("session/prompt", params);
        const rejected = Promise.allSettled([blocked, concurrent]);
        await vi.waitFor(() => expect(steer).toHaveBeenCalledTimes(1));

        // A blocked submit hook can skip the user item and leave Codex to complete the active turn.
        h.emit({method: "turn/completed", params: {threadId: sessionId, turn: createTurn("completed")}});
        expect(await rejected).toEqual([
            {status: "rejected", reason: expect.objectContaining({code: -32603})},
            {status: "rejected", reason: expect.objectContaining({code: -32603})},
        ]);
        await h.promptRunFinished();
        expect(h.scopedUpdates.some(({update}) => update.sessionUpdate === "user_message_chunk" && update.messageId === messageId)).toBe(false);

        // The same key can be sent into a later running turn, and matches one Codex insertion.
        const next = h.sendPrompt([{type: "text", text: "Next turn"}]);
        await vi.waitFor(() => expect(h!.turnStartParams).toHaveLength(2));
        h.emit(turnStarted("turn-2"));
        h.emit(itemCompleted(userMessageItem(h.turnStartParams[1]!.clientUserMessageId as string), "turn-2"));
        await next;

        const nativeReply = Promise.withResolvers<object>();
        steer.mockImplementationOnce(() => nativeReply.promise);
        const firstRetry = h.request("session/prompt", params);
        const secondRetry = h.request("session/prompt", params);
        await vi.waitFor(() => expect(steer).toHaveBeenCalledTimes(2));
        expect(steer).toHaveBeenLastCalledWith(expect.objectContaining({clientUserMessageId: messageId, expectedTurnId: "turn-2"}));
        h.emit(itemCompleted(userMessageItem(messageId, "Hello"), "turn-2"));
        try {
            expect(await Promise.all([firstRetry, secondRetry])).toEqual([{messageId}, {messageId}]);
        } finally {
            nativeReply.resolve({});
        }
        await expect(h.request("session/prompt", params)).resolves.toEqual({messageId});
        expect(steer).toHaveBeenCalledTimes(2);
        expect(h.scopedUpdates.filter(({update}) => update.sessionUpdate === "user_message_chunk" && update.messageId === messageId)).toHaveLength(1);
        expect(JSON.stringify(h.wireMessages)).not.toContain(key);
        h.emit(turnCompleted("turn-2"));
        await h.promptRunFinished(1);
        await settle();
    });

    it("cancels a keyed steer still checking retained history without dispatching it", async () => {
        h = await connectSession();
        await h.request("session/resume", {sessionId, cwd});
        h.emit(turnStarted());
        await h.waitForNotifications();

        const history = Promise.withResolvers<{thread: ReturnType<typeof createThread>}>();
        const read = vi.fn(async (request: unknown) => (request as {includeTurns?: boolean}).includeTurns
            ? await history.promise : {thread: createThread()});
        const steer = vi.fn(async () => ({}));
        h.setCodexResponse("thread/read", read);
        h.setCodexResponse("turn/steer", steer);
        const response = h.request("session/prompt", params);
        try {
            await vi.waitFor(() => expect(read).toHaveBeenCalledWith(expect.objectContaining({includeTurns: true})));
            await h.cancel();
            await expect(response).rejects.toMatchObject({code: -32800});
        } finally {
            history.resolve({thread: createThread()});
        }
        h.emit(turnFinished("interrupted"));
        await settle();
        expect(steer).not.toHaveBeenCalled();
        expect(h.turnStartParams).toHaveLength(0);
    });

    it("keeps the key unused on a pre-insertion failure and rejects malformed keys before starting work", async () => {
        h = await connectSession();
        for (const idempotencyKey of ["", "x".repeat(256), 7]) {
            await expect(h.request("session/prompt", {...params, idempotencyKey})).rejects.toMatchObject({code: -32602});
        }
        expect(h.turnStartParams).toEqual([]);
        h.setTurnStart(async () => { throw new Error("Rejected before insertion"); });
        await expect(h.request("session/prompt", params)).rejects.toBeDefined();
        h.setTurnStart(async () => ({turn: createTurn("inProgress")}));
        const retry = h.request("session/prompt", params);
        await vi.waitFor(() => expect(h!.turnStartParams).toHaveLength(2));
        const messageId = h.turnStartParams[1]!["clientUserMessageId"] as string;
        h.emit(turnStarted());
        h.emit(itemCompleted(userMessageItem(messageId)));
        await expect(retry).resolves.toEqual({messageId});
        h.emit(turnCompleted());
        await h.promptRunFinished(1);
    });

    it("keeps local-command receipts across an active resume without rerunning the command", async () => {
        h = await connectSession();
        const command = {...params, prompt: [{type: "text", text: "/status"}]};
        const first = await h.request("session/prompt", command);
        await h.promptRunFinished();
        await h.request("session/resume", {sessionId, cwd});
        await expect(h.request("session/prompt", command)).resolves.toEqual(first);
        expect(h.scopedUpdates.filter(({update}) => update.sessionUpdate === "user_message_chunk")).toHaveLength(1);
        expect(h.turnStartParams).toEqual([]);
    });

    it("fails closed on an unreadable transcript and finds a retained ID when the read recovers", async () => {
        h = await connectSession();
        await h.request("session/close", {sessionId});
        await h.request("session/resume", {sessionId, cwd});
        const messageId = keyedPromptId(sessionId, key);
        h.setCodexResponse("thread/read", async () => { throw new Error("History read failed"); });
        await expect(h.request("session/prompt", params)).rejects.toBeDefined();
        expect(h.turnStartParams).toEqual([]);
        h.setCodexResponse("thread/read", async request => ({
            thread: {...createThread(), turns: (request as {includeTurns?: boolean}).includeTurns
                ? [{...createTurn("completed"), items: [userMessageItem(messageId)]}] : []},
        }));
        await expect(h.request("session/prompt", params)).resolves.toEqual({messageId});
        expect(h.turnStartParams).toEqual([]);
    });
});
