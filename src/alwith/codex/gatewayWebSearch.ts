import {isRecord} from "../../permissions/json";

/**
 * Hosted web search for gateways that serve DeepSeek's search endpoints.
 *
 * Codex offers every model the same hosted tool, `{type: "web_search"}`, which OpenAI runs on its
 * servers. DeepSeek accepts the tool and never runs it. It does publish the search and page reader of
 * its own app as plain endpoints, `/v1/tools/search` and `/v1/tools/fetch`, and a gateway in front of
 * DeepSeek can forward them. For a gateway that says it serves them (`_meta.alwith.webSearch`) the
 * proxy runs the tool: the model gets two functions instead of the hosted tool, the proxy answers
 * their calls from the gateway's endpoints and lets the model go on, and Codex receives each call as
 * the `web_search_call` item it would get from OpenAI.
 */

type Json = Record<string, unknown>;

const SEARCH = "web_search";
const OPEN_PAGE = "web_open_page";
const RESULT_COUNT = 8;
const PAGE_CHARACTERS = 24_000;
/** A model that keeps searching is cut off here; OpenAI bounds its own hosted tool the same way. */
const MAX_ROUNDS = 8;
const REMEMBERED_CALLS = 512;

const FUNCTIONS: Json[] = [
    {
        type: "function",
        name: SEARCH,
        description:
            "Search the web. Returns titles, URLs, dates and snippets. Use it for anything recent or that you are not sure about, and cite the URLs you rely on.",
        strict: false,
        parameters: {
            type: "object",
            properties: {query: {type: "string", description: "The search query."}},
            required: ["query"],
            additionalProperties: false,
        },
    },
    {
        type: "function",
        name: OPEN_PAGE,
        description: "Read a web page as Markdown. Use it on a URL from the search results or from the user when the snippet is not enough.",
        strict: false,
        parameters: {
            type: "object",
            properties: {url: {type: "string", description: "The http(s) URL of the page."}},
            required: ["url"],
            additionalProperties: false,
        },
    },
];

/** What the relay needs from the proxy: the model endpoint and DeepSeek's two tool endpoints. */
export type SearchUpstream = {
    responses(body: string): Promise<Response>;
    tool(name: "search" | "fetch", body: string): Promise<Response>;
};

/** A search the model made in this process: the call and its result, as the model has to see them again. */
type Remembered = {call: Json; output: Json};

export class GatewayWebSearch {
    private readonly remembered = new Map<string, Remembered>();

    /** The request with functions in place of the hosted tool, or `null` when the hosted tool is not offered. */
    request(request: Json): Json | null {
        const tools = request["tools"];
        if (!Array.isArray(tools) || !tools.some((tool: unknown) => isRecord(tool) && tool["type"] === "web_search")) return null;
        const input = request["input"];
        return {
            ...request,
            tools: tools.flatMap((tool: unknown) => (isRecord(tool) && tool["type"] === "web_search" ? FUNCTIONS : [tool])),
            ...(Array.isArray(input) ? {input: this.history(input)} : {}),
            stream: true,
        };
    }

    /**
     * Codex sends a search back as the bare `web_search_call`. While this process remembers its result
     * the model gets the call and the result again, which it needs to go on within the same turn.
     * Later the model sees only that it searched, exactly as with OpenAI's hosted tool.
     */
    private history(input: unknown[]): unknown[] {
        return input.flatMap((item: unknown) => {
            const known = isRecord(item) && item["type"] === "web_search_call" && typeof item["id"] === "string" ? this.remembered.get(item["id"]) : undefined;
            return known ? [known.call, known.output] : [item];
        });
    }

    /**
     * Relays the model's answer to `write` as one Responses stream, running the model's searches in
     * between. `first` is the already opened answer to `request`.
     */
    async relay(request: Json, first: Response, upstream: SearchUpstream, write: (chunk: string) => void): Promise<void> {
        let sequence = 0;
        let nextIndex = 0;
        const emitted: Json[] = [];
        const usage: Json = {};
        const send = (event: Json): void => {
            write(`event: ${String(event["type"])}\ndata: ${JSON.stringify({...event, sequence_number: sequence++})}\n\n`);
        };
        let body = request;
        let answer = first;
        for (let round = 0; ; round++) {
            const indexes = new Map<number, number>();
            const index = (upstreamIndex: unknown): number => {
                if (typeof upstreamIndex !== "number") throw new Error("A Responses stream event has no output_index");
                let mapped = indexes.get(upstreamIndex);
                if (mapped === undefined) indexes.set(upstreamIndex, (mapped = nextIndex++));
                return mapped;
            };
            const own = new Set<string>();
            const items: Json[] = [];
            const outputs: Json[] = [];
            let clientCalls = false;
            let completed: Json | undefined;
            for await (const event of events(answer)) {
                const type = event["type"];
                const item = isRecord(event["item"]) ? event["item"] : undefined;
                if (type === "response.created" || type === "response.in_progress") {
                    if (round === 0) send(event);
                } else if (type === "response.completed") {
                    completed = isRecord(event["response"]) ? event["response"] : {};
                    add(usage, completed["usage"]);
                } else if (type === "response.failed" || type === "response.incomplete" || type === "error") {
                    send(event);
                    return;
                } else if (type === "response.output_item.added" && item && ownCall(item)) {
                    own.add(String(item["id"]));
                    index(event["output_index"]);
                } else if (type === "response.output_item.done" && item && ownCall(item)) {
                    const position = index(event["output_index"]);
                    const callId = String(item["call_id"]);
                    const id = `ws_${callId}`;
                    const action = actionOf(item);
                    send({type: "response.output_item.added", output_index: position, item: {type: "web_search_call", id, status: "in_progress", action}});
                    const result = await run(item, upstream);
                    const call = {type: "web_search_call", id, status: result.ok ? "completed" : "failed", action};
                    send({type: "response.output_item.done", output_index: position, item: call});
                    emitted.push(call);
                    const output = {type: "function_call_output", call_id: callId, output: result.text};
                    items.push(item);
                    outputs.push(output);
                    this.remember(id, {call: item, output});
                } else if (typeof event["item_id"] === "string" && own.has(event["item_id"])) {
                    // The model's arguments for a search stay inside the proxy.
                } else {
                    if (type === "response.output_item.done" && item) {
                        items.push(item);
                        emitted.push(item);
                        if (item["type"] === "function_call" || item["type"] === "custom_tool_call") clientCalls = true;
                    }
                    send("output_index" in event ? {...event, output_index: index(event["output_index"])} : event);
                }
            }
            if (!completed) throw new Error("The model's answer ended without response.completed");
            // Codex has to run its own tools before the model goes on, so the stream ends with them.
            if (outputs.length === 0 || clientCalls) {
                send({type: "response.completed", response: {...completed, output: emitted, usage}});
                return;
            }
            if (round + 1 === MAX_ROUNDS) {
                send({
                    type: "response.failed",
                    response: {...completed, status: "failed", error: {code: "server_error", message: `The model searched ${MAX_ROUNDS} times in a row without answering.`}},
                });
                return;
            }
            body = {...body, input: [...(body["input"] as unknown[]), ...items, ...outputs]};
            answer = await upstream.responses(JSON.stringify(body));
            if (!answer.ok) {
                send({
                    type: "response.failed",
                    response: {...completed, status: "failed", error: {code: "server_error", message: `${answer.status} ${(await answer.text()).slice(0, 2000)}`}},
                });
                return;
            }
        }
    }

