// In-process ACP v2 agent with just enough behaviour to exercise the engine-neutral client:
// async prompts, permissions, cancellation, replay, fork, list and delete. Ported from U's
// agent/__tests__/fake-agent.ts without the Codex-only methods (2026-10-27 chat-layer extraction).
import * as acp from "@agentclientprotocol/sdk/experimental/v2/unstable";

export type FakeAgent = {
    app: acp.AgentApp;
    deleted: Set<string>;
    forks: acp.ForkSessionRequest[];
    /** Every `session/new` request, for asserting what the client sent. */
    created: acp.NewSessionRequest[];
    /** Every `session/resume` request. */
    resumed: acp.ResumeSessionRequest[];
    configDelay: { current: (() => Promise<void>) | null };
    newSessionDelay: { current: ((cwd: string) => Promise<void>) | null };
    sessionOptions: {
        current:
            | ((
                  meta?: acp.NewSessionRequest["_meta"],
              ) => acp.SessionConfigOption[])
            | null;
    };
    sessionCommands: { current: acp.AvailableCommand[] | undefined };
    configResponse: {
        current:
            | ((
                  request: acp.SetSessionConfigOptionRequest,
              ) => acp.SetSessionConfigOptionResponse)
            | null;
    };
    listSessions: {
        current:
            | ((
                  request: acp.ListSessionsRequest,
              ) => acp.ListSessionsResponse | Promise<acp.ListSessionsResponse>)
            | null;
    };
    listRequests: acp.ListSessionsRequest[];
    configChanges: string[];
    /** A prompt whose text the function rejects never becomes a turn. */
    rejectPrompt: { current: ((text: string) => Error | null) | null };
    pushUpdate: (sessionId: string, update: acp.SessionUpdate) => Promise<void>;
    requestForm: (
        params: acp.CreateElicitationRequest,
    ) => Promise<acp.CreateElicitationResponse>;
    resumeResponse: {
        current:
            | ((signal: AbortSignal) => Promise<acp.ResumeSessionResponse>)
            | null;
    };
    replayUpdates: acp.SessionUpdate[];
    forkFrames: { sessionId: string | null; update: acp.SessionUpdate }[];
    cancelled: string[];
};

function modelOption(current: string): acp.SessionConfigOption {
    return {
        configId: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: current,
        options: [
            { value: "default-model", name: "Default" },
            { value: "other-model", name: "Other" },
        ],
    };
}

