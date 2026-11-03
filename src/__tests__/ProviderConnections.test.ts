import { PassThrough } from "node:stream";
import { afterEach, expect, test, vi } from "vitest";
import {
    createMessageConnection,
    StreamMessageReader,
    StreamMessageWriter,
    type MessageConnection,
} from "vscode-jsonrpc/node";
import { providerConnections } from "../ProviderConnections";

const dispose: (() => void)[] = [];
afterEach(() => {
    for (const close of dispose.splice(0)) close();
});

function server(
    provider: string,
    reload: () => Promise<Record<string, never>> = async () => ({}),
): MessageConnection {
    const input = new PassThrough();
    const output = new PassThrough();
    const client = createMessageConnection(
        new StreamMessageReader(output),
        new StreamMessageWriter(input),
    );
    const host = createMessageConnection(
        new StreamMessageReader(input),
        new StreamMessageWriter(output),
    );
    const threads = new Set<string>();
    host.onRequest("initialize", () => ({ userAgent: "probe" }));
    host.onRequest("config/read", () => ({
        config: { model_provider: provider },
    }));
    host.onRequest("thread/start", (params: { modelProvider: string }) => {
        const id = `${params.modelProvider}-${threads.size}`;
        threads.add(id);
        return { thread: { id }, modelProvider: params.modelProvider };
    });
    host.onRequest(
        "thread/resume",
        (params: { threadId: string; modelProvider: string }) => {
            threads.add(params.threadId);
            return {
                thread: { id: params.threadId },
                modelProvider: params.modelProvider,
            };
        },
    );
    host.onRequest(
        "thread/fork",
        (params: { threadId: string; modelProvider: string }) => {
            const id = `${params.modelProvider}-${threads.size}`;
            threads.add(id);
            return { thread: { id }, modelProvider: params.modelProvider };
        },
    );
    host.onRequest("test/unload", async (params: { threadId: string }) => {
        threads.delete(params.threadId);
        await host.sendNotification("thread/status/changed", {
            threadId: params.threadId,
            status: { type: "notLoaded" },
        });
        return {};
    });
    host.onRequest("thread/unsubscribe", (params: { threadId: string }) => {
        threads.delete(params.threadId);
        return { status: "notLoaded" };
    });
    host.onRequest("thread/loaded/list", () => ({
        data: [...threads],
        nextCursor: null,
    }));
    host.onRequest("config/mcpServer/reload", reload);
    host.onRequest("test/ask", () =>
        host.sendRequest("approval", { provider }),
    );
    host.onRequest("turn/start", (params: { threadId: string }) => {
        if (
            !threads.has(params.threadId) ||
            !params.threadId.startsWith(`${provider}-`)
        )
            throw new Error(`Wrong provider process: ${provider}`);
        return { turn: { id: `${params.threadId}-turn` } };
    });
    client.listen();
    host.listen();
    dispose.push(() => {
        client.dispose();
        host.dispose();
        input.destroy();
        output.destroy();
    });
    return client;
}

test("gateway and native turns use their own provider processes concurrently", async () => {
    const spawned: string[] = [];
    const connection = providerConnections(server("openai"), (provider) => {
        spawned.push(provider);
        return server(provider);
    });
    await connection.sendRequest("initialize", {
        clientInfo: { name: "test", version: "1" },
    });
    await connection.sendNotification("initialized", {});
    const [gateway, native] = await Promise.all([
        connection.sendRequest<{ thread: { id: string } }>("thread/start", {
            modelProvider: "litellm",
        }),
        connection.sendRequest<{ thread: { id: string } }>("thread/start", {
            modelProvider: "openai",
        }),
    ]);
    const turns = await Promise.all(
        [gateway, native].map(({ thread }) =>
            connection.sendRequest("turn/start", { threadId: thread.id }),
        ),
    );
    expect(turns).toEqual([
        { turn: { id: "litellm-0-turn" } },
        { turn: { id: "openai-0-turn" } },
    ]);
    expect(spawned).toEqual(["litellm"]);
});

