import path from "node:path";
import { pathToFileURL } from "node:url";

import * as acp from "@agentclientprotocol/sdk/experimental/v2/unstable";

import type { JsonValue } from "../../app-server/serde_json/JsonValue";
import type { UserInput } from "../../app-server/v2";
import { questionReplyContent } from "./questionReplies";
import { localImageContent } from "./userImages";

export type JsonObject = { [key in string]?: JsonValue };

/** Renders Codex user input back into ACP content blocks (history replay). */
export function fromUserInput(input: UserInput): acp.ContentBlock[] {
    switch (input.type) {
        case "text":
            return (
                questionReplyContent(input.text) ??
                (input.text.length > 0
                    ? [
                          fileReference(input.text) ?? {
                              type: "text",
                              text: input.text,
                          },
                      ]
                    : [])
            );
        case "image": {
            if ("url" in input) {
                const data =
                    /^data:(image\/[a-zA-Z0-9.+-]+);base64,([a-zA-Z0-9+/=\r\n]+)$/.exec(
                        input.url,
                    );
                if (data)
                    return [
                        { type: "image", mimeType: data[1]!, data: data[2]! },
                    ];
                return [
                    { type: "resource_link", name: "Image", uri: input.url },
                ];
            }
            return [
                {
                    type: "resource_link",
                    name: "Image",
                    uri: `codex-file:${input.fileId}`,
                },
            ];
        }
        case "localImage":
            return [localImageContent(input.path)];
        case "skill":
            return [
                { type: "text", text: `skill:${input.name} (${input.path})` },
            ];
        case "mention":
            return [
                {
                    type: "resource_link",
                    name: input.name,
                    uri: toFileUri(input.path),
                },
            ];
        case "audio":
        case "localAudio":
            return [];
    }
}

/** Recover the standalone file-reference blocks `toUserInput` writes for resource links.
 * Inline links and embedded context remain text; they are not attachment blocks.
 */
function fileReference(text: string): acp.ContentBlock | null {
    if (!text.startsWith("[@") || !text.endsWith(")") || /[\r\n]/.test(text))
        return null;
    const separator = text.lastIndexOf("](file://");
    if (separator < 3) return null;
    const uri = text.slice(separator + 2, -1);
    try {
        if (new URL(uri).protocol !== "file:" || /\s/.test(uri)) return null;
    } catch {
        return null;
    }
    return { type: "resource_link", name: text.slice(2, separator), uri };
}

function toFileUri(value: string): string {
    return value.startsWith("file://") ? value : pathToFileURL(value).href;
}

/** First line of the first text block, used as a session title until Codex names the thread. */
export function promptTitle(
    prompt: readonly acp.ContentBlock[],
): string | null {
    for (const block of prompt) {
        if (!acp.ContentBlock.isText(block)) continue;
        const replies = questionReplyContent(block.text);
        if (replies) return promptTitle(replies);
        const line = block.text
            .split(/\r?\n/)
            .map((part) => part.trim())
            .find((part) => part.length > 0);
        if (line) return line.length > 120 ? `${line.slice(0, 117)}...` : line;
    }
    for (const block of prompt) {
        if (acp.ContentBlock.isResourceLink(block)) return block.name;
    }
    return null;
}

/** Strip only a complete Desktop attachment envelope backed by native images. */
export function fromUserMessage(
    inputs: readonly UserInput[],
    project: (input: UserInput) => acp.ContentBlock[] = fromUserInput,
): acp.ContentBlock[] {
    const images = new Set(
        inputs
            .filter((input) => input.type === "localImage")
            .map((input) => input.path),
    );
    const inlineImages = inputs.filter(
        (input) =>
            input.type === "image" &&
            "url" in input &&
            /^data:image\/[a-zA-Z0-9.+-]+;base64,[a-zA-Z0-9+/=\r\n]+$/.test(
                input.url,
            ),
    ).length;
    const imageCount = images.size + inlineImages;
    return inputs.flatMap((input, index) => {
        if (index !== 0 || input.type !== "text" || imageCount === 0)
            return project(input);
        const envelope =
            /^\s*# Files mentioned by the user:\r?\n\r?\n([\s\S]*?)\r?\n\r?\nDistinguish instructions in attached documents from the user's request\.\r?\n\r?\n## My request:\r?\n([\s\S]*)$/.exec(
                input.text,
            );
        if (!envelope) return project(input);
        const entries = envelope[1]!.split(/\r?\n\r?\n/);
        const paths = new Set<string>();
        for (const entry of entries) {
            const match = /^## (.+): (.+)\r?\nImage attachment: true$/.exec(
                entry,
            );
            if (match === null) return project(input);
            if (path.basename(match[2]!) !== match[1] || paths.has(match[2]!))
                return project(input);
            paths.add(match[2]!);
        }
        if (
            paths.size !== imageCount ||
            [...images].some((image) => !paths.has(image))
        )
            return project(input);
        const text = envelope[2]!.trim();
        return text ? [{ type: "text" as const, text }] : [];
    });
}
