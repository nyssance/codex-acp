import type * as acp from "@agentclientprotocol/sdk/experimental/v2/unstable";

import type { Agent } from "../agents";

// Compiled by the package typecheck; never opens a connection or sends a request.
export function checkAgentMethodContracts(agent: Agent): void {
    const prompt: Promise<acp.PromptResponse> = agent.request(
        "session/prompt",
        {
            sessionId: "session",
            prompt: [{ type: "text", text: "hello" }],
        },
    );
    const resumed: Promise<acp.ResumeSessionResponse> = agent.request(
        "session/resume",
        {
            sessionId: "session",
            cwd: "/project",
            mcpServers: [],
        },
    );
    const custom: Promise<{ ok: boolean }> = agent.request<{ ok: boolean }>(
        "_custom/status",
        {},
    );
    const future: Promise<unknown> = agent.request("future/request", {});
    const official: Pick<acp.ClientContext, "request" | "notify"> = agent;
    void official.request(
        "session/prompt",
        { sessionId: "s", prompt: [] },
        {
            cancellationSignal: new AbortController().signal,
        },
    );
    void agent.request(
        // @ts-expect-error The private immediate-cancellation option is no longer supported.
        "session/prompt",
        { sessionId: "s", prompt: [] },
        { signal: new AbortController().signal },
    );
    void [prompt, resumed, custom, future];
    void agent.notify("session/cancel", { sessionId: "session" });
    void agent.notify("$/cancel_request", { requestId: 1 });
    void agent.notify("_custom/event", { ok: true });

    // @ts-expect-error A prompt requires a session identifier.
    void agent.request("session/prompt", { prompt: [] });
    // @ts-expect-error Standard methods cannot opt out of their contract using a response generic.
    void agent.request<{ invented: boolean }>("session/prompt", {});
    // @ts-expect-error A notification cannot be sent as a request.
    void agent.request("session/cancel", { sessionId: "session" });
    // @ts-expect-error Agent requests cannot be sent as notifications.
    void agent.notify("session/prompt", { sessionId: "session", prompt: [] });
    // @ts-expect-error Permission requests belong to the client, not the agent.
    void agent.request("session/request_permission", {});
    // @ts-expect-error Request cancellation requires the request identifier.
    void agent.notify("$/cancel_request", { sessionId: "session" });
    // @ts-expect-error The official prompt result cannot be replaced by an invented shape.
    const wrong: Promise<{ invented: boolean }> = agent.request(
        "session/prompt",
        { sessionId: "s", prompt: [] },
    );
    void wrong;
}