test("one child is shared by simultaneous opens and loaded threads include every process", async () => {
    const providers: string[] = [];
    const connection = providerConnections(server("openai"), (id) => {
        providers.push(id);
        return server(id);
    });
    await connection.sendRequest("initialize", {});
    const threads = await Promise.all(
        ["litellm", "litellm", "deepseek", "openai"].map((modelProvider) =>
            connection.sendRequest<{ thread: { id: string } }>("thread/start", {
                modelProvider,
            }),
        ),
    );
    expect(providers).toEqual(["litellm", "deepseek"]);
    const loaded = await connection.sendRequest<{ data: string[] }>(
        "thread/loaded/list",
        {},
    );
    expect(loaded.data.sort()).toEqual(
        threads.map((entry) => entry.thread.id).sort(),
    );
    connection.dispose();
});

test("approval handlers registered after a child starts are attached and disposed on that child", async () => {
    let child: MessageConnection | undefined;
    const connection = providerConnections(server("openai"), (id) => {
        child = server(id);
        return child;
    });
    await connection.sendRequest("initialize", {});
    await connection.sendRequest("thread/start", { modelProvider: "litellm" });
    const handler = connection.onRequest("approval", () => "approved");
    expect(await child!.sendRequest("test/ask", {})).toBe("approved");
    handler.dispose();
    await expect(child!.sendRequest("test/ask", {})).rejects.toThrow(
        "Unhandled method approval",
    );
    connection.dispose();
});

test("disposing the routed connection also disposes its child connections", async () => {
    const child = server("litellm");
    const closed = vi.spyOn(child, "dispose");
    const connection = providerConnections(server("openai"), () => child);
    await connection.sendRequest("initialize", {});
    await connection.sendRequest("thread/start", { modelProvider: "litellm" });
    connection.dispose();
    await Promise.resolve();
    expect(closed).toHaveBeenCalledOnce();
});

test("resumed and forked gateway histories keep their owning provider connection", async () => {
    const connection = providerConnections(server("openai"), (id) =>
        server(id),
    );
    await connection.sendRequest("initialize", {});
    await connection.sendRequest("thread/resume", {
        threadId: "litellm-history",
        modelProvider: "litellm",
    });
    const fork = await connection.sendRequest<{ thread: { id: string } }>(
        "thread/fork",
        { threadId: "litellm-history", modelProvider: "litellm" },
    );
    expect(
        await connection.sendRequest("turn/start", {
            threadId: "litellm-history",
        }),
    ).toEqual({ turn: { id: "litellm-history-turn" } });
    expect(
        await connection.sendRequest("turn/start", {
            threadId: fork.thread.id,
        }),
    ).toEqual({ turn: { id: "litellm-1-turn" } });
    connection.dispose();
});

test("loaded thread pages respect the global limit across provider processes", async () => {
    const connection = providerConnections(server("openai"), (id) =>
        server(id),
    );
    await connection.sendRequest("initialize", {});
    await connection.sendRequest("thread/start", { modelProvider: "litellm" });
    await connection.sendRequest("thread/start", { modelProvider: "openai" });
    const first = await connection.sendRequest<{
        data: string[];
        nextCursor: string;
    }>("thread/loaded/list", { limit: 1 });
    const second = await connection.sendRequest<{
        data: string[];
        nextCursor: null;
    }>("thread/loaded/list", { limit: 1, cursor: first.nextCursor });
    expect(first.data).toEqual(["litellm-0"]);
    expect(second).toEqual({ data: ["openai-0"], nextCursor: null });
    connection.dispose();
});

