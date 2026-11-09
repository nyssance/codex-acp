// Real Codex processes and isolated homes; only the model endpoints are mocked.
import {expect, it} from "vitest";
import {connectAndLogin, describeIntegration, openSession, sendPrompt, spawnAgent, stopAll} from "./integration-fixture";
import {startMockResponsesServer, textResponse} from "./mock-responses-server";

describeIntegration("integration: switching provider after a failed turn", () => {
    it("resumes the same thread on the gateway and accepts another prompt", async () => {
        const mock = await startMockResponsesServer();
        const agent = await spawnAgent();
        try {
            await connectAndLogin(agent, mock.baseUrl);
            const sessionId = await openSession(agent);
            mock.setErrorResponse({status: 402, body: {error: {message: "Insufficient Balance", type: "insufficient_balance_error"}}});
            await expect(sendPrompt(agent, sessionId, "before provider change")).rejects.toThrow();
            await agent.connection.request("providers/set", {
                providerId: "openai", apiType: "openai", baseUrl: mock.baseUrl,
                _meta: {codex: {id: "one", mode: "catalog", name: "One"}, alwith: {models: [{id: "gpt-5.5", label: "Model A"}]}},
            });
            await agent.connection.request("session/set_config_option", {sessionId, configId: "model", value: "gateway:one:gpt-5.5"});
            mock.setErrorResponse(null);
            mock.setResponseHandler(() => textResponse("provider-recovered"));
            expect((await sendPrompt(agent, sessionId, "after provider change")).stopReason).toBe("end_turn");
            expect(agent.readText(sessionId)).toContain("provider-recovered");
        } finally {
            await stopAll(agent, mock);
        }
    });
});
