// One real Codex process and isolated homes; only the model endpoints are mocked.
import {expect, it} from "vitest";
import {connectAndLogin, describeIntegration, INTEGRATION_MODEL_ID, openSession, sendPrompt, spawnAgent, stopAll} from "./integration-fixture";
import {startMockResponsesServer, textResponse} from "./mock-responses-server";

describeIntegration("integration: one chat moving between providers", () => {
    it("sends each turn to the provider selected for it, there and back", async () => {
        const native = await startMockResponsesServer();
        const one = await startMockResponsesServer();
        const two = await startMockResponsesServer();
        native.setResponseHandler(() => textResponse("from-native"));
        one.setResponseHandler(() => textResponse("from-one"));
        two.setResponseHandler(() => textResponse("from-two"));
        const agent = await spawnAgent();
        try {
            await connectAndLogin(agent, native.baseUrl);
            const sessionId = await openSession(agent);
            for (const [id, mock] of [["one", one], ["two", two]] as const) {
                await agent.connection.request("providers/set", {
                    providerId: "openai",
                    apiType: "openai",
                    baseUrl: mock.baseUrl,
                    _meta: {codex: {id, mode: "catalog", name: id}, alwith: {models: [{id: "gpt-5.5", label: `Model ${id}`}]}},
                });
            }
            const select = (value: string) => agent.connection.request("session/set_config_option", {sessionId, configId: "model", value});
            const servers = {native, one, two};
            // Title and suggestion requests go to the native provider on their own, so a turn is found by its text.
            const turn = async (text: string, expected: keyof typeof servers) => {
                expect((await sendPrompt(agent, sessionId, text)).stopReason).toBe("end_turn");
                const received = Object.entries(servers)
                    .filter(([, mock]) => mock.requests.some(request => JSON.stringify(request).includes(text)))
                    .map(([name]) => name);
                expect(received).toEqual([expected]);
            };

            await turn("first, on the native provider", "native");
            await select("gateway:one:gpt-5.5");
            await turn("second, on gateway one", "one");
            await select("gateway:two:gpt-5.5");
            await turn("third, on gateway two", "two");
            await select("gateway:one:gpt-5.5");
            await turn("fourth, back on gateway one", "one");
            await select(INTEGRATION_MODEL_ID.model);
            await turn("fifth, back on the native provider", "native");

            // The same conversation all along: the last request carries every earlier turn.
            const last = JSON.stringify(native.requests.findLast(request => JSON.stringify(request).includes("fifth, back on the native provider")));
            for (const text of ["first, on the native provider", "second, on gateway one", "third, on gateway two", "fourth, back on gateway one"]) {
                expect(last).toContain(text);
            }
            expect(native.unexpectedRequests + one.unexpectedRequests + two.unexpectedRequests).toBe(0);
        } finally {
            await stopAll(agent, native);
            await one.close();
            await two.close();
        }
    });
});
