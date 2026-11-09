import { nativeFetch } from "./nativeFetch";
import type { AppServerClient } from "./AppServerClient";

export type ImageRequest = { prompt: string; images?: string[] };
export type ImageResult = { images: { mimeType: string; data: string }[] };

/** Credentials stay with the authenticated agent and never cross ACP. */
export async function generateImage(
    codex: AppServerClient,
    params: Record<string, unknown>,
    signal?: AbortSignal,
): Promise<ImageResult> {
    const prompt = params["prompt"];
    const images = params["images"] ?? [];
    if (
        typeof prompt !== "string" ||
        !prompt.trim() ||
        prompt.length > 32000 ||
        !Array.isArray(images) ||
        images.length > 16 ||
        images.some(
            (image) =>
                typeof image !== "string" ||
                !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(
                    image,
                ),
        ) ||
        JSON.stringify(images).length > 12 * 1024 * 1024
    )
        throw new Error(
            "Expected an image prompt and up to 16 inline image references (12 MiB total)",
        );
    const account = await codex.accountRead({ refreshToken: false });
    const routing = account.workspaceRouting;
    if (account.account?.type !== "chatgpt" || !routing)
        throw new Error("Sign in to ChatGPT to generate images");
    const origin = new URL(routing.backendOrigin);
    if (
        origin.protocol !== "https:" ||
        (origin.hostname !== "chatgpt.com" &&
            !origin.hostname.endsWith(".chatgpt.com"))
    )
        throw new Error("Unsupported ChatGPT image backend");
    const url = new URL(
        `/backend-api/wham/images/${images.length ? "edits" : "generations"}`,
        origin,
    );
    for (const refreshToken of [false, true]) {
        const auth = await codex.getAuthStatus({
            includeToken: true,
            refreshToken,
        });
        if (
            (auth.authMethod !== "chatgpt" &&
                auth.authMethod !== "chatgptAuthTokens") ||
            !auth.authToken
        )
            throw new Error(
                "ChatGPT credentials are unavailable; sign in again",
            );
        const response = await nativeFetch(url, {
            method: "POST",
            redirect: "error",
            headers: {
                Authorization: `Bearer ${auth.authToken}`,
                "ChatGPT-Account-ID": routing.chatgptAccountId,
                "Content-Type": "application/json",
                originator: "alwith-u",
            },
            body: JSON.stringify({
                prompt,
                ...(images.length
                    ? { images: images.map((image_url) => ({ image_url })) }
                    : {}),
            }),
            signal: AbortSignal.any([
                codex.disconnectSignal,
                AbortSignal.timeout(180000),
                ...(signal ? [signal] : []),
            ]),
        });
        if (response.status === 401 && !refreshToken) {
            await response.body?.cancel();
            continue;
        }
        if (!response.ok)
            throw await imageServiceError(response, auth.authToken);
        const result = await readImageResult(response);
        if (
            !result ||
            typeof result !== "object" ||
            !("data" in result) ||
            !Array.isArray(result.data) ||
            !result.data.length
        )
            throw new Error("Image service returned no images");
        const format = "output_format" in result ? result.output_format : "png";
        if (format !== "png" && format !== "jpeg" && format !== "webp")
            throw new Error("Unsupported image format");
        const output = result.data.map((item: unknown) => {
            if (
                !item ||
                typeof item !== "object" ||
                !("b64_json" in item) ||
                typeof item.b64_json !== "string" ||
                !/^[A-Za-z0-9+/=]+$/.test(item.b64_json)
            )
                throw new Error("Invalid image service result");
            return { mimeType: `image/${format}`, data: item.b64_json };
        });
        const current = await codex.accountRead({ refreshToken: false });
        if (
            current.workspaceRouting?.chatgptAccountId !==
            routing.chatgptAccountId
        )
            throw new Error("ChatGPT account changed during image generation");
        return { images: output };
    }
    throw new Error("ChatGPT authentication failed");
}

/** Preserve bounded service diagnostics without forwarding credentials or raw response bodies. */
async function imageServiceError(response: Response, authToken: string): Promise<Error> {
    let detail: unknown;
    try {
        const decoder = new TextDecoder();
        let text = "";
        let bytes = 0;
        if (response.body) {
            for await (const chunk of response.body) {
                bytes += chunk.byteLength;
                if (bytes > 32 * 1024) break;
                text += decoder.decode(chunk, { stream: true });
            }
        }
        detail = JSON.parse(text + decoder.decode());
    } catch {
        // Missing or unreadable diagnostics must retain the original HTTP failure.
    }
    const record = (value: unknown): Record<string, unknown> | null =>
        value !== null && typeof value === "object" && !Array.isArray(value)
            ? value as Record<string, unknown>
            : null;
    const body = record(detail);
    const error = body?.["error"] ?? body?.["detail"] ?? detail;
    const fields = Array.isArray(error) ? error.slice(0, 5) : [error];
    const messages = fields.flatMap((field) => {
        if (typeof field === "string") return [field];
        const item = record(field);
        return [item?.["message"], item?.["msg"]].filter((value): value is string => typeof value === "string");
    });
    const code = record(error)?.["code"] ?? body?.["error_code"];
    if (typeof code === "string") messages.push(`code: ${code}`);
    const requestId = response.headers.get("x-request-id") ?? response.headers.get("openai-request-id");
    if (requestId) messages.push(`request ID: ${requestId}`);
    const message = messages.join("; ")
        .replaceAll(authToken, "[redacted]")
        .replace(/Bearer\s+[^\s",;]+/gi, "Bearer [redacted]")
        .replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, "[image data]")
        .replace(/\p{Cc}/gu, " ")
        .slice(0, 1400);
    return new Error(`Image generation failed (HTTP ${response.status})${message ? `: ${message}` : ""}`);
}

/** Bound decoded response bytes even when Content-Length is absent or incorrect. */
async function readImageResult(response: Response): Promise<unknown> {
    if (!response.body) throw new Error("Image service returned no images");
    const decoder = new TextDecoder();
    const text: string[] = [];
    let bytes = 0;
    // Throwing from the iterator cancels the response stream immediately.
    for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        if (bytes > 15 * 1024 * 1024)
            throw new Error("Image result exceeds the ACP media limit");
        text.push(decoder.decode(chunk, { stream: true }));
    }
    return JSON.parse(text.join("") + decoder.decode());
}
