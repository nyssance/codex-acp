import * as acp from "@agentclientprotocol/sdk/experimental/v2/unstable";

import type { JsonValue } from "../../app-server/serde_json/JsonValue";
import type {
    DynamicToolCallParams,
    DynamicToolCallResponse,
    DynamicToolSpec,
} from "../../app-server/v2";

export const CLIENT_TOOLS_METHOD = "_alwith/tool/call";
export type ClientTool = {
    name: string;
    description: string;
    inputSchema: JsonValue;
};
export type ClientToolSet = {
    version: 1;
    revision: string;
    definitions: ClientTool[];
};
const PREFIX = "alwith_client_";
const MAX_RESULT_BYTES = 16 * 1024 * 1024;

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function clientToolsOf(meta: unknown): ClientToolSet | undefined {
    if (
        !record(meta) ||
        !record(meta["alwith"]) ||
        meta["alwith"]["tools"] === undefined
    )
        return undefined;
    const value = meta["alwith"]["tools"];
    if (
        !record(value) ||
        value["version"] !== 1 ||
        typeof value["revision"] !== "string" ||
        !value["revision"].trim() ||
        !Array.isArray(value["definitions"]) ||
        value["definitions"].length > 128
    ) {
        throw acp.RequestError.invalidParams(
            undefined,
            "Expected a version 1 client tool set with revision and definitions",
        );
    }
    const names = new Set<string>();
    const definitions = value["definitions"].map((tool): ClientTool => {
        if (
            !record(tool) ||
            typeof tool["name"] !== "string" ||
            !/^[a-zA-Z][a-zA-Z0-9_]{0,49}$/.test(tool["name"]) ||
            names.has(tool["name"]) ||
            typeof tool["description"] !== "string" ||
            !record(tool["inputSchema"]) ||
            tool["inputSchema"]["type"] !== "object"
        ) {
            throw acp.RequestError.invalidParams(
                undefined,
                "Client tools require unique names, descriptions and object input schemas",
            );
        }
        names.add(tool["name"]);
        return {
            name: tool["name"],
            description: tool["description"],
            inputSchema: structuredClone(tool["inputSchema"]) as JsonValue,
        };
    });
    return { version: 1, revision: value["revision"], definitions };
}

export function dynamicTools(set: ClientToolSet): DynamicToolSpec[] {
    return set.definitions.map((tool) => ({
        type: "function",
        ...tool,
        name: PREFIX + tool["name"],
        deferLoading: false,
    }));
}

export function toolFailure(message: string): DynamicToolCallResponse {
    return {
        success: false,
        contentItems: [{ type: "inputText", text: message }],
    };
}

export function toolResponse(value: unknown): DynamicToolCallResponse {
    if (
        !record(value) ||
        typeof value["success"] !== "boolean" ||
        !Array.isArray(value["contentItems"]) ||
        Buffer.byteLength(JSON.stringify(value)) > MAX_RESULT_BYTES
    ) {
        throw new Error("Invalid or oversized client tool result");
    }
    const contentItems = value["contentItems"].map(
        (item): DynamicToolCallResponse["contentItems"][number] => {
            if (!record(item)) throw new Error("Invalid client tool content");
            if (item["type"] === "text" && typeof item["text"] === "string")
                return { type: "inputText", text: item["text"] };
            if (
                (item["type"] === "image" || item["type"] === "audio") &&
                typeof item["data"] === "string" &&
                typeof item["mimeType"] === "string" &&
                /^[A-Za-z0-9+/]*={0,2}$/.test(item["data"])
            ) {
                const supported =
                    item["type"] === "image"
                        ? /^image\/(png|jpeg|webp|gif)$/
                        : /^audio\/(wav|mpeg|mp3|ogg|flac|mp4)$/;
                if (!supported.test(item["mimeType"]))
                    throw new Error("Unsupported client tool media type");
                const url = `data:${item["mimeType"]};base64,${item["data"]}`;
                return item["type"] === "image"
                    ? { type: "inputImage", imageUrl: url }
                    : { type: "inputAudio", audioUrl: url };
            }
            // Resource references must be resolved by the trusted host, never by fetching an arbitrary URL here.
            throw new Error(
                "Client tool content must be text or bounded inline media",
            );
        },
    );
    return { success: value["success"], contentItems };
}
