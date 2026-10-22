import type {JsonValue} from "../../app-server/serde_json/JsonValue";
import type {GetAccountResponse, ConfigReadResponse} from "../../app-server/v2";
import {ResponsesProxy} from "./responsesProxy";

type Config = Record<string, JsonValue | undefined>;

/** Shared by successive app-server connections; owned by the ACP process. */
export class ResponsesRoutes {
    private readonly proxy = new ResponsesProxy();

    async config(config: Config, provider: string, context: {
        cwd: string;
        readConfig(): Promise<ConfigReadResponse>;
        readAccount(): Promise<GetAccountResponse>;
    }): Promise<Config> {
        if (provider !== "openai") return config;
        // Resolve authentication only when a model request actually leaves Codex.
        // Opening history must not block on workspace-routing/account discovery.
        const local = await this.proxy.route(async () => {
            const effective = await context.readConfig();
            const configured = config["openai_base_url"] ?? effective.config["openai_base_url"] ?? process.env["OPENAI_BASE_URL"];
            if (typeof configured === "string" && configured.length > 0) return configured;
            const account = await context.readAccount();
            return account.account?.type === "chatgpt" ? "https://chatgpt.com/backend-api/codex" : "https://api.openai.com/v1";
        });
        return {...config, openai_base_url: local};
    }

    close(): void {
        this.proxy.close();
    }
}
