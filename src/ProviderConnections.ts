import type {Disposable, MessageConnection} from "vscode-jsonrpc/node";
import {isRecord} from "./permissions/json";

const registrations = new Set(["onRequest", "onNotification", "onUnhandledNotification", "onProgress"]);
const opening = new Set(["thread/start", "thread/resume", "thread/fork"]);

/** Keep Codex's process provider fixed while retaining the ACP session namespace. */
export function providerConnections(
    primary: MessageConnection,
    spawn: (provider: string, catalog?: string, defined?: boolean) => MessageConnection,
): MessageConnection {
    const children = new Map<string, Promise<MessageConnection>>();
    const owners = new Map<string, MessageConnection>();
    const handlers = new Set<{
        method: string;
        args: unknown[];
        disposables: Disposable[];
    }>();
    let initialization: unknown[] | undefined;
    let nativeProvider: Promise<string> | undefined;
    let disposed = false;

    function register(connection: MessageConnection, method: string, args: unknown[]): Disposable {
        return Reflect.apply(Reflect.get(connection, method), connection, args) as Disposable;
    }

    function observe(connection: MessageConnection): void {
        connection.onUnhandledNotification(notification => {
            if (!isRecord(notification.params)) return;
            const method = notification["method"];
            if (method === "thread/started") {
                const thread = notification.params["thread"];
                if (isRecord(thread) && typeof thread["id"] === "string") owners.set(thread["id"], connection);
                return;
            }
            const threadId = notification.params["threadId"];
            const status = notification.params["status"];
            if (
                typeof threadId === "string" &&
                owners.get(threadId) === connection &&
                (method === "thread/closed" || (method === "thread/status/changed" && isRecord(status) && status["type"] === "notLoaded"))
            )
                owners.delete(threadId);
        });
    }
    observe(primary);

    async function provider(id: string, catalog?: string, defined = false): Promise<MessageConnection> {
        nativeProvider ??= primary
            .sendRequest<{config: {model_provider?: string | null}}>("config/read", {includeLayers: false})
            .then(response => response.config.model_provider ?? "openai");
        if (id === (await nativeProvider) && catalog === undefined) return primary;
        const key = JSON.stringify([id, catalog ?? null, defined]);
        let pending = children.get(key);
        if (pending === undefined) {
            pending = (async () => {
                if (disposed) throw new Error("Codex connection is disposed");
                if (initialization === undefined) throw new Error("Codex has not been initialized");
                const child = spawn(id, catalog, defined);
                observe(child);
                for (const handler of handlers) handler.disposables.push(register(child, handler["method"], handler.args));
                try {
                    await Reflect.apply(child.sendRequest, child, initialization);
                    await child.sendNotification("initialized", {});
                    if (disposed) throw new Error("Codex connection was disposed during provider startup");
                    return child;
                } catch (error) {
                    child.dispose();
                    throw error;
                }
            })();
            children.set(key, pending);
            void pending.catch(() => {
                if (children.get(key) === pending) children.delete(key);
            });
        }
        return pending;
    }

    async function request(args: unknown[]): Promise<unknown> {
        const type = args[0];
        const method = typeof type === "string" ? type : isRecord(type) ? type["method"] : undefined;
        const params = isRecord(args[1]) ? args[1] : {};
        if (method === "initialize") initialization = args;
        let target = primary;
        const owner = typeof params["threadId"] === "string" ? owners.get(params["threadId"]) : undefined;
        // A webview reload resumes an existing writer, even if its catalog or provider definition changed.
        // Moving a loaded thread to another process competes with our own writer lock.
        if (method === "thread/resume" && owner !== undefined) {
            target = owner;
        } else if (typeof method === "string" && opening.has(method) && typeof params["modelProvider"] === "string") {
            const config = params["config"];
            const catalog = isRecord(config) && typeof config["model_catalog_json"] === "string" ? config["model_catalog_json"] : undefined;
            const definitions = isRecord(config) ? config["model_providers"] : undefined;
            const defined = isRecord(definitions) && isRecord(definitions[params["modelProvider"]]);
            target = await provider(params["modelProvider"], catalog, defined);
        } else if (typeof params["threadId"] === "string") {
            target = owners.get(params["threadId"]) ?? primary;
        }
        if (method === "config/mcpServer/reload" && children.size > 0) {
            const connections = [primary, ...(await Promise.all(children.values()))];
            // Native reload is process-wide and may partially succeed; finish every process before reporting errors.
            const results = await Promise.allSettled(
                connections.map(connection => Reflect.apply(connection.sendRequest, connection, args) as Promise<unknown>),
            );
            const failures = results.filter(result => result.status === "rejected");
            if (failures.length === 1) throw failures[0]!.reason;
            if (failures.length > 1)
                throw new AggregateError(
                    failures.map(result => result.reason),
                    "MCP configuration reload failed in multiple Codex processes",
                );
            const result = results[0]!;
            if (result.status !== "fulfilled") throw new Error("Missing primary MCP reload result");
            return result.value;
        }
        if (method === "thread/loaded/list" && children.size > 0) {
            const connections = [primary, ...(await Promise.all(children.values()))];
            const lists = await Promise.all(
                connections.map(async connection => {
                    const ids: string[] = [];
                    let cursor: string | null = null;
                    do {
                        const page: {
                            data: string[];
                            nextCursor: string | null;
                        } = await connection.sendRequest("thread/loaded/list", {
                            cursor,
                            limit: 100,
                        });
                        ids.push(...page.data);
                        cursor = page.nextCursor;
                    } while (cursor !== null);
                    return ids;
                }),
            );
            const ids = [...new Set(lists.flat())].sort();
            const cursor = params["cursor"];
            if (cursor != null && (typeof cursor !== "string" || !/^providers:\d+$/.test(cursor)))
                throw new Error("Invalid provider connection cursor");
            const offset = cursor == null ? 0 : Number((cursor as string).slice("providers:".length));
            const limit = typeof params["limit"] === "number" ? params["limit"] : 100;
            if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Expected a positive loaded-thread limit");
            const data = ids.slice(offset, offset + limit);
            return {
                data,
                nextCursor: offset + data.length < ids.length ? `providers:${offset + data.length}` : null,
            };
        }
        const result: unknown = await Reflect.apply(target.sendRequest, target, args);
        if (
            typeof method === "string" &&
            opening.has(method) &&
            isRecord(result) &&
            isRecord(result["thread"]) &&
            typeof result["thread"]["id"] === "string"
        ) {
            owners.set(result["thread"]["id"], target);
        }
        if (
            method === "thread/unsubscribe" &&
            isRecord(result) &&
            result["status"] === "notLoaded" &&
            typeof params["threadId"] === "string" &&
            owners.get(params["threadId"]) === target
        )
            owners.delete(params["threadId"]);
        return result;
    }

    return new Proxy(primary, {
        get(target, property) {
            if (property === "sendRequest") return (...args: unknown[]) => request(args);
            if (typeof property === "string" && registrations.has(property)) {
                return (...args: unknown[]): Disposable => {
                    const handler = {
                        method: property,
                        args,
                        disposables: [register(primary, property, args)],
                    };
                    handlers.add(handler);
                    for (const child of children.values()) {
                        void child
                            .then(connection => {
                                if (handlers.has(handler)) handler.disposables.push(register(connection, property, args));
                            })
                            .catch(() => {
                                /* Failed startup is reported by the waiting request. */
                            });
                    }
                    return {
                        dispose() {
                            handlers.delete(handler);
                            for (const subscription of handler.disposables) subscription.dispose();
                        },
                    };
                };
            }
            if (property === "dispose")
                return (): void => {
                    if (disposed) return;
                    disposed = true;
                    for (const child of children.values())
                        void child
                            .then(connection => connection.dispose())
                            .catch(() => {
                                /* Startup already disposed the failed child. */
                            });
                    target.dispose();
                };
            const value: unknown = Reflect.get(target, property);
            return typeof value === "function" ? value.bind(target) : value;
        },
    });
}
