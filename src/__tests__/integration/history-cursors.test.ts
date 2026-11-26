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

type HistoryPage = {turns: Array<{turnId: string; updates: Array<{sessionUpdate: string; cursorId?: string}>}>};

// Real Codex, mock model: a client that reads history through `_codex/session_history` gets the session cursors
// that a replay announces, and `session/fork` takes them.
describeIntegration("integration: session cursors in history pages", () => {
    it("announces the same cursors in the turn index, in full pages and live after a resume without a replay", async () => {
        const mock = await startMockResponsesServer();
        mock.setResponseHandler(() => textResponse("ok"));
        const cwd = mkdtempSync(join(tmpdir(), "codex-acp-history-cursors-"));
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
        const live: string[] = [];
        try {
            const {agent} = acpV2.client()
                .onNotification(acpV2.methods.client.session.update, ({params}) => {
                    const update = params.update as {sessionUpdate: string; cursorId?: string};
                    if (update.sessionUpdate === "cursor_update") live.push(update.cursorId!);
                })
                .connect(acp.ndJsonStream(incoming.writable, outgoing.readable));
            await agent.request(acpV2.methods.agent.initialize, {protocolVersion: 2, info: {name: "test", version: "1"}});
            const {sessionId} = await agent.buildSession(cwd).start();
            const status = async () => ((await codex.connection.sendRequest("thread/read", {threadId: sessionId, includeTurns: false})) as
                {thread: {status: {type: string}}}).thread.status.type;
            const send = async (text: string) => {
                await agent.request(acpV2.methods.agent.session.prompt, {sessionId, prompt: [{type: "text", text}]});
                await expect.poll(status, {timeout: 20000}).toBe("idle");
            };
            const cursors = async (itemsView: "summary" | "full") =>
                ((await agent.request("_codex/session_history", {sessionId, mode: "browse", sortDirection: "desc", itemsView})) as HistoryPage)
                    .turns.toReversed().map(turn => turn.updates.find(update => update.sessionUpdate === "cursor_update")?.cursorId);
            await send("first");
            await send("second");
            await send("third");
            const index = (await agent.request("_codex/session_history", {sessionId, mode: "browse", sortDirection: "desc"})) as HistoryPage;
            const [, second, third] = index.turns.toReversed().map(turn => turn.turnId);
            const expected = [undefined, `before:${second}`, `before:${third}`];
            expect(live).toEqual(expected.slice(1));
            expect(await cursors("summary")).toEqual(expected);
            expect(await cursors("full")).toEqual(expected);

            // A fork at an announced cursor holds the turns before it.
            const fork = await agent.request(acpV2.methods.agent.session.fork, {sessionId, cwd, cursorId: `before:${third}`});
            const forked = (await agent.request("_codex/session_history", {sessionId: fork.sessionId, mode: "browse", sortDirection: "desc"})) as HistoryPage;
            expect(forked.turns).toHaveLength(2);

            // A session resumed without a replay counts as new, until the client reads its turns.
            await agent.request(acpV2.methods.agent.session.resume, {sessionId, cwd});
            live.length = 0;
            await cursors("summary");
            await send("fourth");
            const after = (await agent.request("_codex/session_history", {sessionId, mode: "browse", sortDirection: "desc", limit: 1})) as HistoryPage;
            expect(live).toEqual([`before:${after.turns[0]!.turnId}`]);
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
