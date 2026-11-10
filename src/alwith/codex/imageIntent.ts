import {RequestError} from "@agentclientprotocol/sdk/unstable";

import type {AdditionalContextEntry} from "../../app-server/v2";
import {isRecord} from "../../permissions/json";

export type InputMode = "chat" | "image";

/** Hosts restore this preference before creating, resuming or forking a session. */
export function inputModeOf(meta: unknown): InputMode | undefined {
    const alwith = isRecord(meta) && isRecord(meta["alwith"]) ? meta["alwith"] : undefined;
    const mode = alwith?.["inputMode"];
    if (mode === undefined) return undefined;
    if (mode !== "chat" && mode !== "image") throw RequestError.invalidParams(undefined, "_meta.alwith.inputMode must be chat or image");
    return mode;
}

/** Input-mode context is separate from the user's text and is replaced for each request. */
export function imageIntentContext(meta: unknown): Record<string, AdditionalContextEntry> | undefined {
    const alwith = isRecord(meta) && isRecord(meta["alwith"]) ? meta["alwith"] : undefined;
    const intent = alwith?.["imageIntent"];
    if (intent === undefined) return undefined;
    if (intent !== null && intent !== "generate" && intent !== "edit")
        throw RequestError.invalidParams(undefined, "_meta.alwith.imageIntent must be generate, edit, or null");
    const instructions = alwith?.["imageInstructions"];
    if (instructions !== undefined && typeof instructions !== "string")
        throw RequestError.invalidParams(undefined, "_meta.alwith.imageInstructions must be a string");
    const value =
        intent === null
            ? "The current message uses ordinary chat input. For image generation or editing, use the native image generation tool, never the application generate_image tool. Do not apply application image-model settings or earlier application image-workflow instructions. Image generation is not implied by the input mode; follow the user's request."
            : [
                  intent === "edit"
                      ? "The current message requests an image edit. Use the application generate_image tool and the supplied source and reference attachments. Follow the specific editing instructions in the user message."
                      : "The user selected image input for the current message. Treat descriptions as requests to generate or edit images using the application generate_image tool. Use attached images as references when relevant. Answer questions about previous results normally; do not generate another image unless requested.",
                  "Use only the application's selected image model for this image conversation. Do not substitute a native image generation tool.",
                  instructions,
              ]
                  .filter(Boolean)
                  .join("\n\n");
    return {"alwith.imageIntent": {kind: "application", value}};
}
