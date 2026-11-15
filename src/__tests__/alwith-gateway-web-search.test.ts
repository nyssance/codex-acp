import {once} from "node:events";
import {createServer, type Server} from "node:http";
import {afterEach, describe, expect, it} from "vitest";

import {ResponsesProxy} from "../alwith/codex/responsesProxy";

type Json = Record<string, any>;

const cleanup: Array<() => void> = [];
afterEach(() => {
    for (const close of cleanup.splice(0).toReversed()) close();
});

const sse = (events: Json[]) => events.map(event => `event: ${event["type"]}\ndata: ${JSON.stringify(event)}\n\n`).join("");
const usage = (input: number, output: number) => ({input_tokens: input, output_tokens: output, total_tokens: input + output, output_tokens_details: {reasoning_tokens: 1}});
const reasoning = (id: string) => ({type: "reasoning", id, summary: [], content: [{type: "reasoning_text", text: "thinking"}]});
const call = (id: string, name: string, args: Json) => ({type: "function_call", id, status: "completed", call_id: `call_${id}`, name, arguments: JSON.stringify(args)});
const text = (id: string, value: string) => ({type: "message", id, status: "completed", role: "assistant", content: [{type: "output_text", text: value}]});
/** One model answer in DeepSeek's stream shape: every item is added, calls stream their arguments, then it is done. */
function answer(id: string, items: Json[], tokens: Json): string {
    let sequence = 0;
    const events: Json[] = [{type: "response.created", response: {id, status: "in_progress"}, sequence_number: sequence++}];
    items.forEach((item, output_index) => {
        events.push({type: "response.output_item.added", output_index, item: {...item, status: "in_progress"}, sequence_number: sequence++});
        if (item["type"] === "function_call") {
            events.push({type: "response.function_call_arguments.delta", item_id: item["id"], output_index, delta: item["arguments"], sequence_number: sequence++});
            events.push({type: "response.function_call_arguments.done", item_id: item["id"], output_index, arguments: item["arguments"], sequence_number: sequence++});
        }
        if (item["type"] === "message")
            events.push({type: "response.output_text.delta", item_id: item["id"], output_index, content_index: 0, delta: item["content"][0].text, sequence_number: sequence++});
        events.push({type: "response.output_item.done", output_index, item, sequence_number: sequence++});
    });
    events.push({type: "response.completed", response: {id, status: "completed", usage: tokens}, sequence_number: sequence++});
    return sse(events);
}

const hosted = {type: "web_search", external_web_access: true};
const shell = {type: "function", name: "exec_command", parameters: {type: "object", properties: {cmd: {type: "string"}}}};
const user = {type: "message", role: "user", content: [{type: "input_text", text: "What is new in Bun?"}]};
const searchResults = {results: [{title: "Bun v1.4.4", url: "https://bun.com/blog/bun-v1.4.4", site_name: "Bun", date: "2026-10-22", snippet: "short", summary: "Bun 1.4.4 fixes 30 bugs.", rerank_score: 0.9}]};

