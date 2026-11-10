import {expect, it} from "vitest";
import {anthropicResponses, type MessagesUpstream} from "../alwith/codex/anthropicMessages";

const body = JSON.stringify({model: "claude-sonnet-4-6", stream: true, input: "Reply OK", max_output_tokens: 32});

function stream(tool = false): Response {
    const usage = {input_tokens: 12, output_tokens: 3};
    const events = [
        {type: "message_start", message: {id: "msg_oauth_test", type: "message", role: "assistant", model: "claude-sonnet-4-6", content: [], stop_reason: null, stop_sequence: null, usage}},
        {type: "content_block_start", index: 0, content_block: tool ? {type: "tool_use", id: "call_1", name: "custom_lookup", input: {}} : {type: "text", text: ""}},
        {type: "content_block_delta", index: 0, delta: tool ? {type: "input_json_delta", partial_json: '{"city":"Paris"}'} : {type: "text_delta", text: "OK"}},
        {type: "content_block_stop", index: 0},
        {type: "message_delta", delta: {stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null}, usage},
        {type: "message_stop"},
    ];
    return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {headers: {"content-type": "text/event-stream"}});
}

it.each(["key", "oauth"] as const)("translates %s authentication and completes the Responses stream", async authMode => {
    let captured: Parameters<MessagesUpstream["send"]> | undefined;
    const response = await anthropicResponses(body, {
        baseUrl: "https://api.anthropic.com", apiKey: "test-secret", authMode, signal: new AbortController().signal,
        send: async (...args) => { captured = args; return stream(); },
    });
    const text = await response.text();
    expect(text).toContain("response.completed");
    expect(text).toContain("OK");
    expect(captured![0].href).toBe("https://api.anthropic.com/v1/messages");
    const headers = new Headers(captured![1].headers);
    if (authMode === "oauth") {
        expect(headers.get("authorization")).toBe("Bearer test-secret");
        expect(headers.get("x-api-key")).toBeNull();
        expect(headers.get("anthropic-beta")).toContain("oauth-2025-04-20");
        expect(headers.get("user-agent")).toContain("claude-cli/");
    } else {
        expect(headers.get("x-api-key")).toBe("test-secret");
        expect(headers.get("authorization")).toBeNull();
        expect(headers.get("user-agent")).toBe("codex-acp");
    }
});

it("restores OAuth-prefixed tool calls to the original Codex tool name", async () => {
    const request = JSON.stringify({...JSON.parse(body), tools: [{type: "function", name: "lookup", parameters: {type: "object", properties: {city: {type: "string"}}}}]});
    const response = await anthropicResponses(request, {
        baseUrl: "https://api.anthropic.com", apiKey: "test-secret", authMode: "oauth", signal: new AbortController().signal,
        send: async (_url, init) => {
            expect(JSON.parse(init.body).tools[0].name).toBe("custom_lookup");
            return stream(true);
        },
    });
    const result = await response.text();
    expect(result).toContain('"name":"lookup"');
    expect(result).not.toContain('"name":"custom_lookup"');
    expect(result).toContain("response.completed");
});

it.each(["https://example.com", "http://api.anthropic.com", "https://api.anthropic.com/other", "https://api.anthropic.com?redirect=elsewhere"])("rejects OAuth credential routing to %s", async baseUrl => {
    let sent = false;
    await expect(anthropicResponses(body, {
        baseUrl, apiKey: "test-secret", authMode: "oauth", signal: new AbortController().signal,
        send: async () => { sent = true; return stream(); },
    })).rejects.toThrow("only be sent");
    expect(sent).toBe(false);
});

it("preserves an upstream OAuth rejection instead of falling back to an API key", async () => {
    let calls = 0;
    const response = await anthropicResponses(body, {
        baseUrl: "https://api.anthropic.com", apiKey: "test-secret", authMode: "oauth", signal: new AbortController().signal,
        send: async () => { calls++; return new Response('{"error":{"type":"authentication_error","message":"OAuth rejected"}}', {status: 401}); },
    });
    expect(response.status).toBe(401);
    expect(await response.text()).toContain("OAuth rejected");
    expect(calls).toBe(1);
});
