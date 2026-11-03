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
        if (!response.ok) {
            await response.body?.cancel();
            throw new Error(
                `Image generation failed (HTTP ${response.status})`,
            );
        }
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
