import {afterEach, describe, expect, it} from "vitest";
import {once} from "node:events";
import {createServer} from "node:http";
import WebSocket, {WebSocketServer} from "ws";
import {ResponsesProxy} from "../alwith/codex/responsesProxy";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).toReversed()) close(); });
const message = (text: string) => ({type: "message", role: "user", content: [{type: "input_text", text}]});
function answer(id: string, text: string): Array<Record<string, unknown>> {
    return [
        {type: "response.created", response: {id}},
        {type: "response.output_item.done", output_index: 0, item: {type: "reasoning", summary: []}},
        {type: "response.output_item.done", output_index: 1, item: {type: "message", role: "assistant", content: [{type: "output_text", text}]}},
        {type: "response.completed", response: {id, usage: {input_tokens: 7, output_tokens: 3, total_tokens: 10}}},
    ];
}
async function connect(reply: (request: Record<string, any>, index: number) => Array<Record<string, unknown>>) {
    const server = createServer();
    const ws = new WebSocketServer({server});
    cleanup.push(() => { for (const client of ws.clients) client.terminate(); ws.close(); server.closeAllConnections(); server.close(); });
    const requests: Array<Record<string, any>> = [];
    ws.on("connection", socket => socket.on("message", data => {
        const request = JSON.parse(data.toString()) as Record<string, any>;
        requests.push(request);
        for (const event of reply(request, requests.length)) socket.send(JSON.stringify(event));
    }));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing test server address");
    const proxy = new ResponsesProxy("external");
    cleanup.push(() => proxy.close());
    const route = await proxy.route(`http://127.0.0.1:${address.port}/v1`);
    const client = new WebSocket(route.replace("http:", "ws:") + "/responses");
    cleanup.push(() => client.terminate());
    await once(client, "open");
    return {client, requests};
}
async function exchange(client: WebSocket, request: Record<string, unknown>): Promise<Array<Record<string, any>>> {
    return await new Promise((resolve, reject) => {
        const events: Array<Record<string, any>> = [];
        const timer = setTimeout(() => { release(); reject(new Error("Response timed out")); }, 3000);
        const receive = (data: WebSocket.RawData) => {
            const event = JSON.parse(data.toString()) as Record<string, any>;
            events.push(event);
            if (["response.completed", "response.failed", "response.incomplete", "error"].includes(event.type)) { release(); resolve(events); }
        };
        const closed = () => { release(); reject(new Error("Response connection closed")); };
        const release = () => { clearTimeout(timer); client.off("message", receive); client.off("close", closed); };
        client.on("message", receive);
        client.once("close", closed);
        client.send(JSON.stringify(request));
    });
}

describe("gateway compaction over WebSocket", () => {
    it("preserves ordinary responses, compacts incrementally, and expands the summary on the next request", async () => {
        const {client, requests} = await connect((_request, index) => answer(`resp_${index}`, index === 2 ? "HANDOFF-SUMMARY" : "ordinary answer"));
        const ordinary = await exchange(client, {type: "response.create", model: "gateway:one:model", input: [message("first")]});
        expect(ordinary.filter(event => event.type === "response.output_item.done")).toHaveLength(2);
        const compacted = await exchange(client, {
            type: "response.create", model: "gateway:one:model", previous_response_id: "resp_1", stream: true,
            tools: [{type: "function", name: "test"}], tool_choice: "auto", parallel_tool_calls: true,
            input: [{type: "compaction_trigger"}],
        });
        const outputs = compacted.filter(event => event.type === "response.output_item.done");
        expect(outputs).toHaveLength(1);
        expect(outputs[0]!.item.type).toBe("compaction");
        expect(compacted.at(-1)!.response.output).toEqual([outputs[0]!.item]);
        expect(compacted.at(-1)!.response.usage.total_tokens).toBe(10);
        expect(JSON.stringify(compacted)).not.toContain("HANDOFF-SUMMARY");
        expect(requests[1]!.previous_response_id).toBe("resp_1");
        expect(requests[1]!.type).toBe("response.create");
        for (const key of ["stream", "tools", "tool_choice", "parallel_tool_calls"]) expect(requests[1]).not.toHaveProperty(key);
        expect(requests[1]!.input[0].content[0].text).toMatch(/^You are performing a CONTEXT CHECKPOINT/);
        const next = await exchange(client, {type: "response.create", previous_response_id: "resp_2", input: [outputs[0]!.item, message("next")]});
        expect(next.filter(event => event.type === "response.output_item.done")).toHaveLength(2);
        expect(requests[2]!.input[0].type).toBe("message");
        expect(requests[2]!.input[0].content[0].text).toContain("HANDOFF-SUMMARY");
    });

    it.each(["response.failed", "response.incomplete", "error"])("preserves %s and accepts an ordinary request afterwards", async type => {
        const failure = {type, error: {code: "rate_limit_exceeded", message: "test failure"}};
        const {client} = await connect((_request, index) => index === 1 ? [failure] : answer("next", "ordinary answer"));
        expect(await exchange(client, {type: "response.create", input: [{type: "compaction_trigger"}]})).toEqual([failure]);
        const next = await exchange(client, {type: "response.create", input: [message("retry")]});
        expect(next.filter(event => event.type === "response.output_item.done")).toHaveLength(2);
    });

    it("rejects an empty summary instead of sending an empty compaction", async () => {
        const {client} = await connect(() => answer("empty", " "));
        const closed = once(client, "close");
        const frames: string[] = [];
        client.on("message", data => frames.push(data.toString()));
        client.send(JSON.stringify({type: "response.create", input: [{type: "compaction_trigger"}]}));
        expect((await closed)[0]).toBe(1011);
        expect(frames).toEqual([]);
    });
});
