// Real codex-acp + real `codex app-server`; only the model is a local mock.
import {afterEach, beforeEach, expect, it} from "vitest";
import type {SpawnedAgentFixture} from "../CodexACPAgent/e2e/spawned-agent-fixture";
import {connectAndLogin, describeIntegration, openSession, sendPrompt, spawnAgent, stopAll} from "./integration-fixture";
import {type MockResponsesServer, startMockResponsesServer} from "./mock-responses-server";

describeIntegration("integration: an exhausted balance reported as HTTP 402", () => {
    let mock: MockResponsesServer;
    let agent: SpawnedAgentFixture;
    let sessionId: string;

    beforeEach(async () => {
        mock = await startMockResponsesServer();
        agent = await spawnAgent();
        await connectAndLogin(agent, mock.baseUrl);
        sessionId = await openSession(agent);
    });

    afterEach(async () => {
        await stopAll(agent, mock);
    });

    /**
     * Scenario: the provider answers the turn with DeepSeek's 402 "Insufficient Balance".
     * Expected:
     * - Codex reports a usage limit, not a connection failure;
     * - the error names the provider host, the 402 and the provider's message;
     * - Codex does not retry the request.
     */
    it("ends the turn with a usage-limit error that names the provider's 402", async () => {
        mock.setErrorResponse({
            status: 402,
            // As DeepSeek answered on 2026-11-05; the same shape passed against the live API.
            body: {
                error: {
                    message: "Insufficient Balance (request_id: 944e5925)",
                    type: "insufficient_balance_error",
                    param: null,
                    code: "invalid_request_error",
                },
            },
        });
        const failure = await sendPrompt(agent, sessionId, "hello").then(
            () => null,
            (error: unknown) => error as {data?: {message?: string; codexErrorInfo?: unknown}},
        );
        expect(failure?.data).toMatchObject({
            codexErrorInfo: "usageLimitExceeded",
            message: expect.stringContaining("127.0.0.1 returned HTTP 402 Payment Required: Insufficient Balance"),
        });
        expect(mock.requests).toHaveLength(1);
    });
});
