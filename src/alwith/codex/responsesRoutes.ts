import type { JsonValue } from "../../app-server/serde_json/JsonValue";
import type { GetAccountResponse } from "../../app-server/v2";
import { ResponsesProxy } from "./responsesProxy";

type Config = Record<string, JsonValue | undefined>;
type Context = {
    cwd: string;
    readConfig(): Promise<{ config: Record<string, unknown> }>;
    readAccount(): Promise<GetAccountResponse>;
};

/** Shared by successive app-server connections; owned by the ACP process. */
export class ResponsesRoutes {
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
    ): Promise<Config> {
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
            const local = await this.externalProxy.route(selected["base_url"]);
            return {
                ...config,
                model_providers: {
                    ...providers,
                    [provider]: { ...selected, base_url: local },
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
        return { ...config, openai_base_url: local };
    }

    close(): void {
        this.proxy.close();
        this.externalProxy.close();
        this.contexts.clear();
    }
}
