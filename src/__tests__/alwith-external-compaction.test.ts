import {describe, expect, it} from "vitest";

import type {ServerResponse} from "node:http";
import {finished} from "node:stream/promises";

import {CompactionSink, compactionResponse, expandSummaries, summaryRequest} from "../alwith/codex/externalCompaction";
import {compatibleResponsesRequest} from "../alwith/codex/responsesCompatibility";

const user = (text: string) => ({type: "message", role: "user", content: [{type: "input_text", text}]});
const sse = (...events: Array<Record<string, unknown>>) => events.map(event => `event: ${String(event["type"])}\ndata: ${JSON.stringify(event)}\n\n`).join("");
const answer = (text: string) =>
    sse(
        {type: "response.created", response: {id: "resp_1"}},
        {type: "response.output_item.done", output_index: 0, item: {type: "reasoning", id: "rs_1", summary: []}},
        {type: "response.output_item.done", output_index: 1, item: {type: "message", role: "assistant", content: [{type: "output_text", text}]}},
        {type: "response.completed", response: {id: "resp_1", usage: {input_tokens: 7, output_tokens: 3, total_tokens: 10}}},
    );
const events = (stream: string) =>
    stream
        .trim()
        .split("\n\n")
        .map(block => JSON.parse(block.split("\n")[1]!.slice("data: ".length)) as Record<string, any>);

describe("remote compaction for upstreams that are not OpenAI", () => {
    it("asks the model for Codex's handoff summary without tools", () => {
        const request = {
            model: "deepseek-flash",
            stream: true,
            tools: [{type: "function", name: "exec_command"}],
            tool_choice: "auto",
            parallel_tool_calls: true,
            input: [user("hello"), {type: "compaction_trigger"}],
        };
        const summary = summaryRequest(request)!;
        expect(summary).not.toHaveProperty("tools");
        expect(summary).not.toHaveProperty("tool_choice");
        expect(summary).not.toHaveProperty("parallel_tool_calls");
        expect(summary["model"]).toBe("deepseek-flash");
        const input = summary["input"] as Array<Record<string, any>>;
        expect(input).toHaveLength(2);
        expect(input[0]).toEqual(user("hello"));
        expect(input[1]!["content"][0]["text"]).toMatch(/^You are performing a CONTEXT CHECKPOINT COMPACTION\./);
    });

    it("leaves every other request alone", () => {
        expect(summaryRequest({model: "m", input: [user("hello")]})).toBeNull();
        expect(summaryRequest({model: "m", input: [{type: "compaction_trigger"}, user("later")]})).toBeNull();
        expect(summaryRequest({model: "m", input: "hello"})).toBeNull();
    });

    it("returns the summary as the single compaction item Codex requires, with the model's usage", () => {
        const [created, added, done, completed] = events(compactionResponse(answer("Progress: half done.")));
        expect(created!["type"]).toBe("response.created");
        expect(added!["type"]).toBe("response.output_item.added");
        expect(done!["item"]["type"]).toBe("compaction");
        expect(completed!["response"]["output"]).toEqual([done!["item"]]);
        expect(completed!["response"]["usage"]).toEqual({input_tokens: 7, output_tokens: 3, total_tokens: 10});
    });

    it("gives the summary back to the model in later requests", () => {
        const item = events(compactionResponse(answer("Progress: half done. 进度过半。")))[2]!["item"];
        const input = [user("kept"), item, user("next")];
        const expanded = expandSummaries(input) as Array<Record<string, any>>;
        expect(expanded[0]).toBe(input[0]);
        expect(expanded[2]).toBe(input[2]);
        expect(expanded[1]!["role"]).toBe("user");
        expect(expanded[1]!["content"][0]["text"]).toMatch(/^Another language model started to solve this problem[\s\S]*:\nProgress: half done\. 进度过半。$/);
    });

    it("leaves OpenAI's own compaction items and unrelated history untouched", () => {
        const input = [user("kept"), {type: "compaction", id: "cmp_1", encrypted_content: "gAAAAAopaque"}];
        expect(expandSummaries(input)).toBe(input);
    });

    it("expands the summary whichever upstream the request goes to", () => {
        const item = events(compactionResponse(answer("SUMMARY")))[2]!["item"];
        for (const destination of ["native", "external"] as const) {
            const sent = JSON.parse(compatibleResponsesRequest(JSON.stringify({model: "m", input: [item, user("next")]}), destination));
            expect(sent.input).toHaveLength(2);
            expect(sent.input[0].type).toBe("message");
            expect(sent.input[0].content[0].text.endsWith("SUMMARY")).toBe(true);
        }
    });

    it("fails instead of compacting to nothing", () => {
        expect(() => compactionResponse(answer("  "))).toThrow("empty compaction summary");
        expect(() => compactionResponse(sse({type: "response.created", response: {id: "resp_1"}}))).toThrow("without response.completed");
        expect(() =>
            compactionResponse(sse({type: "response.created", response: {id: "resp_1"}}, {type: "response.failed", response: {id: "resp_1", error: {message: "overloaded"}}})),
        ).toThrow("did not complete the compaction summary");
    });

    function client() {
        const sent = {status: 0, headers: {} as Record<string, unknown>, body: ""};
        const response = {
            writeHead(status: number, headers: Record<string, unknown>) {
                sent.status = status;
                sent.headers = headers;
                return response;
            },
            end(body: string | Buffer) {
                sent.body = body.toString();
            },
        };
        return {sent, response: response as unknown as ServerResponse};
    }

    it("answers the client with the compaction once the model's summary is complete", async () => {
        const {sent, response} = client();
        const sink = new CompactionSink(response);
        sink.writeHead(200, {"content-type": "text/event-stream", "content-length": "1", "x-request-id": "req_1"});
        const stream = answer("SUMMARY");
        sink.write(stream.slice(0, 40));
        sink.end(stream.slice(40));
        await finished(sink);
        expect(sent.status).toBe(200);
        expect(sent.headers).toEqual({"content-type": "text/event-stream", "x-request-id": "req_1"});
        expect(events(sent.body)[2]!["item"]["type"]).toBe("compaction");
    });

    it("passes an upstream error through unchanged", async () => {
        const {sent, response} = client();
        const sink = new CompactionSink(response);
        sink.writeHead(400, {"content-type": "application/json"});
        sink.end('{"error":{"message":"unknown model"}}');
        await finished(sink);
        expect(sent).toEqual({status: 400, headers: {"content-type": "application/json"}, body: '{"error":{"message":"unknown model"}}'});
    });

    it("reports a summary it cannot use as a gateway error", async () => {
        const {sent, response} = client();
        const sink = new CompactionSink(response);
        sink.writeHead(200, {"content-type": "text/event-stream"});
        sink.end(answer(""));
        await finished(sink);
        expect(sent.status).toBe(502);
        expect(sent.body).toContain("empty compaction summary");
    });
});