async function gateway(answers: string[], tools: {search?: {status: number; body: unknown}; fetch?: {status: number; body: unknown}} = {}) {
    const models: Json[] = [];
    const toolCalls: Array<{path: string; body: Json; authorization: string | undefined}> = [];
    const server: Server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Json;
            if (request.url === "/responses") {
                models.push(body);
                response.writeHead(200, {"content-type": "text/event-stream"}).end(answers[models.length - 1]);
                return;
            }
            toolCalls.push({path: request.url!, body, authorization: request.headers.authorization});
            const reply = request.url === "/v1/tools/search" ? (tools.search ?? {status: 200, body: searchResults}) : tools.fetch!;
            response.writeHead(reply.status, {"content-type": "application/json"}).end(JSON.stringify(reply.body));
        });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    cleanup.push(() => {
        server.closeAllConnections();
        server.close();
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No TCP address");
    return {base: `http://127.0.0.1:${address.port}`, models, toolCalls};
}

async function proxyRoute(base: string, webSearch = true): Promise<string> {
    const proxy = new ResponsesProxy("external");
    cleanup.push(() => proxy.close());
    return await proxy.route(base, {authorization: "Bearer sk-gateway"}, webSearch);
}

async function ask(route: string, input: Json[], tools: Json[] = [shell, hosted]): Promise<Json[]> {
    const response = await fetch(`${route}/responses`, {method: "POST", body: JSON.stringify({model: "deepseek-flash", stream: true, tools, input})});
    expect(response.status).toBe(200);
    return (await response.text())
        .trim()
        .split("\n\n")
        .map(block => JSON.parse(block.split("\n")[1]!.slice("data: ".length)) as Json);
}

describe("hosted web search on a gateway that serves DeepSeek's search endpoints", () => {
    it("runs the model's search and lets the model answer within one response", async () => {
        const upstream = await gateway([
            answer("resp_1", [reasoning("rs_1"), call("fc_1", "web_search", {query: "bun release"})], usage(10, 5)),
            answer("resp_2", [text("msg_1", "Bun 1.4.4 is out: https://bun.com/blog/bun-v1.4.4")], usage(40, 8)),
        ]);
        const events = await ask(await proxyRoute(upstream.base), [user]);

        // The model is offered functions, never the hosted tool it would ignore.
        expect(upstream.models[0]!["tools"].map((tool: Json) => tool["name"] ?? tool["type"])).toEqual(["exec_command", "web_search", "web_open_page"]);
        expect(upstream.toolCalls).toEqual([{path: "/v1/tools/search", body: {query: "bun release", count: 8}, authorization: "Bearer sk-gateway"}]);
        // The model continues with its own call and the search result.
        const followUp = upstream.models[1]!["input"] as Json[];
        expect(followUp.map(item => item["type"])).toEqual(["message", "reasoning", "function_call", "function_call_output"]);
        expect(JSON.parse(followUp[3]!["output"])).toEqual([{title: "Bun v1.4.4", url: "https://bun.com/blog/bun-v1.4.4", site: "Bun", date: "2026-10-22", snippet: "Bun 1.4.4 fixes 30 bugs."}]);

        // Codex receives one response: the search as a web_search_call, then the answer.
        expect(events.filter(event => event["type"] === "response.created")).toHaveLength(1);
        expect(events.filter(event => event["type"] === "response.completed")).toHaveLength(1);
        expect(events.some(event => String(event["type"]).startsWith("response.function_call_arguments"))).toBe(false);
        const done = events.filter(event => event["type"] === "response.output_item.done");
        expect(done.map(event => [event["output_index"], event["item"]["type"]])).toEqual([[0, "reasoning"], [1, "web_search_call"], [2, "message"]]);
        expect(done[1]!["item"]).toEqual({type: "web_search_call", id: "ws_call_fc_1", status: "completed", action: {type: "search", query: "bun release"}});
        expect(events.map(event => event["sequence_number"])).toEqual(events.map((_event, index) => index));
        const completed = events.at(-1)!["response"];
        expect(completed["usage"]).toEqual({input_tokens: 50, output_tokens: 13, total_tokens: 63, output_tokens_details: {reasoning_tokens: 2}});
        expect(completed["output"].map((item: Json) => item["type"])).toEqual(["reasoning", "web_search_call", "message"]);
    });

    it("ends the response when the model also calls a Codex tool, and gives it the search result on the next request", async () => {
        const upstream = await gateway([
            answer("resp_1", [call("fc_1", "web_search", {query: "bun release"}), call("fc_2", "exec_command", {cmd: "bun --version"})], usage(10, 5)),
            answer("resp_2", [text("msg_1", "done")], usage(20, 2)),
        ]);
        const route = await proxyRoute(upstream.base);
        const first = await ask(route, [user]);
        expect(upstream.models).toHaveLength(1);
        const items = first.filter(event => event["type"] === "response.output_item.done").map(event => event["item"]);
        expect(items.map(item => item["type"])).toEqual(["web_search_call", "function_call"]);
        expect(items[1]!["name"]).toBe("exec_command");

        // Codex echoes the bare web_search_call; the model needs its own call and the result back.
        await ask(route, [user, items[0]!, items[1]!, {type: "function_call_output", call_id: "call_fc_2", output: "1.4.4"}]);
        const input = upstream.models[1]!["input"] as Json[];
        expect(input.map(item => [item["type"], item["call_id"] ?? item["role"]])).toEqual([
            ["message", "user"],
            ["function_call", "call_fc_1"],
            ["function_call_output", "call_fc_1"],
            ["function_call", "call_fc_2"],
            ["function_call_output", "call_fc_2"],
        ]);
    });

    it("reads a page for the model", async () => {
        const upstream = await gateway(
            [answer("resp_1", [call("fc_1", "web_open_page", {url: "https://bun.com/blog"})], usage(1, 1)), answer("resp_2", [text("msg_1", "read")], usage(1, 1))],
            {fetch: {status: 200, body: {title: "Blog | Bun", content: "x".repeat(30_000)}}},
        );
        const events = await ask(await proxyRoute(upstream.base), [user]);
        expect(upstream.toolCalls[0]).toMatchObject({path: "/v1/tools/fetch", body: {url: "https://bun.com/blog"}});
        expect(events.find(event => event["type"] === "response.output_item.done")!["item"]["action"]).toEqual({type: "open_page", url: "https://bun.com/blog"});
        const output = (upstream.models[1]!["input"] as Json[]).at(-1)!["output"] as string;
        expect(output.startsWith("# Blog | Bun\n\n")).toBe(true);
        expect(output.endsWith("[The page continues; 6000 more characters were left out.]")).toBe(true);
    });

    it("tells the model when a search fails and marks the call failed", async () => {
        const upstream = await gateway(
            [answer("resp_1", [call("fc_1", "web_search", {query: "bun"})], usage(1, 1)), answer("resp_2", [text("msg_1", "I could not search.")], usage(1, 1))],
            {search: {status: 429, body: {error: {message: "rate limited"}}}},
        );
        const events = await ask(await proxyRoute(upstream.base), [user]);
        expect(events.find(event => event["type"] === "response.output_item.done")!["item"]["status"]).toBe("failed");
        expect((upstream.models[1]!["input"] as Json[]).at(-1)!["output"]).toContain("Search failed (429)");
    });

    it("leaves a request without the hosted tool, and any other gateway, untouched", async () => {
        const plain = await gateway([answer("resp_1", [text("msg_1", "hi")], usage(1, 1))]);
        await ask(await proxyRoute(plain.base), [user], [shell]);
        expect(plain.models[0]!["tools"]).toEqual([shell]);
        const other = await gateway([answer("resp_1", [text("msg_1", "hi")], usage(1, 1))]);
        await ask(await proxyRoute(other.base, false), [user]);
        expect(other.models[0]!["tools"]).toEqual([shell, hosted]);
    });
});
