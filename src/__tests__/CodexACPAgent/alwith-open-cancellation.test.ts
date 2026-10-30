import { afterEach, expect, it, vi } from "vitest";
import { deferred } from "../acp-test-utils";
import {
    connectSession,
    codexResponse,
    createThread,
    cwd,
    sessionId,
    settle,
    type PromptSession,
} from "./v2-prompt-harness";

const clients: PromptSession[] = [];
afterEach(() => {
    for (const client of clients.splice(0)) client.connection.close();
});

it.each([
    ["session/new", "thread/start"],
    ["session/resume", "thread/resume"],
    ["session/fork", "thread/fork"],
])(
    "cleans up a late native response after cancelling %s",
    async (method, nativeMethod) => {
        const client = await connectSession();
        clients.push(client);
        const pending = deferred<unknown>();
        const native = vi.fn(() => pending.promise);
        const unsubscribe = vi.fn(async () => ({}));
        client.setCodexResponse(nativeMethod!, native);
        client.setCodexResponse("thread/unsubscribe", unsubscribe);
        const controller = new AbortController();
        const openedId = method === "session/resume" ? sessionId : "late-open";
        const response = client.request(
            method!,
            { cwd, ...(method === "session/new" ? {} : { sessionId }) },
            controller.signal,
        );
        const rejected = expect(response).rejects.toMatchObject({
            code: -32800,
        });
        await vi.waitFor(() => expect(native).toHaveBeenCalledOnce());
        controller.abort();
        await rejected;
        await settle();
        pending.resolve({
            ...(codexResponse("thread/start") as object),
            thread: { ...createThread(), id: openedId, sessionId: openedId },
        });
        await vi.waitFor(() =>
            expect(unsubscribe).toHaveBeenCalledWith({ threadId: openedId }),
        );
        await settle();
        expect(() => client.agent.getSessionState(openedId)).toThrow();
    },
);

it("invalidates queued setup on cancellation and allows a fresh resume afterward", async () => {
    const client = await connectSession();
    clients.push(client);
    const old = deferred<unknown>();
    const native = vi
        .fn()
        .mockImplementationOnce(() => old.promise)
        .mockResolvedValue(codexResponse("thread/resume"));
    const unsubscribe = vi.fn(async () => ({}));
    client.setCodexResponse("thread/resume", native);
    client.setCodexResponse("thread/unsubscribe", unsubscribe);
    const controller = new AbortController();
    const first = client.request(
        "session/resume",
        { sessionId, cwd },
        controller.signal,
    );
    const rejected = expect(first).rejects.toMatchObject({ code: -32800 });
    await vi.waitFor(() => expect(native).toHaveBeenCalledTimes(1));
    const second = client.request("session/resume", { sessionId, cwd });
    const queuedRejected = expect(second).rejects.toMatchObject({code: -32600});
    await settle();
    expect(native).toHaveBeenCalledTimes(1);
    controller.abort();
    await rejected;
    await settle();
    old.resolve(codexResponse("thread/resume"));
    await settle();
    await queuedRejected;
    expect(native).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalled();
    await client.request("session/resume", {sessionId, cwd});
    expect(native).toHaveBeenCalledTimes(2);
    const unsubscribeCount = unsubscribe.mock.calls.length;
    const owner = client.agent.getSessionState(sessionId);
    await settle();
    expect(client.agent.getSessionState(sessionId)).toBe(owner);
    expect(unsubscribe).toHaveBeenCalledTimes(unsubscribeCount);
});
