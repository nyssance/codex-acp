// Real Codex processes and isolated homes; only the model endpoints are mocked.
import * as acp from "@agentclientprotocol/sdk/unstable";
import {expect, it} from "vitest";
import {legacySetSessionModel} from "../../AcpExtensions";
import {AgentMode} from "../../AgentMode";
import {createSpawnedAgentFixture} from "../CodexACPAgent/e2e/spawned-agent-fixture";
import {agentText, describeIntegration, INTEGRATION_MODEL_ID, sendPrompt} from "./integration-fixture";
import {startMockResponsesServer, textResponse} from "./mock-responses-server";

const GATEWAY_MODEL = "gpt-5.6-terra";

function inputTexts(request: unknown): string[] {
    const input = (request as {input?: Array<{type?: string; content?: Array<{text?: string}>}>}).input ?? [];
    return input.flatMap(item => (item.type === "message" ? (item.content ?? []).map(part => part.text ?? "") : [`<${item.type}>`]));
}

describeIntegration("integration: compaction after a thread moves from OpenAI to a gateway", () => {
    it("compacts through the gateway model and keeps the summary in later requests", async () => {
        // Codex cannot change a thread's provider, so this thread stays on the built-in OpenAI provider
        // and Codex asks the gateway for a server-side compaction that only OpenAI implements.
        const openai = await startMockResponsesServer();
        const gateway = await startMockResponsesServer();
        const agent = await createSpawnedAgentFixture(async () => {}, {
            INITIAL_AGENT_MODE: AgentMode.ReadOnly.id,
            // Every OpenAI call of this Codex, including its model list, stays on the mock.
            CODEX_CONFIG: JSON.stringify({openai_base_url: openai.baseUrl}),
        });
        try {
            await agent.connection.request(acp.methods.agent.initialize, {
                protocolVersion: acp.PROTOCOL_VERSION,
                clientCapabilities: {fs: {readTextFile: true, writeTextFile: true}, terminal: true},
                clientInfo: {name: "vitest", version: "1.0.0"},
            });
            await agent.connection.request(acp.methods.agent.authenticate, {methodId: "api-key", _meta: {"api-key": {apiKey: "sk-test-not-real"}}});
            const {sessionId} = await agent.createSession();
            await legacySetSessionModel(agent.connection, {sessionId, modelId: INTEGRATION_MODEL_ID.toString()});
            openai.setResponseHandler(() => textResponse("native answer"));
            await sendPrompt(agent, sessionId, "first question");

            // Like a real gateway, this one serves its own model only and answers every request with text.
            gateway.setResponseHandler(request =>
                (request as {model?: unknown}).model === GATEWAY_MODEL
                    ? textResponse(inputTexts(request).at(-1)!.startsWith("You are performing a CONTEXT CHECKPOINT COMPACTION") ? "HANDOFF-SUMMARY" : "gateway answer")
                    : undefined,
            );
            await agent.connection.request("providers/set", {
                providerId: "openai",
                apiType: "openai",
                baseUrl: gateway.baseUrl,
                _meta: {codex: {id: "one", mode: "catalog", name: "One"}, alwith: {models: [{id: GATEWAY_MODEL, label: "Model A"}]}},
            });
            await agent.connection.request("session/set_config_option", {sessionId, configId: "model", value: `gateway:one:${GATEWAY_MODEL}`});

            expect((await sendPrompt(agent, sessionId, "second question")).stopReason).toBe("end_turn");
            expect((await sendPrompt(agent, sessionId, "/compact")).stopReason).toBe("end_turn");
            expect((await sendPrompt(agent, sessionId, "third question")).stopReason).toBe("end_turn");

            expect(agentText(agent, sessionId)).not.toContain("Error running remote compact task");
            const served = gateway.requests.filter(request => (request as {model?: unknown}).model === GATEWAY_MODEL);
            // The gateway never sees Codex's compaction protocol, only ordinary requests.
            expect(served.flatMap(inputTexts)).not.toContain("<compaction_trigger>");
            expect(served.flatMap(inputTexts)).not.toContain("<compaction>");
            const last = inputTexts(served.at(-1));
            expect(last.at(-1)).toBe("third question");
            expect(last.some(text => text.endsWith("HANDOFF-SUMMARY"))).toBe(true);
        } finally {
            try {
                await agent.dispose();
            } finally {
                await openai.close();
                await gateway.close();
            }
        }
    });
});
