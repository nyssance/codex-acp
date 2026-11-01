import type { JsonValue } from "../../app-server/serde_json/JsonValue";
import type { GetAccountResponse } from "../../app-server/v2";
import { ModelAliases, type ModelAlias } from "./modelAliases";
import { ResponsesProxy } from "./responsesProxy";

type Config = Record<string, JsonValue | undefined>;
type Context = {
    cwd: string;
    readConfig(): Promise<{ config: Record<string, unknown> }>;
    readAccount(): Promise<GetAccountResponse>;
};

/** Shared by successive app-server connections; owned by the ACP process. */
export class ResponsesRoutes {
    private readonly modelAliases = new ModelAliases();
    private readonly proxy = new ResponsesProxy();
    private readonly externalProxy = new ResponsesProxy("external");
    private readonly contexts = new Map<
        string,
        { context: Context; resolve: () => Promise<string> }
    >();

    async config(
        config: Config,
        provider: string,
        context: Context,
        transportProvider: string = provider,
        aliases?: ModelAlias[],
    ): Promise<Config> {
        if (aliases !== undefined) {
            const effective = await context.readConfig();
            const base = effective.config["model_catalog_json"];
            config = {
                ...config,
                model_catalog_json: this.modelAliases.catalog(
                    typeof base === "string" ? base : undefined,
                    aliases,
                ),
            };
        }
        if (provider !== "openai") {
            const providers = config["model_providers"];
            if (
                !providers ||
                typeof providers !== "object" ||
                Array.isArray(providers)
            )
                return config;
            const selected = providers[provider];
            if (
                !selected ||
                typeof selected !== "object" ||
                Array.isArray(selected) ||
                typeof selected["base_url"] !== "string"
            )
                return config;
            if (transportProvider === "openai") {
                const headers: Record<string, string> = {};
                const configuredHeaders = selected["http_headers"];
                if (
                    configuredHeaders &&
                    typeof configuredHeaders === "object" &&
                    !Array.isArray(configuredHeaders)
                )
                    for (const [name, value] of Object.entries(
                        configuredHeaders,
                    ))
                        if (typeof value === "string")
                            headers[name.toLowerCase()] = value;
                const environmentHeaders = selected["env_http_headers"];
                if (
                    environmentHeaders &&
                    typeof environmentHeaders === "object" &&
                    !Array.isArray(environmentHeaders)
                )
                    for (const [name, variable] of Object.entries(
                        environmentHeaders,
                    )) {
                        const value =
                            typeof variable === "string"
                                ? process.env[variable]
                                : undefined;
                        if (value !== undefined && value.trim().length > 0)
                            headers[name.toLowerCase()] = value;
                    }
                const keyVariable = selected["env_key"];
                let token = selected["experimental_bearer_token"];
                if (typeof keyVariable === "string") {
                    token = process.env[keyVariable];
                    if (typeof token !== "string" || token.trim().length === 0)
                        throw new Error(
                            `Missing environment variable: ${keyVariable}`,
                        );
                }
                if (typeof token === "string")
                    headers["authorization"] = `Bearer ${token}`;
                const local = await this.externalProxy.route(
                    selected["base_url"],
                    headers,
                );
                const remaining = { ...providers };
                delete remaining[provider];
                return {
                    ...config,
                    model_providers: remaining,
                    openai_base_url: local,
                };
            }
            const local = await this.externalProxy.route(selected["base_url"]);
            const remapped = { ...providers };
            if (transportProvider !== provider) delete remapped[provider];
            return {
                ...config,
                model_providers: {
                    ...remapped,
                    [transportProvider]: {
                        ...selected,
                        base_url: local,
                        ...(transportProvider !== provider
                            ? { requires_openai_auth: false }
                            : {}),
                    },
                },
            };
        }
        const configuredBase = config["openai_base_url"];
        const key = JSON.stringify([context.cwd, configuredBase ?? null]);
        let route = this.contexts.get(key);
        if (route) {
            // A recovered app-server replaces the reader; existing route URLs stay valid.
            route.context = context;
        } else {
            const created = {
                context,
                resolve: async (): Promise<string> => {
                    const effective = await created.context.readConfig();
                    const configured =
                        configuredBase ??
                        effective.config["openai_base_url"] ??
                        process.env["OPENAI_BASE_URL"];
                    if (typeof configured === "string" && configured.length > 0)
                        return configured;
                    const account = await created.context.readAccount();
                    return account.account?.type === "chatgpt"
                        ? "https://chatgpt.com/backend-api/codex"
                        : "https://api.openai.com/v1";
                },
            };
            this.contexts.set(key, created);
            route = created;
        }
        // The stable resolver also deduplicates concurrent opens in ResponsesProxy.
        // Opening history never blocks on account or workspace-routing discovery.
        const local = await this.proxy.route(route.resolve);
        if (transportProvider !== "openai")
            return {
                ...config,
                model_providers: {
                    [transportProvider]: {
                        name: "Native Responses",
                        base_url: local,
                        wire_api: "responses",
                        requires_openai_auth: true,
                    },
                },
            };
        return { ...config, openai_base_url: local };
    }

    close(): void {
        this.proxy.close();
        this.externalProxy.close();
        this.contexts.clear();
        this.modelAliases.close();
    }
}
