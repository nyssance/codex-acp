import {afterEach, describe, expect, it, vi} from "vitest";
import {keyedPromptId} from "../../AcpV2Prompt";
import {
    connectSession, createThread, createTurn, cwd, itemCompleted, sessionId, turnCompleted, turnStarted, userMessageItem,
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

    // Upstream holds a prompt behind a running turn and has cases for dropping it while it is held.
    // This adapter does not hold an ordinary prompt: it steers it into the running turn (see
    // steering-v2.test.ts), so a keyed prompt there has no held state to drop.
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
