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
import {startMockResponsesServer, textResponse} from "./mock-responses-server";

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

// A loaded Codex thread ignores the MCP servers of a later `thread/resume`, so the adapter rebuilds an idle,
// persisted thread whose declared servers changed. A thread it cannot rebuild keeps the servers it has.
describeIntegration("integration: MCP-over-ACP on a loaded thread", () => {
    it("applies the servers of a resume to an idle persisted session, and leaves any other session as loaded", async () => {
        const mock = await startMockResponsesServer();
        const cwd = mkdtempSync(join(tmpdir(), "codex-acp-mcp-loaded-"));
        writeCodexHomeConfig(cwd, {
            model_provider: "offline",
            "model_providers.offline.name": "Offline test",
            "model_providers.offline.base_url": mock.baseUrl,
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
                .onNotification(acpV2.methods.client.session.update, () => {})
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

            // The same declaration is the same server: Codex is not asked to look at it again.
            listed = ["echo", "added"];
            await agent.request(acpV2.methods.agent.session.resume, {sessionId, cwd, mcpServers: [first.declaration]});
            expect(await toolsCodexLists()).toEqual(["echo"]);

            // Before its first turn the session has nothing on disk to rebuild from, so it stays as loaded.
            const second = provider.registerServer(agent, {name: "tools", handler: server("second", () => ["other"], calls)});
            await agent.request(acpV2.methods.agent.session.resume, {sessionId, cwd, mcpServers: [second.declaration]});
            expect(await toolsCodexLists()).toEqual(["echo"]);
            await call("echo");
            expect(calls).toEqual(["first:echo"]);

            mock.enqueue(textResponse("done"));
            await agent.request(acpV2.methods.agent.session.prompt, {sessionId, prompt: [{type: "text", text: "hello"}]});
            await expect.poll(async () => (await codex.connection.sendRequest("thread/read", {threadId: sessionId}) as
                {thread: {status: {type: string}}}).thread.status.type, {timeout: 20000}).toBe("idle");

            // Idle and persisted: the servers of the request replace the ones the thread was loaded with.
            const third = provider.registerServer(agent, {name: "tools", handler: server("third", () => ["fresh"], calls)});
            await agent.request(acpV2.methods.agent.session.resume, {sessionId, cwd, mcpServers: [third.declaration]});
            await appServer.mcpStartup.await(["tools"], 0, {threadId: sessionId, signal: AbortSignal.timeout(10000)});
            expect(await toolsCodexLists()).toEqual(["fresh"]);
            await first.dispose();
            await second.dispose();
            await call("fresh");
            expect(calls).toEqual(["first:echo", "third:fresh"]);
        } finally {
            await incoming.writable.close();
            await routed.closed;
            await outgoing.writable.close();
            codex.process.stdin.end();
            await exited;
            await mock.close();
            removeDirectoryWithRetry(cwd);
        }
    });
});
