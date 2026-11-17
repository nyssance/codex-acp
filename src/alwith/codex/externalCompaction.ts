import type {OutgoingHttpHeaders, ServerResponse} from "node:http";
import {Writable} from "node:stream";
import {isRecord} from "../../permissions/json";

/**
 * Remote compaction for upstreams that are not OpenAI.
 *
 * Codex cannot move a thread to another model provider, so a thread that started on the built-in
 * OpenAI provider keeps it when the client selects a gateway model. For that provider Codex compacts
 * on the server: it ends the request input with a `compaction_trigger` item and requires exactly one
 * `compaction` output item, which it sends back in later requests. No other upstream implements this,
 * so the proxy does: it asks the upstream model for the handoff summary Codex itself asks for when it
 * compacts locally, returns it as the `compaction` item, and turns that item back into the summary
 * message in every later request.
 */

/** Codex's own local compaction prompt (`core/templates/compact/prompt.md`). */
const SUMMARY_REQUEST =
    "You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.\n\nInclude:\n- Current progress and key decisions made\n- Important context, constraints, or user preferences\n- What remains to be done (clear next steps)\n- Any critical data, examples, or references needed to continue\n\nBe concise, structured, and focused on helping the next LLM seamlessly continue the work.\n";
/** Codex's own summary preamble (`core/templates/compact/summary_prefix.md`). */
const SUMMARY_PREFIX =
    "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:\n";
const ENVELOPE = "alwith-compaction-v1:";

function userMessage(text: string): Record<string, unknown> {
    return {type: "message", role: "user", content: [{type: "input_text", text}]};
}

/** The request that asks the upstream model for the summary, or `null` when `request` is not a compaction. */
export function summaryRequest(request: Record<string, unknown>, transport: "http" | "websocket" = "http"): Record<string, unknown> | null {
    const input = request["input"];
    if (!Array.isArray(input)) return null;
    const last: unknown = input.at(-1);
    if (!isRecord(last) || last["type"] !== "compaction_trigger") return null;
    const {tools: _tools, tool_choice: _toolChoice, parallel_tool_calls: _parallel, stream: _stream, ...rest} = request;
    return {...rest, input: [...input.slice(0, -1), userMessage(SUMMARY_REQUEST)], ...(transport === "http" ? {stream: true} : {})};
}

/** Replaces the `compaction` items this proxy produced with the summary message they stand for. */
export function expandSummaries(input: unknown[]): unknown[] {
    let changed = false;
    const expanded = input.map((item: unknown) => {
        if (!isRecord(item) || item["type"] !== "compaction") return item;
        const content = item["encrypted_content"];
        if (typeof content !== "string" || !content.startsWith(ENVELOPE)) return item;
        changed = true;
        return userMessage(SUMMARY_PREFIX + Buffer.from(content.slice(ENVELOPE.length), "base64url").toString("utf8"));
    });
    return changed ? expanded : input;
}

/** Collects the same model events from SSE or WebSocket without exposing the summary as an assistant answer. */
export class CompactionResponse {
    private text = "";
    private completed: Record<string, unknown> | null = null;

    accept(event: unknown): void {
        if (!isRecord(event)) return;
        if (event["type"] === "response.failed" || event["type"] === "response.incomplete" || event["type"] === "error")
            throw new Error(`The model did not complete the compaction summary: ${JSON.stringify(event).slice(0, 2000)}`);
        if (event["type"] === "response.completed" && isRecord(event["response"])) this.completed = event["response"];
        const item = event["type"] === "response.output_item.done" ? event["item"] : undefined;
        if (!isRecord(item) || item["type"] !== "message" || !Array.isArray(item["content"])) return;
        for (const part of item["content"] as unknown[])
            if (isRecord(part) && part["type"] === "output_text" && typeof part["text"] === "string") this.text += part["text"];
    }

    events(): Array<Record<string, unknown>> {
        if (this.completed === null) throw new Error("The model's compaction summary ended without response.completed");
        if (!this.text.trim()) throw new Error("The model returned an empty compaction summary");
        const id = typeof this.completed["id"] === "string" ? this.completed["id"] : "resp_compaction";
        const item = {
            type: "compaction",
            id: `cmp_${id}`,
            encrypted_content: ENVELOPE + Buffer.from(this.text, "utf8").toString("base64url"),
        };
        return [
            {type: "response.created", response: {id}},
            {type: "response.output_item.added", output_index: 0, item},
            {type: "response.output_item.done", output_index: 0, item},
            {type: "response.completed", response: {...this.completed, output: [item]}},
        ];
    }
}

/** Turns an SSE summary into the same compaction events used by the WebSocket transport. */
export function compactionResponse(stream: string): string {
    const response = new CompactionResponse();
    for (const block of stream.split(/\r?\n\r?\n/)) {
        const data = block.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice("data:".length).trimStart()).join("\n");
        if (data && data !== "[DONE]") response.accept(JSON.parse(data));
    }
    return response.events().map(event => `event: ${event["type"]}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

/**
 * Stands in for the client response while the upstream answers a summary request. A successful
 * answer reaches the client as a compaction; anything else is passed through unchanged.
 */
export class CompactionSink extends Writable {
    private status = 200;
    private headers: OutgoingHttpHeaders = {};
    private readonly chunks: Buffer[] = [];

    private readonly client: ServerResponse;

    constructor(client: ServerResponse) {
        super();
        this.client = client;
    }

    writeHead(status: number, headers: OutgoingHttpHeaders = {}): this {
        this.status = status;
        this.headers = headers;
        return this;
    }

    override _write(chunk: Buffer | string, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
        this.chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
        done();
    }

    override _final(done: (error?: Error | null) => void): void {
        const body = Buffer.concat(this.chunks);
        if (this.status !== 200) {
            this.client.writeHead(this.status, this.headers).end(body);
            done();
            return;
        }
        let compaction: string;
        try {
            compaction = compactionResponse(body.toString("utf8"));
        } catch (error) {
            this.client.writeHead(502, {"content-type": "text/plain"}).end(error instanceof Error ? error.message : String(error));
            done();
            return;
        }
        const {"content-length": _length, "content-encoding": _encoding, ...headers} = this.headers;
        this.client.writeHead(200, {...headers, "content-type": "text/event-stream"}).end(compaction);
        done();
    }
}
