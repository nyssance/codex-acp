import type * as acp from "@agentclientprotocol/sdk/unstable";
import type {DynamicToolCallOutputContentItem, ThreadItem} from "../../app-server/v2";
import {functionToolName} from "../../ToolCallName";
import type {ToolFacts} from "../ToolFacts";
import {toTerminalToolStatus, toToolStatus} from "./ToolStatus";

type DynamicToolCallItem = ThreadItem & {type: "dynamicToolCall"};

/** Reports a client-defined dynamic tool call. Its content items are the result. The success flag is the status. */
export class DynamicToolReporter {
    static started(item: DynamicToolCallItem): ToolFacts {
        return {
            toolCallId: item.id,
            report: "start",
            name: functionToolName(item.tool, item.namespace),
            kind: "execute",
            title: item.tool,
            status: toToolStatus(item.status),
            input: {arguments: item.arguments},
            ...resultFacts(item),
        };
    }

    static completed(item: DynamicToolCallItem): ToolFacts {
        return {
            toolCallId: item.id,
            report: "update",
            name: functionToolName(item.tool, item.namespace),
            status: toTerminalToolStatus(item.status),
            ...resultFacts(item),
        };
    }
}

function resultFacts(item: DynamicToolCallItem): Pick<ToolFacts, "result"> {
    if (item.contentItems === null) return {};
    return {result: item.contentItems.map(contentItem => ({type: "content", content: displayBlock(contentItem)}))};
}

/** The MIME type and base64 data of an inline image data URL, or `null` for any other URL. */
export function inlineImage(url: string): {mimeType: string; data: string} | null {
    const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/]+={0,2})$/i.exec(url);
    return match ? {mimeType: match[1]!, data: match[2]!} : null;
}

export function displayBlock(item: DynamicToolCallOutputContentItem): acp.ContentBlock {
    switch (item.type) {
        case "inputText":
            return {type: "text", text: item.text};
        case "inputImage": {
            const image = inlineImage(item.imageUrl);
            return image ? {type: "image", ...image} : {type: "resource_link", uri: item.imageUrl, name: "image"};
        }
        case "inputAudio":
            return {type: "resource_link", uri: item.audioUrl, name: "audio"};
    }
}
