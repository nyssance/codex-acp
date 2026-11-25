import * as acp from "@agentclientprotocol/sdk/unstable";
import * as acpV2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {once} from "node:events";
import {mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {expect, it} from "vitest";
import {createAcpAgentRouter} from "../../AcpAgentRouter";
import {CodexAcpClient} from "../../CodexAcpClient";
import {CodexAcpServer} from "../../CodexAcpServer";
import {CodexAppServerClient} from "../../CodexAppServerClient";
import {startCodexConnection} from "../../CodexJsonRpcConnection";
import {removeDirectoryWithRetry, writeCodexHomeConfig} from "../acp-test-utils";
import {describeIntegration} from "./integration-fixture";

const cache = {ttlMs: 0, cacheScope: "private"};

/** An ACP-provided MCP server that names itself in every result and lists whatever `tools` returns now. */
function server(tag: string, tools: () => string[], calls: string[]) {
    return async (request: acp.McpOperationContext): Promise<acp.McpOutcome> => {
        switch (request.method) {
            case "server/discover":
                return {result: {
                    resultType: "complete", supportedVersions: [acp.MCP_PROTOCOL_VERSION], capabilities: {tools: {}},
                    _meta: {"io.modelcontextprotocol/serverInfo": {name: "test", version: "1"}}, ...cache,
                }};
            case "tools/list":
                return {result: {resultType: "complete", tools: tools().map(name => ({name, inputSchema: {type: "object"}})), ...cache}};
            case "tools/call":
                calls.push(`${tag}:${String(request.params?.["name"])}`);
                return {result: {resultType: "complete", content: [{type: "text", text: tag}]}};
            default:
                throw new acp.McpProtocolError(-32601, `Unknown method: ${request.method}`);
        }
    };
}

// What Codex does with the MCP servers of `session/resume` while the thread is still loaded. A client
// that re-declares its tools on every resume depends on this, so the test pins it: when it fails, Codex
// or the adapter changed and the client's handling of loaded sessions can be simplified.
describeIntegration("integration: MCP-over-ACP on a loaded thread", () => {
    it("keeps the endpoint and the tool list it loaded with, whatever a later resume declares", async () => {
        const cwd = mkdtempSync(join(tmpdir(), "codex-acp-mcp-loaded-"));
        writeCodexHomeConfig(cwd, {
            model_provider: "offline",
            "model_providers.offline.name": "Offline test",
            "model_providers.offline.base_url": "http://127.0.0.1:1/v1",
            "model_providers.offline.wire_api": "responses",
        });
        const codex = startCodexConnection(undefined, {...process.env, CODEX_HOME: cwd});
        const exited = once(codex.process, "exit");
        const appServer = new CodexAppServerClient(codex.connection);
        const incoming = new TransformStream<Uint8Array, Uint8Array>();
        const outgoing = new TransformStream<Uint8Array, Uint8Array>();
        const router = createAcpAgentRouter((connection, toHttp) =>
            new CodexAcpServer(connection, new CodexAcpClient(appServer, {}, undefined, toHttp)));
        const routed = router.connect(acp.ndJsonStream(outgoing.writable, incoming.readable));
        const provider = new acp.McpOverAcpProvider();
        const calls: string[] = [];
        try {
            const {agent} = acpV2.client().onRequest(acpV2.methods.client.mcp.message, provider.handleRequest)
                .connect(acp.ndJsonStream(incoming.writable, outgoing.readable));
            await agent.request(acpV2.methods.agent.initialize, {protocolVersion: 2, info: {name: "test", version: "1"}});
            let listed = ["echo"];
            const first = provider.registerServer(agent, {name: "tools", handler: server("first", () => listed, calls)});
            const {sessionId} = await agent.buildSession(cwd).withMcpServer(first.declaration).start();
            await appServer.mcpStartup.await(["tools"], 0, {threadId: sessionId, signal: AbortSignal.timeout(10000)});
            const call = (tool: string) => codex.connection.sendRequest("mcpServer/tool/call", {
                threadId: sessionId, server: "tools", tool, arguments: {},
            });
            const toolsCodexLists = async () => {
                const {data} = await codex.connection.sendRequest("mcpServerStatus/list", {threadId: sessionId, serverName: "tools"}) as
                    {data: Array<{tools: Record<string, unknown>}>};
                return data.flatMap(status => Object.keys(status.tools));
            };
            expect(await toolsCodexLists()).toEqual(["echo"]);

            // The same server now offers one more tool. Codex does not ask again, on resume or otherwise.
            listed = ["echo", "added"];
            await agent.request(acpV2.methods.agent.session.resume, {sessionId, cwd, mcpServers: [first.declaration]});
            expect(await toolsCodexLists()).toEqual(["echo"]);

            // A resume that declares another server is answered as a success and changes nothing.
            const second = provider.registerServer(agent, {name: "tools", handler: server("second", () => ["other"], calls)});
            await agent.request(acpV2.methods.agent.session.resume, {sessionId, cwd, mcpServers: [second.declaration]});
            expect(await toolsCodexLists()).toEqual(["echo"]);
            await call("echo");
            expect(calls).toEqual(["first:echo"]);

            // So a client that disposes the server it replaced leaves the thread without its tools.
            await first.dispose();
            await expect(call("echo")).rejects.toThrow("MCP server registration unavailable");
            expect(calls).toEqual(["first:echo"]);
        } finally {
            await incoming.writable.close();
            await routed.closed;
            await outgoing.writable.close();
            codex.process.stdin.end();
            await exited;
            removeDirectoryWithRetry(cwd);
        }
    });
});
