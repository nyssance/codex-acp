import {afterEach, describe, expect, it, vi} from "vitest";
import {
    connectSession,
    sessionId,
    turnId,
    createTurn,
    turnStarted,
    itemCompleted,
    userMessageItem,
    turnCompleted,
    type PromptSession,
} from "./v2-prompt-harness";
type ConfigSnapshot = {configRevision: number; configOptions: Array<{configId: string; currentValue: unknown}>};
function configSnapshot(client: PromptSession): ConfigSnapshot {
    const agent = client.agent as unknown as {configSnapshot(session: unknown): ConfigSnapshot};
    return agent.configSnapshot(client.agent.getSessionState(sessionId));
}
const clients: PromptSession[] = [];
afterEach(() => {
    for (const client of clients.splice(0)) client.connection.close();
});
async function connect() {
    const client = await connectSession();
    clients.push(client);
    return client;
}
describe("ALwith configuration revisions", () => {
    it("keeps a stable revision until advertised options change and rejects stale prompts", async () => {
        const client = await connect();
        const first = configSnapshot(client);
        expect(first.configRevision).toBe(0);
        expect(configSnapshot(client)).toEqual(first);
        const changed = await client.request("session/set_config_option", {
            sessionId,
            configId: "mode",
            type: "id",
            value: "read-only",
        });
        expect(changed._meta.alwith.configRevision).toBe(1);
        const snapshot = configSnapshot(client);
        expect(snapshot.configRevision).toBe(1);
        expect(snapshot.configOptions.find((option: {configId: string}) => option.configId === "mode")!.currentValue).toBe("read-only");
        await expect(
            client.request("session/prompt", {
                sessionId,
                prompt: [{type: "text", text: "go"}],
                _meta: {alwith: {expectedConfigRevision: 0}},
            }),
        ).rejects.toMatchObject({
            message: expect.stringContaining("config/stale"),
            data: {alwith: {configStale: {expected: 0, actual: 1}}},
        });
        expect(client.turnStartParams).toHaveLength(0);
        const unchanged = await client.request("session/set_config_option", {
            sessionId,
            configId: "mode",
            type: "id",
            value: "read-only",
        });
        expect(unchanged._meta.alwith.configRevision).toBe(1);
    });
    it("releases a refused prompt's queue slot and preserves host message identity", async () => {
        const client = await connect();
        await expect(
            client.request("session/prompt", {
                sessionId,
                prompt: [{type: "text", text: "bad"}],
                _meta: {alwith: {expectedConfigRevision: 12}},
            }),
        ).rejects.toThrow("config/stale");
        client.setTurnStart(async () => ({
            turn: createTurn("inProgress", turnId),
        }));
        const response = client.request("session/prompt", {
            sessionId,
            prompt: [{type: "text", text: "good"}],
            _meta: {
                alwith: {
                    expectedConfigRevision: 0,
                    messageId: "host-message",
                },
            },
        });
        await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(1));
        expect(client.turnStartParams[0]!["clientUserMessageId"]).toBe("host-message");
        client.emit(turnStarted());
        client.emit(itemCompleted(userMessageItem("host-message")));
        await response;
        client.emit(turnCompleted());
        await client.promptRunFinished();
    });
});
