import {itemPageReader} from "./agent/sessionHistory";
import {framedItems} from "./agent/historyFrames";
import {readSessionInputConfig, writeSessionInputConfig} from "./codex/sessionInputConfig";
import {generateImage} from "./codex/images";
import {projectsFor} from "../projects/registry";
import {logger} from "../Logger";
import {historyError} from "./agent/historyProtocol";
import {RequestError} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import type {CodexAppServerClient} from "../CodexAppServerClient";
import type {ConfigWriteResponse, SkillsListResponse} from "../app-server/v2";
import {withoutUnsupportedSkills} from "../UnsupportedSkills";
import {AppServerClient} from "./codex/AppServerClient";
import {readPluginServiceAuth} from "./codex/pluginServiceAuth";
import type {HistoryRenderer} from "./agent/historyProjection";
import {
    readSessionHistory,
    readSessionHistoryItems,
    parseSessionHistoryParams,
    parseSessionHistoryItemsParams,
} from "./agent/sessionHistory";

export const CATALOG_METHODS = {
    "_codex/apps_installed": "app/installed",
    "_codex/apps_read": "app/read",
    "_codex/skills_list": "skills/list",
    "_codex/skills_config_write": "skills/config/write",
    "_codex/plugin_list": "plugin/list",
    "_codex/plugin_installed": "plugin/installed",
    "_codex/plugin_install": "plugin/install",
    "_codex/plugin_uninstall": "plugin/uninstall",
    "_codex/plugin_read": "plugin/read",
    "_codex/marketplace_add": "marketplace/add",
    "_codex/marketplace_remove": "marketplace/remove",
    "_codex/marketplace_upgrade": "marketplace/upgrade",
    "_codex/account_read": "account/read",
    "_codex/rate_limits": "account/rateLimits/read",
    "_codex/fuzzy_file_search": "fuzzyFileSearch",
} as const;
export const ALWITH_METHODS = [
    "_codex/plugin_service_auth",
    "_codex/project_context",
    "_codex/images/generate",
    "_codex/session_input_config_get",
    "_codex/session_input_config_set",
    ...Object.keys(CATALOG_METHODS),
    "_codex/plugin_set_enabled",
    "_codex/session_history",
    "_codex/session_history_items",
    "_codex/session_retry",
] as const;
const MUTATIONS = new Set([
    "_codex/skills_config_write",
    "_codex/plugin_install",
    "_codex/plugin_uninstall",
    "_codex/marketplace_add",
    "_codex/marketplace_remove",
    "_codex/marketplace_upgrade",
]);

export function objectParams(value: unknown): Record<string, unknown> {
    if (value === undefined) return {};
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw RequestError.invalidParams(undefined, "Expected an object");
    }
    return value as Record<string, unknown>;
}

/** Host extensions share the upstream process and read native Codex history. */
export class AlwithExtensions {
    readonly codex: AppServerClient;
    private observed: CodexAppServerClient | null = null;
    private stopObserving: (() => void) | null = null;

    observe(): void {
        const client = this.current();
        if (this.observed === client) return;
        this.stopObserving?.();
        this.observed = client;
        const stop = client.onClientTransportEvent(event => {
            if (event.eventType !== "notification") return;
            const methods: Record<string, string> = {
                "project/changed": "_codex/projects_changed",
                "thread/project/updated": "_codex/thread_project_updated",
                "skills/changed": "_codex/skills_changed",
                "account/rateLimits/updated": "_codex/rate_limits_updated",
            };
            const method = methods[event.method];
            if (method)
                void this.notify(method, event.params).catch(error => {
                    logger.error(`Failed to deliver ${method}`, error);
                });
        });
        const stopLoss = client.connectionLoss.onLost(stop);
        this.stopObserving = () => {
            stop();
            stopLoss();
        };
    }
    private readonly current: () => CodexAppServerClient;
    private readonly notify: (method: string, params: Record<string, unknown>) => Promise<void>;
    private readonly running: (id: string) => boolean;
    private readonly render: HistoryRenderer;

    constructor(
        current: () => CodexAppServerClient,
        notify: (method: string, params: Record<string, unknown>) => Promise<void>,
        running: (id: string) => boolean,
        render: HistoryRenderer,
    ) {
        this.current = current;
        this.notify = notify;
        this.running = running;
        this.render = render;
        this.codex = new AppServerClient(current);
    }

