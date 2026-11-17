import {afterEach, expect, test} from "bun:test";
import * as acpV2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {ACP_MCP_TOKEN_ENV, AcpMcpEndpoint} from "../../AcpMcpEndpoint";

const endpoints: AcpMcpEndpoint[] = [];
afterEach(async () => {
    await Promise.all(endpoints.splice(0).map(endpoint => endpoint.close()));
});

/** An ACP client that provides one MCP server over ACP, connected in process to an agent that serves it over HTTP. */
async function connect(handler: acpV2.McpRequestHandler) {
    const endpoint = new AcpMcpEndpoint();
    endpoints.push(endpoint);
    const provider = new acpV2.McpOverAcpProvider();
    const registered = Promise.withResolvers<acpV2.McpServerRegistration>();
    const initialized = Promise.withResolvers<unknown>();
    const client = acpV2.client({name: "test-client"})
        .onRequest(acpV2.methods.client.mcp.message, provider.handleRequest)
        .onConnect(connection => {
            registered.resolve(provider.registerServer(connection.agent, {name: "app", handler, serverId: "app-server"}));
            initialized.resolve(connection.agent.request(acpV2.methods.agent.initialize, {protocolVersion: 2, info: {name: "test-client", version: "1.0.0"}}));
        });
    const disconnected = new AbortController();
    const agent = acpV2.agent({name: "test-agent"})
        .onRequest(acpV2.methods.agent.initialize, () => ({protocolVersion: 2, info: {name: "test-agent", version: "1.0.0"}, capabilities: {}}))
        .connect(client);
    const servers = endpoint.attach(agent.client, disconnected.signal);
    const registration = await registered.promise;
    await initialized.promise;
    return {endpoint, servers: servers(registration.serverId), disconnect: () => disconnected.abort()};
}

/** Codex's MCP client: Streamable HTTP, still on the 2025 handshake, the bearer token taken from its environment. */
async function codex(url: string, token: string | undefined) {
    const mcp = new Client({name: "codex", version: "1.0.0"});
    await mcp.connect(new StreamableHTTPClientTransport(new URL(url), token === undefined ? {} : {requestInit: {headers: {Authorization: `Bearer ${token}`}}}));
    return mcp;
}

test("serves an ACP-provided server to a 2025 MCP client over loopback HTTP", async () => {
    const calls: Array<{method: string; params: unknown}> = [];
    const {endpoint, servers} = await connect(({method, params}) => {
        calls.push({method, params});
        if (method === "tools/list") {
            return {result: {tools: [{name: "echo", inputSchema: {type: "object"}, annotations: {readOnlyHint: true}}]}};
        }
        return {result: {content: [{type: "text", text: JSON.stringify(params?.["arguments"])}]}};
    });
    expect(servers.bearer_token_env_var).toBe(ACP_MCP_TOKEN_ENV);
    expect(new URL(servers.url).hostname).toBe("127.0.0.1");
    const mcp = await codex(servers.url, endpoint.env[ACP_MCP_TOKEN_ENV]);

    expect((await mcp.listTools()).tools).toEqual([{name: "echo", inputSchema: {type: "object"}, annotations: {readOnlyHint: true}}]);
    const result = await mcp.callTool({name: "echo", arguments: {text: "hi"}, _meta: {callId: "call-1"}});

    expect(result.content).toEqual([{type: "text", text: "{\"text\":\"hi\"}"}]);
    const call = calls.find(entry => entry.method === "tools/call")?.params as {_meta: Record<string, unknown>};
    expect(call._meta["callId"]).toBe("call-1");
    expect(call._meta["io.modelcontextprotocol/protocolVersion"]).toBe("2026-07-28");
    await mcp.close();
});

test("passes inner MCP errors through unchanged", async () => {
    const {endpoint, servers} = await connect(({method}) => {
        if (method === "tools/list") return {result: {tools: [{name: "fail", inputSchema: {type: "object"}}]}};
        return {error: {code: -32602, message: "Unknown tool: fail"}};
    });
    const mcp = await codex(servers.url, endpoint.env[ACP_MCP_TOKEN_ENV]);

    await expect(mcp.callTool({name: "fail", arguments: {}})).rejects.toThrow("Unknown tool: fail");
    await mcp.close();
});

test("refuses requests without the token or after the connection closed", async () => {
    const {endpoint, servers, disconnect} = await connect(() => ({result: {tools: []}}));

    await expect(codex(servers.url, undefined)).rejects.toThrow();
    await expect(codex(servers.url, "wrong")).rejects.toThrow();
    disconnect();
    await expect(codex(servers.url, endpoint.env[ACP_MCP_TOKEN_ENV])).rejects.toThrow();
});

test("cancels the ACP request when Codex abandons the HTTP request", async () => {
    const started = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<void>();
    const {endpoint, servers} = await connect(({method, signal}) => {
        if (method === "tools/list") return {result: {tools: [{name: "slow", inputSchema: {type: "object"}}]}};
        started.resolve();
        signal.addEventListener("abort", () => cancelled.resolve(), {once: true});
        return new Promise(() => undefined);
    });
    const mcp = await codex(servers.url, endpoint.env[ACP_MCP_TOKEN_ENV]);

    const call = mcp.callTool({name: "slow", arguments: {}});
    await started.promise;
    // Codex drops the in-flight HTTP request; closing the transport does the same.
    await mcp.close();

    await expect(call).rejects.toThrow();
    await cancelled.promise;
});
