// Opt-in real Codex regression; model endpoints are local and credentials are synthetic.
import {describe, expect, it, vi} from "vitest";
import {startTestRuntime} from "@alwith/api/node";
import {spawn} from "node:child_process";
import {createServer} from "node:http";
import {once} from "node:events";
import {resolve} from "node:path";
import {zstdDecompressSync} from "node:zlib";
import {WebSocketServer} from "ws";
import {isRecord} from "../../permissions/json";

const enabled = process.env["RUN_CODEX_COMPACTION_TESTS"] === "1";
const cases = [
    {transport: "http", trigger: "manual"},
    {transport: "websocket", trigger: "manual"},
    {transport: "http", trigger: "automatic"},
    {transport: "websocket", trigger: "automatic"},
] as const;

describe.skipIf(!enabled)("real Codex gateway compaction across transports", () => {
    it.each(cases)("$transport / $trigger survives switching a native thread to a gateway", async ({transport, trigger}) => {
        const binary = process.env["COMPACTION_TEST_RUNTIME"];
        const codex = process.env["COMPACTION_TEST_CODEX"];
        if (!binary || !codex) throw new Error("COMPACTION_TEST_RUNTIME and COMPACTION_TEST_CODEX must name installed test binaries");
        const requests: Array<{transport: string; body: Record<string, any>}> = [];
        const updates: Array<Record<string, any>> = [];
        let catalog: unknown;
        let sequence = 0;
        function response(body: Record<string, any>): Array<Record<string, unknown>> {
            const id = `resp_${++sequence}`;
            const summary = body["input"]?.at(-1)?.content?.some((part: {text?: string}) => part.text?.startsWith("You are performing a CONTEXT CHECKPOINT"));
            const text = summary ? "HANDOFF-SUMMARY" : "ordinary answer";
            const inputTokens = trigger === "automatic" && body["model"] === "gpt-5.6-terra" ? 300 : 10;
            return [
                {type: "response.created", response: {id}},
                {type: "response.output_item.done", output_index: 0, item: {type: "reasoning", id: `rs_${sequence}`, summary: []}},
                {type: "response.output_item.added", output_index: 1, item: {type: "message", id: `msg_${sequence}`, role: "assistant", content: []}},
                {type: "response.output_text.delta", item_id: `msg_${sequence}`, output_index: 1, content_index: 0, delta: text},
                {type: "response.output_item.done", output_index: 1, item: {type: "message", id: `msg_${sequence}`, role: "assistant", content: [{type: "output_text", text}]}},
                {type: "response.completed", response: {id, usage: {input_tokens: inputTokens, output_tokens: 5, total_tokens: inputTokens + 5}}},
            ];
        }
        const server = createServer(async (request, out) => {
            if (request.method !== "POST" || !request.url?.endsWith("/responses")) {
                out.writeHead(200, {"content-type": "application/json"}).end(JSON.stringify(catalog));
                return;
            }
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            const bytes = Buffer.concat(chunks);
            const body = JSON.parse((request.headers["content-encoding"] === "zstd" ? zstdDecompressSync(bytes) : bytes).toString()) as Record<string, any>;
            requests.push({transport: "http", body});
            out.writeHead(200, {"content-type": "text/event-stream"}).end(response(body).map(event => `event: ${event["type"]}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
        });
        const websocket = new WebSocketServer({noServer: true});
        server.on("upgrade", (request, socket, head) => {
            if (transport === "http") { socket.end("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); return; }
            websocket.handleUpgrade(request, socket, head, client => websocket.emit("connection", client, request));
        });
        websocket.on("connection", client => client.on("message", data => {
            const body = JSON.parse(data.toString()) as Record<string, any>;
            requests.push({transport: "websocket", body});
            for (const event of response(body)) client.send(JSON.stringify(event));
        }));
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const address = server.address();
        if (address === null || typeof address === "string") throw new Error("Missing test server address");
        const baseUrl = `http://127.0.0.1:${address.port}/v1`;
        let runtime: Awaited<ReturnType<typeof startTestRuntime>> | undefined;
        try {
            runtime = await startTestRuntime({binary, engines: {codex: {
                command: process.env["COMPACTION_TEST_BUN"] ?? "bun",
                args: ["--no-install", process.env["COMPACTION_TEST_ADAPTER"] ?? resolve("src/index.ts")],
                env: {
                    CODEX_PATH: codex,
                    OPENAI_BASE_URL: baseUrl,
                    CODEX_CONFIG: JSON.stringify({model: "gpt-6-luna", model_reasoning_effort: "low", openai_base_url: baseUrl, web_search: "disabled", model_auto_compact_token_limit: trigger === "automatic" ? 100 : 1000000}),
                    INITIAL_AGENT_MODE: "read-only",
                },
            }}});
            // Query bundled metadata in the helper's isolated home, never the user's configuration.
            const models = spawn(codex, ["debug", "models", "--bundled"], {env: {...process.env, CODEX_HOME: runtime.codexHome}, stdio: ["ignore", "pipe", "pipe"]});
            let stdout = "";
            models.stdout.on("data", chunk => stdout += String(chunk));
            const [code] = await once(models, "close");
            if (code !== 0) throw new Error("Cannot read bundled Codex models for the local endpoint");
            catalog = JSON.parse(stdout);
            const port = runtime.client;
            await port.onAcpNotification(notification => {
                if (notification.method !== "session/update" || !isRecord(notification.params)) return;
                const update = notification.params["update"];
                if (isRecord(update)) updates.push(update);
            });
            await port.start("codex", {engine: "codex"});
            await port.initialize("codex");
            await port.acpRequest("codex", "auth/login", {methodId: "api-key", _meta: {"api-key": {apiKey: "sk-test-not-real"}}});
            await port.acpRequest("codex", "providers/set", {providerId: "openai", apiType: "openai", baseUrl, _meta: {codex: {id: "local-test", mode: "catalog", name: "Local test"}, alwith: {models: [{id: "gpt-5.6-terra", label: "Local test"}]}}});
            const opened = await port.acpRequest<{sessionId: string}>("codex", "session/new", {cwd: runtime.workspace, mcpServers: [], configOptions: [{configId: "model", type: "id", value: "native:gpt-6-luna"}]});
            const sessionId = opened.sessionId;
            async function prompt(text: string): Promise<void> {
                const start = updates.length;
                await port.acpRequest("codex", "session/prompt", {sessionId, prompt: [{type: "text", text}]});
                await vi.waitFor(() => expect(updates.slice(start).some(update => update["sessionUpdate"] === "state_update" && update["state"] === "idle")).toBe(true), {timeout: 30000});
            }
            await prompt("first question");
            await port.acpRequest("codex", "session/set_config_option", {sessionId, configId: "model", type: "id", value: "gateway:local-test:gpt-5.6-terra"});
            await prompt("second question");
            await prompt(trigger === "manual" ? "/compact" : "third question");
            await vi.waitFor(() => expect(updates.some(update => update["sessionUpdate"] === "compaction_update" && (update["status"] === "completed" || update["status"] === "failed"))).toBe(true), {timeout: 30000});
            expect(updates.filter(update => update["sessionUpdate"] === "compaction_update" && update["status"] === "failed").map(update => update["error"])).toEqual([]);
            await prompt("continue after compaction");
            expect(updates.filter(update => update["sessionUpdate"] === "compaction_update" && update["status"] === "failed")).toEqual([]);
            expect(JSON.stringify(updates)).not.toContain("expected exactly one compaction output");
            expect(new Set(requests.map(request => request.transport))).toEqual(new Set([transport]));
            expect(requests.flatMap(request => request.body["input"] ?? []).some((item: {type: string}) => item.type === "compaction_trigger" || item.type === "compaction")).toBe(false);
            expect(JSON.stringify(requests)).toContain("HANDOFF-SUMMARY");
        } finally {
            try { await runtime?.dispose(); }
            finally { for (const client of websocket.clients) client.terminate(); websocket.close(); server.closeAllConnections(); server.close(); }
        }
    }, 90000);
});