    private remember(id: string, call: Remembered): void {
        this.remembered.set(id, call);
        if (this.remembered.size > REMEMBERED_CALLS) this.remembered.delete(this.remembered.keys().next().value!);
    }
}

function ownCall(item: Json): boolean {
    return item["type"] === "function_call" && (item["name"] === SEARCH || item["name"] === OPEN_PAGE);
}

function argumentsOf(item: Json): Json {
    try {
        const parsed: unknown = JSON.parse(String(item["arguments"]));
        return isRecord(parsed) ? parsed : {};
    } catch {
        // The model wrote arguments that are not JSON; `run` tells it so.
        return {};
    }
}

function actionOf(item: Json): Json {
    const args = argumentsOf(item);
    return item["name"] === SEARCH
        ? {type: "search", query: typeof args["query"] === "string" ? args["query"] : ""}
        : {type: "open_page", url: typeof args["url"] === "string" ? args["url"] : ""};
}

/** Runs one search or page read. A failure is an answer too: the model reads it and decides what to do. */
async function run(item: Json, upstream: SearchUpstream): Promise<{ok: boolean; text: string}> {
    const args = argumentsOf(item);
    const search = item["name"] === SEARCH;
    const value = search ? args["query"] : args["url"];
    if (typeof value !== "string" || !value.trim()) return {ok: false, text: `Expected a non-empty "${search ? "query" : "url"}" string.`};
    const response = search
        ? await upstream.tool("search", JSON.stringify({query: value, count: RESULT_COUNT}))
        : await upstream.tool("fetch", JSON.stringify({url: value}));
    const text = await response.text();
    if (!response.ok) return {ok: false, text: `${search ? "Search" : "Reading the page"} failed (${response.status}): ${text.slice(0, 1000)}`};
    const data: unknown = JSON.parse(text);
    if (!isRecord(data)) throw new Error("DeepSeek's tool endpoint returned no object");
    if (!search) {
        const content = String(data["content"]);
        const page = content.length > PAGE_CHARACTERS ? `${content.slice(0, PAGE_CHARACTERS)}\n\n[The page continues; ${content.length - PAGE_CHARACTERS} more characters were left out.]` : content;
        return {ok: true, text: `# ${String(data["title"])}\n\n${page}`};
    }
    if (!Array.isArray(data["results"])) throw new Error("DeepSeek's search returned no results list");
    return {
        ok: true,
        text: JSON.stringify(
            (data["results"] as unknown[]).filter(isRecord).map(result => ({
                title: result["title"],
                url: result["url"],
                site: result["site_name"],
                date: result["date"],
                snippet: result["summary"] || result["snippet"],
            })),
        ),
    };
}

function add(total: Json, usage: unknown): void {
    if (!isRecord(usage)) return;
    for (const [key, value] of Object.entries(usage)) {
        if (typeof value === "number") total[key] = (typeof total[key] === "number" ? total[key] : 0) + value;
        else if (isRecord(value)) add((total[key] ??= {}) as Json, value);
        else total[key] ??= value;
    }
}

/** The events of a Responses stream, in order. */
async function* events(response: Response): AsyncGenerator<Json> {
    if (!response.body) throw new Error("The model's answer has no body");
    const decoder = new TextDecoder();
    let pending = "";
    const parse = function* (block: string): Generator<Json> {
        const data = block
            .split(/\r?\n/)
            .filter(line => line.startsWith("data:"))
            .map(line => line.slice("data:".length).trimStart())
            .join("\n");
        if (!data || data === "[DONE]") return;
        const event: unknown = JSON.parse(data);
        if (isRecord(event)) yield event;
    };
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        pending += decoder.decode(chunk, {stream: true});
        for (let end = pending.search(/\r?\n\r?\n/); end !== -1; end = pending.search(/\r?\n\r?\n/)) {
            yield* parse(pending.slice(0, end));
            pending = pending.slice(end).replace(/^\r?\n\r?\n/, "");
        }
    }
    yield* parse(pending + decoder.decode());
}