export function createFakeAgent(): FakeAgent {
    const app = new acp.AgentApp();
    const active = new Map<string, AbortController>();
    const deleted = new Set<string>();
    const forks: acp.ForkSessionRequest[] = [];
    const created: acp.NewSessionRequest[] = [];
    const resumed: acp.ResumeSessionRequest[] = [];
    const origins = new Map<
        string,
        { nativeSessionId: string; forkedFromId: string }
    >();
    const configDelay: FakeAgent["configDelay"] = { current: null };
    const newSessionDelay: FakeAgent["newSessionDelay"] = { current: null };
    const sessionOptions: FakeAgent["sessionOptions"] = { current: null };
    const sessionCommands: FakeAgent["sessionCommands"] = {
        current: undefined,
    };
    const configResponse: FakeAgent["configResponse"] = { current: null };
    const listSessions: FakeAgent["listSessions"] = { current: null };
    const listRequests: acp.ListSessionsRequest[] = [];
    const configChanges: string[] = [];
    const changingConfig = new Set<string>();
    const rejectPrompt: FakeAgent["rejectPrompt"] = { current: null };
    const resumeResponse: FakeAgent["resumeResponse"] = { current: null };
    const replayUpdates: acp.SessionUpdate[] = [];
    const forkFrames: FakeAgent["forkFrames"] = [];
    const cancelled: string[] = [];
    let link: acp.AgentContext | null = null;
    const optionsFor = (
        meta?: acp.NewSessionRequest["_meta"],
        current = "default-model",
    ): acp.SessionConfigOption[] =>
        sessionOptions.current?.(meta) ?? [modelOption(current)];
    let next = 0;
    const sessionId = () => `s${next++}`;
    app.onRequest("initialize", ({ client }) => {
        link = client;
        return {
            protocolVersion: 2,
            info: { name: "fake-agent", version: "1" },
            capabilities: { session: { fork: {}, systemPrompt: {} } },
            authMethods: [
                { type: "agent", methodId: "chat-gpt", name: "ChatGPT" },
            ],
        };
    });
    app.onRequest("session/new", async ({ params }) => {
        await newSessionDelay.current?.(params.cwd);
        created.push(params);
        if (params.cwd === "/needs-auth") throw acp.RequestError.authRequired();
        const id = sessionId();
        return {
            sessionId: id,
            configOptions: optionsFor(params._meta),
            availableCommands: sessionCommands.current,
        };
    });
    app.onRequest("session/fork", async ({ params, client }) => {
        forks.push(params);
        const id = sessionId();
        const codex = { nativeSessionId: id, forkedFromId: params.sessionId };
        origins.set(id, codex);
        for (const frame of forkFrames)
            await client.notify("session/update", {
                sessionId: frame.sessionId ?? id,
                update: frame.update,
            });
        for (const update of replayUpdates)
            await client.notify("session/update", { sessionId: id, update });
        return {
            sessionId: id,
            configOptions: optionsFor(params._meta),
            availableCommands: sessionCommands.current,
            _meta: { codex },
        };
    });
    app.onRequest("session/list", ({ params }) => {
        listRequests.push(params);
        if (listSessions.current !== null) return listSessions.current(params);
        return {
            sessions: [
                {
                    sessionId: "h1",
                    cwd: "/tmp/one",
                    title: "First",
                    updatedAt: "2026-10-01T00:00:00.000Z",
                },
                {
                    sessionId: "h2",
                    cwd: "/tmp/two",
                    title: "Second",
                    updatedAt: "2026-10-02T00:00:00.000Z",
                },
            ].filter((item) => !deleted.has(item.sessionId)),
        };
    });
    app.onRequest("session/close", async ({ params }) => {
        active.get(params.sessionId)?.abort();
        while (active.has(params.sessionId))
            await new Promise((resolve) => setTimeout(resolve, 1));
        return {};
    });
    app.onRequest("session/resume", async ({ params, client, signal }) => {
        resumed.push(params);
        if (params.replayFrom != null) {
            for (const update of replayUpdates)
                await client.notify("session/update", {
                    sessionId: params.sessionId,
                    update,
                });
            await client.notify("session/update", {
                sessionId: params.sessionId,
                update: {
                    sessionUpdate: "user_message",
                    messageId: "u",
                    content: [{ type: "text", text: "history" }],
                },
            });
            await client.notify("session/update", {
                sessionId: params.sessionId,
                update: {
                    sessionUpdate: "agent_message",
                    messageId: "m",
                    content: [
                        { type: "text", text: `restored:${params.sessionId}` },
                    ],
                },
            });
        }
        if (resumeResponse.current) return resumeResponse.current(signal);
        const origin = origins.get(params.sessionId);
        return {
            configOptions: optionsFor(params._meta),
            availableCommands: sessionCommands.current,
            ...(origin ? { _meta: { codex: origin } } : {}),
        };
    });
    app.onRequest("session/set_config_option", async ({ params }) => {
        if (changingConfig.has(params.sessionId))
            throw acp.RequestError.invalidRequest(
                { sessionId: params.sessionId },
                "Session lifecycle or configuration work is in progress",
            );
        changingConfig.add(params.sessionId);
        try {
            await configDelay.current?.();
            if (configResponse.current) return configResponse.current(params);
            if (params.configId !== "model" || typeof params.value !== "string")
                throw acp.RequestError.invalidParams();
            configChanges.push(params.value);
            return { configOptions: optionsFor(undefined, params.value) };
        } finally {
            changingConfig.delete(params.sessionId);
        }
    });
    // Receipt ids per session: the first prompt is "u" (the tests name it), later ones "u2", "u3"…
    const promptSequence = new Map<string, number>();
    app.onRequest("session/prompt", async ({ params, client }) => {
        const id = params.sessionId;
        const text = params.prompt
            .map((block) => (block.type === "text" ? block.text : ""))
            .join("");
        const refusal = rejectPrompt.current?.(text);
        if (refusal)
            throw acp.RequestError.invalidParams({ text }, refusal.message);
        const sequence = (promptSequence.get(id) ?? 0) + 1;
        promptSequence.set(id, sequence);
        const messageId = sequence === 1 ? "u" : `u${sequence}`;
        if (active.has(id)) return { messageId };
        const controller = new AbortController();
        active.set(id, controller);
        const emit = (update: acp.SessionUpdate) =>
            client.notify("session/update", { sessionId: id, update });
        await emit({ sessionUpdate: "state_update", state: "running" });
        void (async () => {
            try {
                await emit({
                    sessionUpdate: "user_message",
                    messageId,
                    content: [{ type: "text", text }],
                });
                if (text === "permission") {
                    await emit({
                        sessionUpdate: "state_update",
                        state: "requires_action",
                    });
                    const answer = await client.request(
                        "session/request_permission",
                        {
                            sessionId: id,
                            title: "Run command?",
                            subject: {
                                type: "tool_call",
                                toolCall: {
                                    toolCallId: "permission-tool",
                                    status: "pending",
                                },
                            },
                            options: [
                                {
                                    optionId: "allow_once",
                                    name: "Allow once",
                                    kind: "allow_once",
                                },
                                {
                                    optionId: "decline",
                                    name: "Decline",
                                    kind: "reject_once",
                                },
                            ],
                        },
                        { cancellationSignal: controller.signal },
                    );
                    await emit({
                        sessionUpdate: "state_update",
                        state: "running",
                    });
                    await emit({
                        sessionUpdate: "agent_message_chunk",
                        messageId: "m",
                        content: { type: "text", text: JSON.stringify(answer) },
                    });
                } else if (text === "terminal") {
                    await emit({
                        sessionUpdate: "tool_call_update",
                        toolCallId: "t1",
                        name: "shell",
                        title: "ls",
                        kind: "execute",
                        status: "in_progress",
                        content: [{ type: "terminal", terminalId: "t1" }],
                    });
                    await emit({
                        sessionUpdate: "terminal_update",
                        terminalId: "t1",
                        command: "ls",
                    });
                    const bytes = new TextEncoder().encode("héllo");
                    await emit({
                        sessionUpdate: "terminal_output_chunk",
                        terminalId: "t1",
                        data: btoa(String.fromCharCode(...bytes.slice(0, 2))),
                    });
                    await emit({
                        sessionUpdate: "terminal_output_chunk",
                        terminalId: "t1",
                        data: btoa(String.fromCharCode(...bytes.slice(2))),
                    });
                    await emit({
                        sessionUpdate: "tool_call_update",
                        toolCallId: "t1",
                        status: "completed",
                    });
                } else {
                    await new Promise((resolve) => setTimeout(resolve, 80));
                    if (!controller.signal.aborted)
                        await emit({
                            sessionUpdate: "agent_message_chunk",
                            messageId: "m",
                            content: { type: "text", text: `reply:${id}` },
                        });
                }
            } catch {
                // A prompt cancelled by the test rejects here; the finally block still reports idle.
            } finally {
                await emit({
                    sessionUpdate: "state_update",
                    state: "idle",
                    ...(controller.signal.aborted
                        ? { stopReason: "cancelled" as const }
                        : { stopReason: "end_turn" as const }),
                });
                active.delete(id);
            }
        })();
        return { messageId };
    });
    app.onNotification("session/cancel", ({ params }) => {
        cancelled.push(params.sessionId);
        active.get(params.sessionId)?.abort();
    });
    app.onRequest("session/delete", ({ params }) => {
        deleted.add(params.sessionId);
        return {};
    });
    return {
        app,
        deleted,
        forks,
        created,
        resumed,
        configDelay,
        newSessionDelay,
        sessionOptions,
        sessionCommands,
        configResponse,
        listSessions,
        listRequests,
        configChanges,
        rejectPrompt,
        replayUpdates,
        forkFrames,
        cancelled,
        resumeResponse,
        requestForm: async (params) => {
            if (link === null) throw new Error("Fake agent is not connected");
            return link.request("elicitation/create", params);
        },
        pushUpdate: async (sessionId, update) => {
            if (link === null) throw new Error("Fake agent is not connected");
            await link.notify("session/update", { sessionId, update });
        },
    };
}
