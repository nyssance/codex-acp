import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterAll, afterEach, describe, expect, it, vi} from "vitest";
import {
    connectSession,
    codexResponse,
    sessionId,
    type PromptSession,
    createTurn,
    turnId,
    userMessageItem,
    itemStarted,
    itemCompleted,
} from "./v2-prompt-harness";
const clients: PromptSession[] = [];
afterEach(() => {
    for (const client of clients.splice(0)) client.connection.close();
});
const catalogDirectory = mkdtempSync(join(tmpdir(), "codex-acp-catalog-"));
afterAll(() => rmSync(catalogDirectory, {recursive: true, force: true}));
function catalogFile(model: string): string {
    const path = join(catalogDirectory, `${model}.json`);
    writeFileSync(
        path,
        JSON.stringify({
            models: [
                {
                    slug: model,
                    supported_reasoning_levels: [{effort: "medium", description: "Medium"}],
                    default_reasoning_level: "medium",
                },
            ],
        }),
    );
    return path;
}
const provider = (id: string, model: string) => ({
    providerId: "openai",
    apiType: "openai",
    baseUrl: `https://${id}.example/v1`,
    _meta: {
        codex: {
            id,
            mode: "catalog",
            name: id,
            config: {model_catalog_json: catalogFile(model)},
        },
        alwith: {models: [{id: model, label: model}]},
    },
});
async function connect(protocolVersion: 1 | 2 = 2) {
    const client = await connectSession(protocolVersion);
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
        thread: {...original.thread, status: {type: "idle"}},
    }));
    return {client, resumes};
}
describe("ALwith session-scoped provider catalog", () => {
    it("restores the persisted gateway model without requiring a native account", async () => {
        const {client, resumes} = await connect();
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
            expect.objectContaining({
                modelProvider: "one",
                model: "gateway:one:model-a",
            }),
        );
    });
    it("passes the persisted native model when restoring a catalog session", async () => {
        const {client, resumes} = await connect();
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
                model: "native:gpt-5",
            }),
        );
    });
    it("registers multiple gateways without restarting or rerouting native sessions", async () => {
        const {client, resumes} = await connect();
        await client.request("providers/set", provider("one", "model-a"));
        await client.request("providers/set", provider("two", "model-b"));
        const response = await client.request("providers/list", {});
        expect(response.providers[0]._meta.codex.gateways.map((gateway: {id: string}) => gateway.id)).toEqual(["one", "two"]);
        expect(client.agent.getSessionState(sessionId).availableModels.map(model => model.id)).toEqual([
            "gpt-5",
            "gateway:one:model-a",
            "gateway:two:model-b",
        ]);
        expect(resumes).not.toHaveBeenCalled();
    });
    it("moves only the logical route and persists the full selection with a fixed native provider", async () => {
        const {client, resumes} = await connect();
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
                model: "gateway:one:model-a",
                modelProvider: "openai",
                config: expect.objectContaining({
                    model_providers: {},
                    openai_base_url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:/),
                }),
            }),
        );
        expect(client.agent.getSessionState(sessionId).currentModelId).toBe("gateway:one:model-a[medium]");
        await client.request("session/set_config_option", {
            sessionId,
            configId: "model",
            type: "id",
            value: "gpt-5",
        });
        expect(resumes).toHaveBeenLastCalledWith(
            expect.objectContaining({
                model: "native:gpt-5",
                modelProvider: "openai",
            }),
        );
    });
    it("routes away from a persisted gateway even when its model is absent from the catalog", async () => {
        const {client, resumes} = await connect();
        await client.request("providers/set", provider("one", "model-a"));
        const original = codexResponse("thread/resume") as {
            thread: Record<string, unknown>;
        };
        client.setCodexResponse("thread/read", async () => ({
            thread: {
                ...original.thread,
                modelProvider: "one",
                model: "gpt-5",
                status: {type: "idle"},
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
                model: "native:gpt-5",
                modelProvider: "one",
            }),
        );
    });
    it("rebuilds the connection when native resume ignores a provider switch", async () => {
        const {client, resumes} = await connect();
        await client.request("providers/set", provider("one", "model-a"));
        resumes.mockResolvedValueOnce({
            ...(codexResponse("thread/resume") as object),
            model: "gpt-5",
            modelProvider: "openai",
        });
        const replace = vi.spyOn(client.agent as any, "replaceProviderConnection").mockResolvedValue(undefined);
        await client.request("session/set_config_option", {
            sessionId,
            configId: "model",
            type: "id",
            value: "gateway:one:model-a",
        });
        expect(replace).toHaveBeenCalledExactlyOnceWith(expect.any(Function), new Map([[sessionId, "gateway:one:model-a"]]));
        expect(client.agent.getSessionState(sessionId).currentModelId).toBe("gateway:one:model-a[medium]");
    });
    it("rolls back a failed switch and keeps the previous selection", async () => {
        const {client, resumes} = await connect();
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
                model: "native:gpt-5",
                modelProvider: "openai",
            }),
        );
        expect(client.agent.getSessionState(sessionId).currentModelId).toBe("gpt-5[medium]");
    });
});

it("switches the logical gateway while retaining the Codex thread provider and session id", async () => {
    const {client, resumes} = await connect();
    await client.request("providers/set", provider("one", "model-a"));
    await client.request("providers/set", provider("two", "model-b"));
    const original = codexResponse("thread/resume") as {
        thread: Record<string, unknown>;
    };
    client.setCodexResponse("thread/read", async () => ({
        thread: {
            ...original.thread,
            modelProvider: "one",
            model: "model-a",
            status: {type: "idle"},
        },
    }));
    await client.agent.loadSession({
        sessionId,
        cwd: "/workspace",
        mcpServers: [],
    });
    await client.request("session/set_config_option", {
        sessionId,
        configId: "model",
        type: "id",
        value: "gateway:two:model-b",
    });
    expect(resumes).toHaveBeenLastCalledWith(
        expect.objectContaining({
            threadId: sessionId,
            modelProvider: "one",
            model: "gateway:two:model-b",
        }),
    );
    expect(client.agent.getSessionState(sessionId).currentModelId).toBe("gateway:two:model-b[medium]");
});

