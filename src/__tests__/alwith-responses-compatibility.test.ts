import { describe, expect, it } from "vitest";

import { compatibleResponsesRequest } from "../alwith/codex/responsesCompatibility";

describe("native Responses history compatibility", () => {
    it("omits foreign plaintext reasoning even when it has encrypted content, preserving tool pairs and native reasoning", () => {
        const items = [
            {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: "hello" }],
            },
            {
                type: "reasoning",
                summary: [],
                content: [{ type: "reasoning_text", text: "foreign" }],
                encrypted_content: "foreign-token",
            },
            {
                type: "reasoning",
                summary: [],
                content: [{ type: "text", text: "plaintext" }],
            },
            {
                type: "reasoning",
                summary: [{ type: "summary_text", text: "native" }],
                encrypted_content: "native-token",
            },
            {
                type: "reasoning",
                content: [],
                encrypted_content: "native-token-2",
            },
            {
                type: "function_call",
                call_id: "call",
                name: "tool",
                arguments: "{}",
            },
            { type: "function_call_output", call_id: "call", output: "result" },
        ];
        const raw = JSON.stringify({
            type: "response.create",
            model: "gpt-test",
            previous_response_id: "previous",
            input: items,
        });
        const output = compatibleResponsesRequest(raw);
        expect(JSON.parse(output)).toEqual({
            type: "response.create",
            model: "gpt-test",
            previous_response_id: "previous",
            input: [items[0], items[3], items[4], items[5], items[6]],
        });
        expect((JSON.parse(raw) as { input: unknown[] }).input).toHaveLength(7);
        expect(compatibleResponsesRequest(output)).toBe(output);
    });
    it("omits native historical tool declarations for external endpoints without dropping conversation or tool pairs", () => {
        const input = [
            {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: "remember token" }],
            },
            {
                type: "additional_tools",
                tools: [{ type: "custom", name: "exec" }],
            },
            { type: "reasoning", summary: [], encrypted_content: "opaque" },
            {
                type: "function_call",
                name: "read_file",
                call_id: "call",
                arguments: "{}",
            },
            {
                type: "function_call_output",
                call_id: "call",
                output: "contents",
            },
        ];
        const request = {
            model: "external-model",
            tools: [{ type: "function", name: "read_file" }],
            input,
        };
        const raw = JSON.stringify(request);
        expect(JSON.parse(compatibleResponsesRequest(raw, "external"))).toEqual(
            { ...request, input: [input[0], ...input.slice(2)] },
        );
        expect(compatibleResponsesRequest(raw)).toBe(raw);
    });
    it("preserves requests without incompatible input byte for byte", () => {
        for (const raw of [
            '{ "type": "response.cancel" }',
            '{ "input": [] }',
            '{"input":"hello"}',
        ])
            expect(compatibleResponsesRequest(raw)).toBe(raw);
    });
    it("rejects malformed JSON rather than forwarding an unexamined request", () => {
        expect(() => compatibleResponsesRequest("not json")).toThrow();
    });
});
