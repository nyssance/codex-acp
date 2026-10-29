import { afterEach, describe, expect, it, vi } from "vitest";
import {
    connectSession,
    codexResponse,
    sessionId,
    type PromptSession,
} from "./v2-prompt-harness";
const clients: PromptSession[] = [];
afterEach(() => {
    for (const client of clients.splice(0)) client.connection.close();
});
const provider = (id: string, model: string) => ({
    providerId: "openai",
    apiType: "openai",
    baseUrl: `https://${id}.example/v1`,
    _meta: {
        codex: { id, mode: "catalog", name: id },
        alwith: { models: [{ id: model, label: model }] },
    },
});
async function connect() {
    const client = await connectSession();
    clients.push(client);
    const resumes = vi.fn(async (raw: unknown) => {
        const params = raw as Record<string, unknown>;
        return {
            ...(codexResponse("thread/resume") as object),
            model: params["model"] ?? "gpt-5",
            modelProvider: params["modelProvider"],
        };
    });
    client.setCodexResponse("thread/resume", resumes);
    const original = codexResponse("thread/resume") as {
        thread: Record<string, unknown>;
    };
    client.setCodexResponse("thread/read", async () => ({
        thread: { ...original.thread, status: { type: "idle" } },
    }));
    return { client, resumes };
}
describe("ALwith session-scoped provider catalog", () => {
    it("restores the persisted gateway model without requiring a native account", async () => {
        const { client, resumes } = await connect();
        await client.request("providers/set", provider("one", "model-a"));
        const original = codexResponse("thread/resume") as {
            thread: Record<string, unknown>;
        };
        client.setCodexResponse("thread/read", async () => ({
            thread: {
                ...original.thread,
                modelProvider: "one",
                model: "model-a",
            },
        }));
        client.setCodexResponse("account/read", async () => ({
            account: null,
            requiresOpenaiAuth: true,
        }));
        await client.agent.loadSession({
            sessionId,
            cwd: "/workspace",
            mcpServers: [],
        });
        expect(resumes).toHaveBeenLastCalledWith(
            expect.objectContaining({ modelProvider: "one", model: "model-a" }),
        );
    });
    it("passes the persisted native model when restoring a catalog session", async () => {
        const { client, resumes } = await connect();
        await client.request("providers/set", provider("one", "model-a"));
        const original = codexResponse("thread/resume") as {
            thread: Record<string, unknown>;
        };
        client.setCodexResponse("thread/read", async () => ({
            thread: {
                ...original.thread,
                modelProvider: "openai",
                model: "gpt-5",
            },
        }));
        await client.agent.loadSession({
            sessionId,
            cwd: "/workspace",
            mcpServers: [],
        });
        expect(resumes).toHaveBeenLastCalledWith(
            expect.objectContaining({
                modelProvider: "openai",
                model: "gpt-5",
            }),
        );
    });
    it("registers multiple gateways without restarting or rerouting native sessions", async () => {
        const { client, resumes } = await connect();
        await client.request("providers/set", provider("one", "model-a"));
        await client.request("providers/set", provider("two", "model-b"));
        const response = await client.request("providers/list", {});
        expect(
            response.providers[0]._meta.codex.gateways.map(
                (gateway: { id: string }) => gateway.id,
            ),
        ).toEqual(["one", "two"]);
        expect(
            client.agent
                .getSessionState(sessionId)
                .availableModels.map((model) => model.id),
        ).toEqual(["gpt-5", "gateway:one:model-a", "gateway:two:model-b"]);
        expect(resumes).not.toHaveBeenCalled();
    });
    it("moves only the selected session and sends the upstream model ID", async () => {
        const { client, resumes } = await connect();
        await client.request("providers/set", provider("one", "model-a"));
        await client.request("session/set_config_option", {
            sessionId,
            configId: "model",
            type: "id",
            value: "gateway:one:model-a",
        });
        expect(resumes).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
                threadId: sessionId,
                model: "model-a",
                modelProvider: "one",
                config: expect.objectContaining({
                    model_providers: expect.objectContaining({
                        one: expect.objectContaining({
                            base_url: expect.stringMatching(
                                /^http:\/\/127\.0\.0\.1:/,
                            ),
                        }),
                    }),
                }),
            }),
        );
        expect(client.agent.getSessionState(sessionId).currentModelId).toBe(
            "gateway:one:model-a[medium]",
        );
        await client.request("session/set_config_option", {
            sessionId,
            configId: "model",
            type: "id",
            value: "gpt-5",
        });
        expect(resumes).toHaveBeenLastCalledWith(
            expect.objectContaining({
                model: "gpt-5",
                modelProvider: "openai",
            }),
        );
    });
    it("routes away from a persisted gateway even when its model is absent from the catalog", async () => {
        const { client, resumes } = await connect();
        await client.request("providers/set", provider("one", "model-a"));
        const original = codexResponse("thread/resume") as {
            thread: Record<string, unknown>;
        };
        client.setCodexResponse("thread/read", async () => ({
            thread: {
                ...original.thread,
                modelProvider: "one",
                model: "gpt-5",
                status: { type: "idle" },
            },
        }));
        await client.agent.loadSession({
            sessionId,
            cwd: "/workspace",
            mcpServers: [],
        });
        resumes.mockClear();
        await client.request("session/set_config_option", {
            sessionId,
            configId: "model",
            type: "id",
            value: "gpt-5",
        });
        expect(resumes).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
                model: "gpt-5",
                modelProvider: "openai",
            }),
        );
    });
    it("rebuilds the connection when native resume ignores a provider switch", async () => {
        const { client, resumes } = await connect();
        await client.request("providers/set", provider("one", "model-a"));
        resumes.mockResolvedValueOnce({
            ...(codexResponse("thread/resume") as object),
            model: "gpt-5",
            modelProvider: "openai",
        });
        const replace = vi
            .spyOn(client.agent as any, "replaceProviderConnection")
            .mockResolvedValue(undefined);
        await client.request("session/set_config_option", {
            sessionId,
            configId: "model",
            type: "id",
            value: "gateway:one:model-a",
        });
        expect(replace).toHaveBeenCalledExactlyOnceWith(
            expect.any(Function),
            new Map([[sessionId, "gateway:one:model-a"]]),
        );
        expect(client.agent.getSessionState(sessionId).currentModelId).toBe(
            "gateway:one:model-a[medium]",
        );
    });
    it("rolls back a failed switch and keeps the previous selection", async () => {
        const { client, resumes } = await connect();
        await client.request("providers/set", provider("one", "model-a"));
        resumes.mockRejectedValueOnce(new Error("Gateway unavailable"));
        await expect(
            client.request("session/set_config_option", {
                sessionId,
                configId: "model",
                type: "id",
                value: "gateway:one:model-a",
            }),
        ).rejects.toThrow("Gateway unavailable");
        expect(resumes).toHaveBeenCalledTimes(2);
        expect(resumes).toHaveBeenLastCalledWith(
            expect.objectContaining({
                model: "gpt-5",
                modelProvider: "openai",
            }),
        );
        expect(client.agent.getSessionState(sessionId).currentModelId).toBe(
            "gpt-5[medium]",
        );
    });
});