test("inherits native provider definitions and isolates explicitly supplied gateway definitions", async () => {
    const spawns: unknown[][] = [];
    const connection = providerConnections(
        server("native-custom"),
        (...args) => {
            spawns.push(args);
            return server(args[0]);
        },
    );
    await connection.sendRequest("initialize", {});
    await connection.sendRequest("thread/start", {
        modelProvider: "native-custom",
        config: { model_catalog_json: "/catalog" },
    });
    await connection.sendRequest("thread/start", {
        modelProvider: "native-custom",
        config: {
            model_catalog_json: "/catalog",
            model_providers: {
                "native-custom": { base_url: "http://127.0.0.1" },
            },
        },
    });
    expect(spawns).toEqual([
        ["native-custom", "/catalog", false],
        ["native-custom", "/catalog", true],
    ]);
});

test("MCP reconnect refreshes loaded gateway processes as well as primary", async () => {
    const refreshed = new Set<string>();
    const make = (id: string) =>
        server(id, async () => {
            refreshed.add(id);
            return {};
        });
    const connection = providerConnections(make("openai"), make);
    await connection.sendRequest("initialize", {});
    await connection.sendRequest("thread/start", { modelProvider: "gateway" });
    await connection.sendRequest("config/mcpServer/reload");
    expect([...refreshed].sort()).toEqual(["gateway", "openai"]);
    connection.dispose();
});

test("MCP reconnect completes other refreshes before propagating a failure", async () => {
    let gatewayRefreshed = false;
    const connection = providerConnections(
        server("openai", async () => {
            throw new Error("Policy rejected");
        }),
        (id) =>
            server(id, async () => {
                await new Promise<void>((resolve) => setImmediate(resolve));
                gatewayRefreshed = true;
                return {};
            }),
    );
    await connection.sendRequest("initialize", {});
    await connection.sendRequest("thread/start", { modelProvider: "gateway" });
    await expect(
        connection.sendRequest("config/mcpServer/reload"),
    ).rejects.toThrow("Policy rejected");
    expect(gatewayRefreshed).toBe(true);
    connection.dispose();
});

test.each([undefined, "/original-catalog"])(
    "reload resumes the existing writer after catalog changes from %s",
    async (catalog) => {
        const spawned: unknown[][] = [];
        const connection = providerConnections(
            server("openai"),
            (id, path, defined) => {
                spawned.push([id, path, defined]);
                return server(id);
            },
        );
        await connection.sendRequest("initialize", {});
        const original = await connection.sendRequest<{
            thread: { id: string };
        }>("thread/start", {
            modelProvider: "openai",
            ...(catalog ? { config: { model_catalog_json: catalog } } : {}),
        });
        const previousSpawns = spawned.length;
        for (const modelProvider of [
            "openai",
            "different-requested-provider",
        ]) {
            await connection.sendRequest("thread/resume", {
                threadId: original.thread.id,
                modelProvider,
                config: {
                    model_catalog_json: "/updated-catalog",
                    model_providers: {
                        [modelProvider]: { base_url: "http://127.0.0.1" },
                    },
                },
            });
            expect(
                await connection.sendRequest("turn/start", {
                    threadId: original.thread.id,
                }),
            ).toEqual({ turn: { id: `${original.thread.id}-turn` } });
        }
        expect(spawned).toHaveLength(previousSpawns);
        connection.dispose();
    },
);

test.each(["test/unload", "thread/unsubscribe"])(
    "a released writer can resume on the current catalog after %s",
    async (release) => {
        const paths: (string | undefined)[] = [];
        const connection = providerConnections(server("openai"), (id, path) => {
            paths.push(path);
            return server(id);
        });
        await connection.sendRequest("initialize", {});
        const { thread } = await connection.sendRequest<{
            thread: { id: string };
        }>("thread/start", {
            modelProvider: "openai",
            config: { model_catalog_json: "/before" },
        });
        await connection.sendRequest(release, { threadId: thread.id });
        await connection.sendRequest("thread/resume", {
            threadId: thread.id,
            modelProvider: "openai",
            config: { model_catalog_json: "/after" },
        });
        expect(paths).toEqual(["/before", "/after"]);
        connection.dispose();
    },
);