    async request(method: string, params: Record<string, unknown>, signal?: AbortSignal, requestId: string | number | null = 0): Promise<unknown> {
        signal?.throwIfAborted();
        if (method === "_codex/plugin_service_auth") {
            const refresh = params["refreshToken"];
            if (refresh != null && typeof refresh !== "boolean") throw RequestError.invalidParams(undefined, "refreshToken must be a boolean");
            try {
                return await readPluginServiceAuth(this.codex, refresh === true, signal);
            } catch (error) {
                if (error instanceof RequestError) throw error;
                throw new RequestError(-32000, error instanceof Error ? error.message : "Plugin authentication failed");
            }
        }
        if (method === "_codex/images/generate") return generateImage(this.codex, params, signal);
        if (method === "_codex/session_input_config_get" || method === "_codex/session_input_config_set") {
            const sessionId = params["sessionId"];
            if (typeof sessionId !== "string" || !sessionId) throw RequestError.invalidParams(undefined, "sessionId is required");
            const snapshot = method === "_codex/session_input_config_get"
                ? await readSessionInputConfig(this.codex, sessionId)
                : await writeSessionInputConfig(this.codex, sessionId, params["inputConfig"]);
            return snapshot;
        }
        if (method === "_codex/project_context") return projectsFor(this.current()).context(params["createChatDirectory"] === true);
        if (method === "_codex/session_history_items" && (params["framed"] === null || params["fragment"] === null)) {
            params = {...params};
            if (params["framed"] === null) delete params["framed"];
            if (params["fragment"] === null) delete params["fragment"];
        }
        if (method === "_codex/session_history_items" && params["framed"] === true) {
            const {framed: _framed, fragment, ...input} = params;
            const parsed = parseSessionHistoryItemsParams(input);
            if (parsed.mode !== "browse" || parsed.maxBytes !== undefined ||
                (fragment !== undefined && (typeof fragment !== "string" || !/^[a-f0-9]{64}:[1-9]\d{0,9}$/.test(fragment))))
                throw RequestError.invalidParams(undefined, "Invalid framed history request");
            const read = await itemPageReader(this.codex, this.render, parsed, signal, true);
            return framedItems(parsed.limit ?? 50, fragment as string | undefined, requestId, async limit => {
                const page = await read.pageAt(limit);
                return {...page, running: this.running(parsed.sessionId) || page.running};
            });
        }
        if (method === "_codex/session_history" || method === "_codex/session_history_items") {
            const request =
                method === "_codex/session_history"
                    ? {items: false as const, params: parseSessionHistoryParams(params)}
                    : {items: true as const, params: parseSessionHistoryItemsParams(params)};
            const parsed = request.params;
            const assertIdle = () => {
                if (parsed.mode === "export" && this.running(parsed.sessionId)) {
                    throw historyError("history_busy", "Session history is still running; retry after the turn finishes", true);
                }
            };
            assertIdle();
            const response = request.items
                ? await readSessionHistoryItems(this.codex, this.render, request.params, signal)
                : await readSessionHistory(this.codex, this.render, request.params, signal);
            assertIdle();
            return {
                ...response,
                ...(parsed.mode === "browse" && !request.items ? {framedItems: true} : {}),
                running: this.running(parsed.sessionId) || response.running,
            };
        }
        if (method === "_codex/plugin_set_enabled") {
            if (typeof params["enabled"] !== "boolean" || typeof params["pluginId"] !== "string" || !params["pluginId"]) {
                throw RequestError.invalidParams(undefined, "pluginId and enabled are required");
            }
            // Codex ignores local configuration for remote installs, which ChatGPT enables itself.
            if (params["remotePluginId"] !== undefined) throw RequestError.invalidParams(undefined, "Remote plugins are enabled in ChatGPT");
            const enabled = params["enabled"];
            const response = await this.codex.request<ConfigWriteResponse>("config/value/write", {
                keyPath: `plugins.${JSON.stringify(params["pluginId"])}.enabled`,
                value: enabled,
                mergeStrategy: "upsert",
            });
            if (response.status === "okOverridden")
                throw RequestError.invalidRequest(undefined, "Plugin enablement is overridden by higher-priority configuration");
            await this.notify("_codex/skills_changed", {});
            return {enabled};
        }
        const target = CATALOG_METHODS[method as keyof typeof CATALOG_METHODS];
        if (!target) throw RequestError.methodNotFound(method);
        const response = await this.codex.request(target, method === "_codex/account_read" ? {refreshToken: false} : params);
        if (MUTATIONS.has(method)) await this.notify("_codex/skills_changed", {});
        if (method === "_codex/skills_list") return withoutUnsupportedSkills(response as SkillsListResponse);
        return response;
    }
}
