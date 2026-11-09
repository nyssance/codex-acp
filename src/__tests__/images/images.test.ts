import { afterEach, describe, expect, test, vi } from "vitest";
import { generateImage } from "../../alwith/codex/images";
import type { AppServerClient } from "../../alwith/codex/AppServerClient";
import { AcpToolCallRenderer } from "../../tool-calls/AcpToolCallRenderer";
import { ClientCapabilities } from "../../tool-calls/ClientCapabilities";
import { DynamicToolReporter, displayBlock } from "../../tool-calls/reporters/DynamicToolReporter";
vi.mock("../../alwith/codex/nativeFetch", () => ({ nativeFetch: vi.fn() }));
import { nativeFetch } from "../../alwith/codex/nativeFetch";
const request = vi.mocked(nativeFetch);
const routing = {
    backendOrigin: "https://chatgpt.com",
    chatgptAccountId: "test-account",
};
function fixture() {
    return {
        accountRead: vi.fn(async () => ({
            account: { type: "chatgpt" },
            workspaceRouting: routing,
        })),
        getAuthStatus: vi.fn(async () => ({
            authMethod: "chatgpt",
            authToken: "private-token",
        })),
        disconnectSignal: new AbortController().signal,
    };
}
afterEach(() => vi.resetAllMocks());
describe("authenticated image capability", () => {
    test("uses the account auth owner, routes edits and returns media without credentials", async () => {
        const codex = fixture();
        request.mockResolvedValue(
            new Response(
                JSON.stringify({
                    data: [{ b64_json: "aGVsbG8=" }],
                    output_format: "png",
                }),
            ),
        );
        const result = await generateImage(
            codex as unknown as AppServerClient,
            {
                prompt: "Make it blue",
                images: ["data:image/png;base64,aGVsbG8="],
            },
        );
        expect(String(request.mock.calls[0]![0])).toBe(
            "https://chatgpt.com/backend-api/wham/images/edits",
        );
        expect(JSON.parse(String(request.mock.calls[0]![1]?.body))).toEqual({
            prompt: "Make it blue",
            images: [{ image_url: "data:image/png;base64,aGVsbG8=" }],
        });
        expect(result).toEqual({
            images: [{ mimeType: "image/png", data: "aGVsbG8=" }],
        });
        expect(JSON.stringify(result)).not.toContain("private-token");
    });
    test("refreshes only after a 401 and never retries an ambiguous provider failure", async () => {
        const codex = fixture();
        request
            .mockResolvedValueOnce(new Response("", { status: 401 }))
            .mockResolvedValueOnce(new Response("", { status: 503 }));
        await expect(
            generateImage(codex as unknown as AppServerClient, {
                prompt: "A tree",
            }),
        ).rejects.toThrow("HTTP 503");
        expect(codex.getAuthStatus.mock.calls).toEqual([
            [{ includeToken: true, refreshToken: false }],
            [{ includeToken: true, refreshToken: true }],
        ]);
        expect(request).toHaveBeenCalledTimes(2);
    });
    test.each([
        [{ error: { message: "Image access is unavailable", code: "image_access_denied" } }, "Image access is unavailable; code: image_access_denied"],
        [{ detail: [{ msg: "Field required", loc: ["body", "model"] }] }, "Field required"],
        [{ detail: "Account image quota exceeded" }, "Account image quota exceeded"],
    ])("preserves the service rejection without retrying: %j", async (body, message) => {
        request.mockResolvedValue(new Response(JSON.stringify(body), {
            status: 400,
            headers: { "x-request-id": "image-request" },
        }));
        await expect(generateImage(fixture() as unknown as AppServerClient, { prompt: "A tree" }))
            .rejects.toThrow(`HTTP 400): ${message}; request ID: image-request`);
        expect(request).toHaveBeenCalledOnce();
    });
    test("never forwards an echoed credential or image data", async () => {
        request.mockResolvedValue(new Response(JSON.stringify({
            error: { message: "private-token Bearer other-secret data:image/png;base64,aGVsbG8=" },
        }), { status: 400 }));
        await expect(generateImage(fixture() as unknown as AppServerClient, { prompt: "A tree" }))
            .rejects.toThrow("HTTP 400): [redacted] Bearer [redacted] [image data]");
    });
    test("cancels an unbounded error body and retains its HTTP status", async () => {
        const cancel = vi.fn();
        let bytes = 0;
        const body = new ReadableStream<Uint8Array>({
            pull(controller) {
                const chunk = new Uint8Array(4096).fill(32);
                bytes += chunk.byteLength;
                controller.enqueue(chunk);
            },
            cancel,
        });
        request.mockResolvedValue(new Response(body, { status: 400 }));
        await expect(generateImage(fixture() as unknown as AppServerClient, { prompt: "A tree" }))
            .rejects.toThrow("Image generation failed (HTTP 400)");
        expect(cancel).toHaveBeenCalledOnce();
        expect(bytes).toBeLessThanOrEqual(32 * 1024 + 2 * 4096);
    });
    test.each(["<html>private-token</html>", ""])("retains HTTP failures without structured diagnostics", async (body) => {
        request.mockResolvedValue(new Response(body, { status: 403 }));
        await expect(generateImage(fixture() as unknown as AppServerClient, { prompt: "A tree" }))
            .rejects.toThrow("Image generation failed (HTTP 403)");
    });
    test("refuses a foreign backend before obtaining a bearer", async () => {
        const codex = fixture();
        codex.accountRead.mockResolvedValue({
            account: { type: "chatgpt" },
            workspaceRouting: {
                ...routing,
                backendOrigin: "https://example.com",
            },
        });
        await expect(
            generateImage(codex as unknown as AppServerClient, {
                prompt: "A tree",
            }),
        ).rejects.toThrow("Unsupported");
        expect(codex.getAuthStatus).not.toHaveBeenCalled();
        expect(request).not.toHaveBeenCalled();
    });
    test.each([undefined, "1"])(
        "cancels oversized image streams with Content-Length %s",
        async (length) => {
            const codex = fixture();
            const cancel = vi.fn();
            let bytes = 0;
            const body = new ReadableStream<Uint8Array>({
                pull(controller) {
                    // Multi-byte UTF-8 also verifies the limit counts bytes, not characters.
                    const chunk = new Uint8Array(64 * 1024).fill(0xc2);
                    for (let index = 1; index < chunk.length; index += 2)
                        chunk[index] = 0xa0;
                    bytes += chunk.byteLength;
                    controller.enqueue(chunk);
                },
                cancel,
            });
            request.mockResolvedValue(
                new Response(body, {
                    headers: length ? { "Content-Length": length } : {},
                }),
            );
            await expect(
                generateImage(codex as unknown as AppServerClient, {
                    prompt: "A tree",
                }),
            ).rejects.toThrow("ACP media limit");
            expect(cancel).toHaveBeenCalledOnce();
            expect(bytes).toBeLessThanOrEqual(15 * 1024 * 1024 + 2 * 64 * 1024);
            expect(request).toHaveBeenCalledOnce();
        },
    );
    test("decodes image JSON across split UTF-8 chunks", async () => {
        const codex = fixture();
        const encoded = new TextEncoder().encode(
            JSON.stringify({
                data: [{ b64_json: "aGVsbG8=" }],
                description: "蓝",
            }),
        );
        const split = encoded.indexOf(0xe8) + 1;
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(encoded.slice(0, split));
                controller.enqueue(encoded.slice(split));
                controller.close();
            },
        });
        request.mockResolvedValue(new Response(body));
        await expect(
            generateImage(codex as unknown as AppServerClient, {
                prompt: "A tree",
            }),
        ).resolves.toEqual({
            images: [{ mimeType: "image/png", data: "aGVsbG8=" }],
        });
    });
    test("discards media when the account changed in flight", async () => {
        const codex = fixture();
        request.mockResolvedValue(
            new Response(JSON.stringify({ data: [{ b64_json: "aGVsbG8=" }] })),
        );
        codex.accountRead
            .mockResolvedValueOnce({
                account: { type: "chatgpt" },
                workspaceRouting: routing,
            })
            .mockResolvedValueOnce({
                account: { type: "chatgpt" },
                workspaceRouting: { ...routing, chatgptAccountId: "other" },
            });
        await expect(
            generateImage(codex as unknown as AppServerClient, {
                prompt: "A tree",
            }),
        ).rejects.toThrow("account changed");
    });
});
test("live output and history both carry standard ACP image blocks", () => {
    const content = {
        type: "inputImage" as const,
        imageUrl: "data:image/png;base64,aGVsbG8=",
    };
    const expected = { type: "image", mimeType: "image/png", data: "aGVsbG8=" };
    expect(displayBlock(content)).toEqual(expected);
    const frame = new AcpToolCallRenderer(ClientCapabilities.from({})).render(
        DynamicToolReporter.completed({
            type: "dynamicToolCall",
            id: "image-tool",
            tool: "alwith_client_generate_image",
            namespace: null,
            arguments: {},
            status: "completed",
            success: true,
            durationMs: 5,
            contentItems: [content],
        }),
    );
    expect(frame).toMatchObject({ content: [{ type: "content", content: expected }] });
});
