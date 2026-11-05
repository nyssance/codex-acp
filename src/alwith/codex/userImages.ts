import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as acp from "@agentclientprotocol/sdk/experimental/v2/unstable";

import type { UserInput } from "../../app-server/v2";
import { attachmentFileUri } from "../../DesktopAttachmentHistory";

const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

/**
 * Replaces the links `session/load` replays for a message's native `localImage` inputs with the
 * image data. Only those inputs authorize a local read; other links in the message stay links.
 */
export async function hydrateLocalImages(
    updates: readonly acp.SessionUpdate[],
    inputs: readonly UserInput[],
    signal: AbortSignal,
): Promise<acp.SessionUpdate[]> {
    const paths = new Map<string, string>();
    for (const input of inputs) {
        if (input.type !== "localImage") continue;
        const uri = attachmentFileUri(input.path);
        if (uri !== null) paths.set(uri, input.path);
    }
    const result: acp.SessionUpdate[] = [];
    for (const update of updates) {
        signal.throwIfAborted();
        if (
            acp.SessionUpdate.isUserMessageChunk(update) &&
            acp.ContentBlock.isResourceLink(update.content)
        ) {
            const path = paths.get(update.content.uri);
            if (path !== undefined) {
                result.push({ ...update, content: await readImage(path) });
                continue;
            }
        }
        result.push(update);
    }
    return result;
}

async function readImage(path: string): Promise<acp.ContentBlock> {
    try {
        // Nonblocking open avoids hanging replay on a stale path replaced by a FIFO.
        const file = await open(
            path.startsWith("file:") ? fileURLToPath(path) : path,
            constants.O_RDONLY | constants.O_NONBLOCK,
        );
        try {
            const stat = await file.stat();
            if (!stat.isFile()) return unavailable("not a regular file");
            if (stat.size === 0) return unavailable("empty file");
            if (stat.size > MAX_IMAGE_BYTES)
                return unavailable(`larger than ${MAX_IMAGE_BYTES} bytes`);
            const data = Buffer.alloc(stat.size);
            let offset = 0;
            while (offset < data.length) {
                const { bytesRead } = await file.read(
                    data,
                    offset,
                    data.length - offset,
                    offset,
                );
                if (bytesRead === 0)
                    return unavailable("file shrank while it was read");
                offset += bytesRead;
            }
            const mimeType = imageMimeType(data);
            return mimeType
                ? { type: "image", mimeType, data: data.toString("base64") }
                : unavailable("not a PNG, JPEG, GIF, WebP or BMP image");
        } finally {
            await file.close();
        }
    } catch (error) {
        // Clipboard files can expire. An unreadable attachment must not hide the turn, so
        // it is replayed as an unavailable image that names the cause.
        return unavailable(error instanceof Error ? error.message : String(error));
    }
}

function unavailable(reason: string): acp.ContentBlock {
    return {
        type: "resource_link",
        name: "Image unavailable",
        uri: "codex-image:unavailable",
        _meta: { codex: { imageUnavailable: true, reason } },
    };
}

function imageMimeType(data: Buffer): string | null {
    if (
        data
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
        return "image/png";
    if (data[0] === 255 && data[1] === 216 && data[2] === 255)
        return "image/jpeg";
    if (/^GIF8[79]a$/.test(data.toString("ascii", 0, 6))) return "image/gif";
    if (
        data.toString("ascii", 0, 4) === "RIFF" &&
        data.toString("ascii", 8, 12) === "WEBP"
    )
        return "image/webp";
    if (data.toString("ascii", 0, 2) === "BM") return "image/bmp";
    return null;
}