it.each([1, 2] as const)("restores and sends native catalog history after removing the last unused gateway (v%s)", async protocol => {
    const {client, resumes} = await connect(protocol);
    await client.request("providers/set", provider("one", "model-a"));
    const original = codexResponse("thread/resume") as {
        thread: Record<string, unknown>;
    };
    client.setCodexResponse("thread/read", async () => ({
        thread: {
            ...original.thread,
            model: "native:gpt-5",
            modelProvider: "one",
        },
    }));
    await client.agent.loadSession({
        sessionId,
        cwd: "/workspace",
        mcpServers: [],
    });
    await client.request("providers/disable", {providerId: "openai"});
    await client.agent.loadSession({
        sessionId,
        cwd: "/workspace",
        mcpServers: [],
    });
    expect(resumes).toHaveBeenLastCalledWith(
        expect.objectContaining({
            modelProvider: "one",
            model: "native:gpt-5",
            config: expect.objectContaining({
                model_catalog_json: expect.any(String),
                model_providers: expect.objectContaining({
                    one: expect.objectContaining({
                        requires_openai_auth: true,
                    }),
                }),
            }),
        }),
    );
    const prompt = client.sendPrompt([{type: "text", text: "Continue"}]);
    await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(1));
    expect(client.turnStartParams[0]?.["model"]).toBe("native:gpt-5");
    const clientId = client.turnStartParams[0]?.["clientUserMessageId"];
    const item = userMessageItem(typeof clientId === "string" ? clientId : null, "Continue");
    client.emit(itemStarted(item));
    client.emit(itemCompleted(item));
    client.emit({
        method: "turn/completed",
        params: {
            threadId: sessionId,
            turn: createTurn("completed", turnId),
        },
    });
    await prompt;
    await client.promptRunFinished();
});

it.each([1, 2] as const)("recovers catalog history in a fresh adapter without registered gateways (v%s)", async protocol => {
    const {client, resumes} = await connect(protocol);
    const original = codexResponse("thread/resume") as {
        thread: Record<string, unknown>;
    };
    client.setCodexResponse("thread/read", async () => ({
        thread: {
            ...original.thread,
            model: "native:gpt-5",
            modelProvider: "one",
        },
    }));
    resumes.mockImplementation(async raw => {
        const params = raw as Record<string, unknown>;
        if (params["modelProvider"] !== "one") {
            throw new Error(
                "This chat uses model provider “one”, which is no longer configured. Restore this provider configuration to continue.",
            );
        }
        return {
            ...(codexResponse("thread/resume") as object),
            model: params["model"] ?? "gpt-5",
            modelProvider: "one",
        };
    });
    await client.agent.loadSession({
        sessionId,
        cwd: "/workspace",
        mcpServers: [],
    });
    expect(resumes).toHaveBeenCalledTimes(2);
    expect(resumes).toHaveBeenLastCalledWith(
        expect.objectContaining({
            modelProvider: "one",
            model: "native:gpt-5",
        }),
    );
});

describe("ALwith providers/set validation", () => {
    const invalid = async (change: (request: ReturnType<typeof provider>) => unknown) => {
        const {client} = await connect();
        const request = provider("one", "model-a");
        const changed = change(request) ?? request;
        await expect(client.request("providers/set", changed)).rejects.toThrow();
        const listed = (await client.request("providers/list", {})) as {
            providers: Array<{_meta?: unknown}>;
        };
        expect(listed.providers[0]!._meta).toBeUndefined();
    };

    it("rejects a gateway without an id", () =>
        invalid(request => {
            delete (request._meta.codex as {id?: string}).id;
        }));

    it("rejects a gateway without a name", () =>
        invalid(request => {
            delete (request._meta.codex as {name?: string}).name;
        }));

    it("rejects an Anthropic gateway without an API key", () => invalid(request => ({...request, apiType: "anthropic"})));

    it("rejects a protocol the adapter cannot translate", () => invalid(request => ({...request, apiType: "vertex"})));

    it("registers an Anthropic gateway that carries its API key", async () => {
        const {client} = await connect();
        const request = provider("claude", "model-a");
        await client.request("providers/set", {...request, apiType: "anthropic", _meta: {...request._meta, codex: {...request._meta.codex, bearerToken: "sk-ant-test"}}});
        const listed = (await client.request("providers/list", {})) as {providers: Array<{supported: string[]; _meta?: {codex?: {gateway?: {id: string}}}}>};
        expect(listed.providers[0]!.supported).toEqual(["openai", "anthropic"]);
        expect(listed.providers[0]!._meta?.codex?.gateway?.id).toBe("claude");
    });

    it("rejects a model without a label", () =>
        invalid(request => ({
            ...request,
            _meta: {...request._meta, alwith: {models: [{id: "model-a"}]}},
        })));

    it("rejects a model that neither the catalog file nor Codex describes", () =>
        invalid(request => ({
            ...request,
            _meta: {
                ...request._meta,
                alwith: {models: [{id: "unknown-model", label: "Unknown"}]},
            },
        })));

    it("rejects a catalog entry without a slug", () =>
        invalid(request => {
            const path = join(catalogDirectory, "bad.json");
            writeFileSync(path, JSON.stringify({models: [{supported_reasoning_levels: []}]}));
            request._meta.codex.config.model_catalog_json = path;
        }));
});
