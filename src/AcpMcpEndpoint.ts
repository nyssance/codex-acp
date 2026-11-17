import {randomBytes, timingSafeEqual} from "node:crypto";
import {type HasConnectionContext, McpOverAcpCaller} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {
    createMcpHandler,
    hostHeaderValidationResponse,
    localhostAllowedHostnames,
    type McpRequestContext,
    OAuthError,
    OAuthErrorCode,
    ProtocolError,
    requireBearerAuth,
    Server,
} from "@modelcontextprotocol/server";
import packageJson from "../package.json";

/** The app-server reads the endpoint's bearer token from this variable, so it never enters thread config or URLs. */
export const ACP_MCP_TOKEN_ENV = "CODEX_ACP_MCP_TOKEN";

/** The Codex `mcp_servers` entry for one `"type": "acp"` server of one ACP connection. */
export type AcpMcpServers = (serverId: string) => {url: string; bearer_token_env_var: string};

type Route = {connection: HasConnectionContext; serverId: string};

/**
 * Re-exports MCP servers that an ACP client declares with `"type": "acp"` to Codex, whose MCP client only accepts URLs.
 *
 * One loopback listener serves the adapter process; each ACP connection gets its own path. Every HTTP request is
 * served statelessly (MCP 2026-07-28, or the 2025 stateless fallback while Codex still speaks it) and its tool requests
 * are forwarded as `mcp/message` requests on the connection that declared the server. Codex owns the tool calls, their
 * approvals and their cancellation, exactly as for any other MCP server.
 */
export class AcpMcpEndpoint {
    readonly env: Record<string, string>;
    private readonly token: Buffer;
    private readonly connections = new Map<string, HasConnectionContext>();
    private readonly caller = new McpOverAcpCaller({clientInfo: {name: packageJson.name, version: packageJson.version}});
    private readonly handler = createMcpHandler(context => this.server(context));
    private readonly authenticate = requireBearerAuth({
        verifier: {
            verifyAccessToken: async token => {
                const presented = Buffer.from(token);
                if (presented.length !== this.token.length || !timingSafeEqual(presented, this.token)) {
                    throw new OAuthError(OAuthErrorCode.InvalidToken, "Invalid token");
                }
                return {token, clientId: "codex", scopes: [], expiresAt: Number.MAX_SAFE_INTEGER};
            },
        },
    });
    private listener: Bun.Server<undefined> | null = null;

    constructor() {
        const token = randomBytes(32).toString("base64url");
        this.token = Buffer.from(token);
        this.env = {[ACP_MCP_TOKEN_ENV]: token};
    }

    /** Serves the `"type": "acp"` servers of one ACP connection until `signal` aborts. */
    attach(connection: HasConnectionContext, signal: AbortSignal): AcpMcpServers {
        const key = randomBytes(16).toString("base64url");
        this.connections.set(key, connection);
        signal.addEventListener("abort", () => this.connections.delete(key), {once: true});
        return serverId => ({
            url: `${this.origin()}/${key}/${encodeURIComponent(serverId)}`,
            bearer_token_env_var: ACP_MCP_TOKEN_ENV,
        });
    }

    async close(): Promise<void> {
        await this.listener?.stop(true);
        this.listener = null;
        await this.handler.close();
    }

    private origin(): string {
        this.listener ??= Bun.serve({hostname: "127.0.0.1", port: 0, fetch: (request, server) => this.fetch(request, server)});
        return `http://127.0.0.1:${this.listener.port}`;
    }

    private async fetch(request: Request, server: Bun.Server<undefined>): Promise<Response> {
        const invalidHost = hostHeaderValidationResponse(request, localhostAllowedHostnames());
        if (invalidHost) return invalidHost;
        const authInfo = await this.authenticate(request);
        if (authInfo instanceof Response) return authInfo;
        if (!this.route(request.url)) return new Response(null, {status: 404});
        // Application tools can wait for page controls or user interaction. MCP owns cancellation.
        server.timeout(request, 0);
        return this.handler.fetch(request, {authInfo});
    }

    private route(url: string): Route | null {
        const [, key, serverId, ...rest] = new URL(url).pathname.split("/");
        const connection = key === undefined ? undefined : this.connections.get(key);
        if (!connection || !serverId || rest.length > 0) return null;
        return {connection, serverId: decodeURIComponent(serverId)};
    }

    private server({requestInfo}: McpRequestContext): Server {
        // `fetch` routed this request before handing it over; the handler passes its URL on.
        const route = requestInfo && this.route(requestInfo.url);
        if (!route) throw new Error("MCP request reached the handler without a route");
        const server = new Server({name: route.serverId, version: packageJson.version}, {capabilities: {tools: {}}});
        server.setRequestHandler("tools/list", async (request, context) =>
            await this.forward(route, "tools/list", request.params, context.mcpReq.signal) as never);
        server.setRequestHandler("tools/call", async (request, context) =>
            await this.forward(route, "tools/call", request.params, context.mcpReq.signal) as never);
        return server;
    }

    private async forward(route: Route, method: string, params: Record<string, unknown> | undefined, signal: AbortSignal): Promise<unknown> {
        const outcome = await this.caller.request(route.connection, route.serverId, method, params ?? null, {signal});
        if ("error" in outcome) throw new ProtocolError(outcome.error.code, outcome.error.message, outcome.error.data);
        return outcome.result;
    }
}
