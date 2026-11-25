import * as acp from "@agentclientprotocol/sdk/unstable";
import * as acpV2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {once} from "node:events";
import {mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import {crc32, deflateSync} from "node:zlib";
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

/** A valid 8x8 PNG of one colour, so Codex forwards it to the model rather than dropping it. */
function png(): string {
    const chunk = (type: string, data: Buffer) => {
        const body = Buffer.concat([Buffer.from(type), data]);
        const length = Buffer.alloc(4);
        length.writeUInt32BE(data.length);
        const checksum = Buffer.alloc(4);
        checksum.writeUInt32BE(crc32(body));
        return Buffer.concat([length, body, checksum]);
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(8, 0);
    header.writeUInt32BE(8, 4);
    header.set([8, 2, 0, 0, 0], 8);
    const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(24, 0x80)]);
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk("IHDR", header),
        chunk("IDAT", deflateSync(Buffer.concat(Array.from({length: 8}, () => row)))),
        chunk("IEND", Buffer.alloc(0)),
    ]).toString("base64");
}
const image = png();

type StoredTurn = {id: string; items: Array<{type: string; clientId?: string | null; content?: Array<{type: string; text?: string}>}>};

// Real Codex, mock model: a prompt with `_meta.codex.replace` replaces a user message and what followed it.
describeIntegration("integration: replacing a sent message", () => {
    it("cuts the history at the message, keeps its other input, and refuses a history that moved on", async () => {
        const mock = await startMockResponsesServer();
        // Codex may ask the model more than once per turn; every request gets the same short answer.
        mock.setResponseHandler(() => textResponse("ok"));
        const cwd = mkdtempSync(join(tmpdir(), "codex-acp-replace-"));
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
        const chunks: Array<{messageId?: string; content: {type: string; text?: string}; _meta?: {codex?: {replaces?: string}}}> = [];
        try {
            const {agent} = acpV2.client()
                .onNotification(acpV2.methods.client.session.update, ({params}) => {
                    const update = params.update as {sessionUpdate: string};
                    if (update.sessionUpdate === "user_message_chunk") chunks.push(update as never);
                })
                .connect(acp.ndJsonStream(incoming.writable, outgoing.readable));
            const initialized = await agent.request(acpV2.methods.agent.initialize, {protocolVersion: 2, info: {name: "test", version: "1"}});
            expect(initialized.capabilities?.session?.prompt?._meta).toEqual({codex: {replace: {}}});
            const {sessionId} = await agent.buildSession(cwd).start();
            const turns = async () => ((await codex.connection.sendRequest("thread/read", {threadId: sessionId, includeTurns: true})) as
                {thread: {status: {type: string}; turns: StoredTurn[]}}).thread;
            const users = async () => (await turns()).turns.map(turn => turn.items.filter(item => item.type === "userMessage")
                .flatMap(item => item.content!.map(part => part.type === "text" ? part.text : part.type)));
            const send = async (prompt: acpV2.ContentBlock[], replace?: {messageId: string; tail: string}) => {
                const {messageId} = await agent.request(acpV2.methods.agent.session.prompt, {
                    sessionId, prompt, ...(replace && {_meta: {codex: {replace}}}),
                });
                await expect.poll(async () => (await turns()).status.type, {timeout: 20000}).toBe("idle");
                return messageId;
            };
            const first = await send([{type: "text", text: "first"}]);
            const second = await send([{type: "text", text: "second"}, {type: "image", mimeType: "image/png", data: image}]);
            const third = await send([{type: "text", text: "third"}]);
            expect(await users()).toEqual([["first"], ["second", "image"], ["third"]]);

            // The client edited `second` before `third` existed: nothing is removed.
            await expect(send([{type: "text", text: "late"}], {messageId: second, tail: second})).rejects.toThrow("history changed");
            await expect(send([{type: "text", text: "nowhere"}], {messageId: "unknown", tail: third})).rejects.toThrow("not a user message");
            await expect(send([{type: "image", mimeType: "image/png", data: image}], {messageId: second, tail: third}))
                .rejects.toThrow("new text only");
            expect(await users()).toEqual([["first"], ["second", "image"], ["third"]]);

            chunks.length = 0;
            const before = mock.requests.length;
            const edited = await send([{type: "text", text: "second, edited"}], {messageId: second, tail: third});
            expect(await users()).toEqual([["first"], ["second, edited", "image"]]);
            // The client is told which message the new one replaces, and gets the input that was kept.
            expect(chunks.map(chunk => [chunk.messageId, chunk.content.type, chunk._meta?.codex?.replaces])).toEqual([
                [edited, "text", second],
                [edited, "image", undefined],
            ]);
            const sent = JSON.stringify(mock.requests.slice(before));
            expect(sent).toContain("second, edited");
            expect(sent).toContain("input_image");
            expect(sent).not.toContain("third");

            // History cannot be cut under a running turn, and the replacement is not steered into it.
            const held = Promise.withResolvers<string>();
            mock.setResponseHandler(() => held.promise);
            const {messageId: slow} = await agent.request(acpV2.methods.agent.session.prompt, {sessionId, prompt: [{type: "text", text: "slow"}]});
            await expect(agent.request(acpV2.methods.agent.session.prompt, {
                sessionId, prompt: [{type: "text", text: "too early"}], _meta: {codex: {replace: {messageId: edited, tail: slow}}},
            })).rejects.toThrow("only while the session is idle");
            mock.setResponseHandler(() => textResponse("ok"));
            held.resolve(textResponse("ok"));
            await expect.poll(async () => (await turns()).status.type, {timeout: 20000}).toBe("idle");
            expect(await users()).toEqual([["first"], ["second, edited", "image"], ["slow"]]);

            // The first message can be replaced too; the history then starts with its replacement.
            await send([{type: "text", text: "first, edited"}], {messageId: first, tail: slow});
            expect(await users()).toEqual([["first, edited"]]);
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
