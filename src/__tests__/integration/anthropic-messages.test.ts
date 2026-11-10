// Real codex-acp + real `codex app-server`; the Anthropic Messages endpoint is a local mock.
import {createServer, type Server} from "node:http";
import type {AddressInfo} from "node:net";
import {expect, it} from "vitest";
import {connectAndLogin, describeIntegration, openSession, sendPrompt, spawnAgent, stopAll} from "./integration-fixture";
import {startMockResponsesServer} from "./mock-responses-server";

interface MessagesRequest {
    path: string;
    headers: Record<string, string | string[] | undefined>;
    body: {model: string; stream: boolean; messages: Array<{role: string; content: unknown}>};
}

/** Streams one text answer in Anthropic's Messages SSE format and records what it was asked. */
async function startMockMessagesServer(text: string): Promise<{baseUrl: string; requests: MessagesRequest[]; server: Server}> {
    const requests: MessagesRequest[] = [];
    const server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as MessagesRequest["body"];
            requests.push({path: request.url!, headers: request.headers, body});
            const usage = {input_tokens: 12, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 3};
            const events = [
                {type: "message_start", message: {id: "msg_1", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage}},
                {type: "content_block_start", index: 0, content_block: {type: "text", text: ""}},
                {type: "content_block_delta", index: 0, delta: {type: "text_delta", text}},
                {type: "content_block_stop", index: 0},
                {type: "message_delta", delta: {stop_reason: "end_turn", stop_sequence: null}, usage},
                {type: "message_stop"},
            ];
            response.writeHead(200, {"content-type": "text/event-stream"});
            response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
        });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    return {baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests, server};
}

describeIntegration("integration: a gateway that speaks Anthropic Messages", () => {
    /**
     * Scenario: the client registers an `anthropic` gateway and selects one of its models.
     * Expected:
     * - Codex's Responses request reaches the endpoint as a Messages request, with the gateway's key;
     * - the Messages stream comes back to the session as the agent's answer.
     */
    it("answers a Codex turn from the Messages endpoint", async () => {
        const mock = await startMockResponsesServer();
        const messages = await startMockMessagesServer("answered-by-messages");
        const agent = await spawnAgent();
        try {
            await connectAndLogin(agent, mock.baseUrl);
            const sessionId = await openSession(agent);
            await agent.connection.request("providers/set", {
                providerId: "openai",
                apiType: "anthropic",
                baseUrl: messages.baseUrl,
                _meta: {
                    codex: {id: "anthropic", mode: "catalog", name: "Anthropic", bearerToken: "sk-ant-test"},
                    // A Codex model id needs no `model_catalog_json`; the endpoint sees whatever id the gateway lists.
                    alwith: {models: [{id: "gpt-5.5", label: "Claude"}]},
                },
            });
            await agent.connection.request("session/set_config_option", {sessionId, configId: "model", value: "gateway:anthropic:gpt-5.5"});
            expect((await sendPrompt(agent, sessionId, "hello")).stopReason).toBe("end_turn");
            expect(agent.readText(sessionId)).toContain("answered-by-messages");
            expect(mock.requests).toHaveLength(0);
            expect(messages.requests).toHaveLength(1);
            const request = messages.requests[0]!;
            expect(request.path).toBe("/v1/messages");
            expect(request.headers["x-api-key"]).toBe("sk-ant-test");
            expect(request.headers["user-agent"]).toBe("codex-acp");
            expect(request.headers["authorization"]).toBeUndefined();
            expect(request.body).toMatchObject({model: "gpt-5.5", stream: true});
            expect(JSON.stringify(request.body.messages)).toContain("hello");
        } finally {
            messages.server.close();
            await stopAll(agent, mock);
        }
    });
});
