import { displayBlock } from "../../tool-calls/reporters/DynamicToolReporter";
import path from "node:path";

import type * as acp from "@agentclientprotocol/sdk/experimental/v2/unstable";

import type { JsonValue } from "../../app-server/serde_json/JsonValue";
import type {
    CollabAgentToolCallStatus,
    CommandExecutionStatus,
    DynamicToolCallStatus,
    McpToolCallError,
    McpToolCallResult,
    McpToolCallStatus,
    PatchApplyStatus,
    ThreadItem,
} from "../../app-server/v2";
import { stripShellPrefix } from "../util/shell";
import type { CollabAgent } from "./agentDirectory";
import { changePaths, diffContent } from "./diff";
import { usesTerminal } from "./terminal";

type Item<T extends ThreadItem["type"]> = ThreadItem & { type: T };
type CodexStatus =
    | CommandExecutionStatus
    | PatchApplyStatus
    | McpToolCallStatus
    | DynamicToolCallStatus
    | CollabAgentToolCallStatus;

/** A `tool_call_update` frame; the first frame for an id carries `name`, later frames patch. */
export type ToolCallFrame = acp.ToolCallUpdate & {
    sessionUpdate: "tool_call_update";
};

/** Stable tool names, so clients can group and style Codex actions consistently. */
export const ToolName = {
    Shell: "shell",
    ReadFile: "read_file",
    ListFiles: "list_files",
    Search: "search",
    ApplyPatch: "apply_patch",
    Mcp: "mcp",
    DynamicTool: "dynamic_tool",
    WebSearch: "web_search",
    ViewImage: "view_image",
    ImageGeneration: "image_generation",
    SubAgent: "subagent",
    Collab: "collab",
    FuzzySearch: "fuzzy_file_search",
    GuardianReview: "guardian_review",
    McpStartup: "mcp_startup",
    PlanReview: "plan_review",
} as const;

export function toAcpStatus(status: CodexStatus): acp.ToolCallStatus {
    switch (status) {
        case "inProgress":
            return "in_progress";
        case "completed":
            return "completed";
        case "failed":
        case "declined":
            return "failed";
        case "interrupted":
            return "cancelled";
    }
}

function frame(fields: acp.ToolCallUpdate): ToolCallFrame {
    return { sessionUpdate: "tool_call_update", ...fields };
}

function textContent(text: string): acp.ToolCallContent {
    return { type: "content", content: { type: "text", text } };
}

// ---- file changes -----------------------------------------------------------

export function fileChangeStarted(item: Item<"fileChange">): ToolCallFrame {
    return frame({
        toolCallId: item.id,
        name: ToolName.ApplyPatch,
        title: fileChangeTitle(item),
        kind: "edit",
        status: toAcpStatus(item.status),
        content: item.changes.map(diffContent),
        locations: changePaths(item.changes).map((p) => ({ path: p })),
    });
}

function fileChangeTitle(item: Item<"fileChange">): string {
    const paths = changePaths(item.changes);
    if (paths.length === 1) return `Edit ${path.basename(paths[0]!)}`;
    return `Edit ${paths.length} files`;
}

// ---- commands ----------------------------------------------------------------

export function commandStarted(item: Item<"commandExecution">): ToolCallFrame {
    const action =
        item.source === "userShell"
            ? undefined
            : item.commandActions.length === 1
              ? item.commandActions[0]
              : undefined;
    const status = toAcpStatus(item.status);
    if (action) {
        switch (action.type) {
            case "read":
                return frame({
                    toolCallId: item.id,
                    name: ToolName.ReadFile,
                    title: `Read ${action.path}`,
                    kind: "read",
                    status,
                    locations: [{ path: action.path }],
                    rawInput: {
                        command: item.command,
                        cwd: item.cwd,
                        path: action.path,
                    },
                });
            case "search":
                return frame({
                    toolCallId: item.id,
                    name: ToolName.Search,
                    title: searchTitle(action.query, action.path),
                    kind: "search",
                    status,
                    ...(action.path
                        ? { locations: [{ path: action.path }] }
                        : {}),
                    rawInput: {
                        command: item.command,
                        cwd: item.cwd,
                        query: action.query,
                        path: action.path,
                    },
                });
            case "listFiles":
                return frame({
                    toolCallId: item.id,
                    name: ToolName.ListFiles,
                    title: action.path
                        ? `List files in ${action.path}`
                        : "List files",
                    kind: "read",
                    status,
                    ...(action.path
                        ? { locations: [{ path: action.path }] }
                        : {}),
                    rawInput: {
                        command: item.command,
                        cwd: item.cwd,
                        path: action.path,
                    },
                });
            case "unknown":
                break;
        }
    }
    return frame({
        toolCallId: item.id,
        name: ToolName.Shell,
        title: stripShellPrefix(item.command),
        kind: "execute",
        status,
        content: [{ type: "terminal", terminalId: item.id }],
        rawInput: { command: item.command, cwd: item.cwd },
        ...(item.source === "userShell"
            ? { _meta: { codex: { commandSource: "userShell" } } }
            : {}),
    });
}

export function commandCompleted(
    item: Item<"commandExecution">,
): ToolCallFrame {
    const output = item.aggregatedOutput ?? "";
    const truncated = output.length > 16_384;
    return frame({
        toolCallId: item.id,
        status: item.status === "completed" ? "completed" : "failed",
        rawOutput: {
            output: truncated
                ? output.slice(0, 16_384).replace(/[\uD800-\uDBFF]$/, "")
                : output,
            exitCode: item.exitCode,
            durationMs: item.durationMs,
        },
        ...(truncated || item.source === "userShell"
            ? {
                  _meta: {
                      codex: {
                          ...(item.source === "userShell"
                              ? { commandSource: "userShell" }
                              : {}),
                          ...(truncated
                              ? {
                                    outputTruncated: true,
                                    outputCharacters: output.length,
                                }
                              : {}),
                          ...(truncated && usesTerminal(item)
                              ? { terminalId: item.id }
                              : {}),
                      },
                  },
              }
            : {}),
        ...(usesTerminal(item) || !item.aggregatedOutput
            ? {}
            : { content: [textContent(item.aggregatedOutput)] }),
    });
}

export function searchTitle(
    query: string | null,
    searchPath: string | null,
): string {
    if (query && searchPath) return `Search for '${query}' in ${searchPath}`;
    if (query) return `Search for '${query}'`;
    if (searchPath) return `Search in ${searchPath}`;
    return "Search";
}

// ---- MCP and dynamic tools ---------------------------------------------------

export function mcpToolCallStarted(item: Item<"mcpToolCall">): ToolCallFrame {
    return frame({
        toolCallId: item.id,
        name: ToolName.Mcp,
        title: `${item.server}.${item.tool}`,
        kind: "execute",
        status: toAcpStatus(item.status),
        rawInput: mcpRawInput(item),
        ...(item.result === null && item.error === null
            ? {}
            : { rawOutput: mcpRawOutput(item) }),
        _meta: { codex: { mcp: { server: item.server, tool: item.tool } } },
    });
}

function mcpRawInput(item: Item<"mcpToolCall">): Record<string, JsonValue> {
    return { server: item.server, tool: item.tool, arguments: item.arguments };
}

function mcpRawOutput(item: Item<"mcpToolCall">): {
    result: McpToolCallResult | null;
    error: McpToolCallError | null;
} {
    return { result: item.result, error: item.error };
}

export function dynamicToolCallStarted(
    item: Item<"dynamicToolCall">,
): ToolCallFrame {
    return frame({
        toolCallId: item.id,
        name: ToolName.DynamicTool,
        title: item.namespace ? `${item.namespace}.${item.tool}` : item.tool,
        kind: "execute",
        status: toAcpStatus(item.status),
        rawInput: {
            tool: item.tool,
            namespace: item.namespace,
            arguments: item.arguments,
        },
    });
}

export function dynamicToolCallCompleted(
    item: Item<"dynamicToolCall">,
): ToolCallFrame {
    return frame({
        toolCallId: item.id,
        status: toAcpStatus(item.status),
        rawOutput: {
            success: item.success,
            durationMs: item.durationMs,
        },
        content: (item.contentItems ?? []).map((item) => ({
            type: "content",
            content: displayBlock(item),
        })),
    });
}

// ---- web search, images, compaction ------------------------------------------

export function webSearchStarted(item: Item<"webSearch">): ToolCallFrame {
    return frame({
        toolCallId: item.id,
        name: ToolName.WebSearch,
        title: webSearchTitle(item),
        kind: "fetch",
        status: "in_progress",
        rawInput: { query: item.query, action: item.action },
    });
}

export function webSearchSnapshot(item: Item<"webSearch">): ToolCallFrame {
    return {
        ...webSearchStarted(item),
        status: "completed",
        ...(item.results === null
            ? {}
            : { rawOutput: { results: item.results } }),
    };
}

export function webSearchTitle(item: Item<"webSearch">): string {
    const action = item.action;
    if (!action) return item.query ? `Web search: ${item.query}` : "Web search";
    switch (action.type) {
        case "search": {
            const queries = (action.queries ?? []).filter(
                (query) => query.length > 0,
            );
            const query =
                action.query ??
                (queries.length > 0 ? queries.join(", ") : item.query);
            return query ? `Web search: ${query}` : "Web search";
        }
        case "openPage":
            return action.url ? `Open page: ${action.url}` : "Open page";
        case "findInPage": {
            const pattern = action.pattern ? ` for '${action.pattern}'` : "";
            const url = action.url ? ` in ${action.url}` : "";
            return `Find in page${pattern}${url}`;
        }
        case "other":
            return "Web search";
    }
}

export function imageViewed(item: Item<"imageView">): ToolCallFrame {
    return frame({
        toolCallId: item.id,
        name: ToolName.ViewImage,
        title: `View image ${path.basename(item.path)}`,
        kind: "read",
        status: "completed",
        content: [
            {
                type: "content",
                content: {
                    type: "resource_link",
                    name: path.basename(item.path),
                    uri: item.path,
                },
            },
        ],
        locations: [{ path: item.path }],
        rawInput: { path: item.path },
    });
}

export function imageGenerationStarted(
    item: Item<"imageGeneration">,
): ToolCallFrame {
    return frame({
        toolCallId: item.id,
        name: ToolName.ImageGeneration,
        title: "Generate image",
        kind: "other",
        status: "in_progress",
        rawInput: { id: item.id },
    });
}

export function imageGenerationCompleted(
    item: Item<"imageGeneration">,
): ToolCallFrame {
    return frame({
        toolCallId: item.id,
        status:
            item.status === "failed" || item.failure !== null
                ? "failed"
                : "completed",
        content: imageGenerationContent(item),
        rawOutput: {
            status: item.status,
            revisedPrompt: item.revisedPrompt,
            savedPath: item.savedPath ?? null,
            failure: item.failure,
            ...("fileId" in item ? { fileId: item.fileId } : {}),
        },
    });
}

export function imageGenerationSnapshot(
    item: Item<"imageGeneration">,
): ToolCallFrame {
    return {
        ...imageGenerationStarted(item),
        ...imageGenerationCompleted(item),
    };
}

function imageGenerationContent(
    item: Item<"imageGeneration">,
): acp.ToolCallContent[] {
    const content: acp.ToolCallContent[] = [];
    if (item.revisedPrompt?.trim())
        content.push(textContent(`Revised prompt: ${item.revisedPrompt}`));
    if ("result" in item && item.result.trim().length > 0) {
        content.push({
            type: "content",
            content: {
                type: "image",
                data: item.result,
                mimeType: "image/png",
                ...(item.savedPath?.trim() ? { uri: item.savedPath } : {}),
            },
        });
    }
    if ("fileId" in item) {
        if (item.savedPath?.trim())
            content.push({
                type: "content",
                content: {
                    type: "resource_link",
                    name: item.savedPath,
                    uri: item.savedPath,
                },
            });
        else
            content.push(
                textContent(`Generated image attachment: ${item.fileId}`),
            );
    }
    if (item.failure)
        content.push(
            textContent(
                `Image generation failed: ${JSON.stringify(item.failure)}`,
            ),
        );
    return content;
}

/**
 * Context compaction is its own ACP v2 update (`compaction_update`, SDK 1.4), not a
 * tool call: Codex's contextCompaction item id is the compactionId. Codex reports no
 * summary text on the item, so no `compaction_summary_chunk` is emitted.
 */
export function compactionUpdate(
    compactionId: string,
    status: "in_progress" | "completed",
): acp.SessionUpdate {
    return { sessionUpdate: "compaction_update", compactionId, status };
}

// ---- sub-agents ----------------------------------------------------------------

export function subAgentActivity(
    item: Item<"subAgentActivity">,
    status: acp.ToolCallStatus,
    create: boolean,
): ToolCallFrame {
    const name = item.agentPath.split("/").findLast(Boolean) ?? "subagent";
    const titles = {
        started: `Start subagent ${name}`,
        interacted: `Interact with subagent ${name}`,
        interrupted: `Interrupt subagent ${name}`,
        completed: `Complete subagent ${name}`,
    } as const;
    return frame({
        toolCallId: item.id,
        ...(create
            ? {
                  name: ToolName.SubAgent,
                  title: titles[item.kind],
                  kind: "other",
              }
            : {}),
        status,
        rawInput: {
            model: item.model,
            reasoningEffort: item.reasoningEffort,
            agentThreadId: item.agentThreadId,
            agentPath: item.agentPath,
            activity: item.kind,
        },
        _meta: {
            codex: {
                subagent: {
                    model: item.model,
                    reasoningEffort: item.reasoningEffort,
                    threadId: item.agentThreadId,
                    path: item.agentPath,
                    activity: item.kind,
                },
            },
        },
    });
}

export function collabToolCall(
    item: Item<"collabAgentToolCall">,
    create: boolean,
    agents: CollabAgent[],
): ToolCallFrame {
    return frame({
        toolCallId: item.id,
        ...(create
            ? { name: ToolName.Collab, title: item.tool, kind: "other" }
            : {}),
        status: toAcpStatus(item.status),
        rawInput: {
            prompt: item.prompt,
            senderThreadId: item.senderThreadId,
            receiverThreadIds: item.receiverThreadIds,
            agentsStates: item.agentsStates,
            model: item.model,
            reasoningEffort: item.reasoningEffort,
        },
        _meta: {
            codex: {
                collaboration: {
                    tool: item.tool,
                    senderThreadId: item.senderThreadId,
                    receiverThreadIds: item.receiverThreadIds,
                    agents,
                },
            },
        },
    });
}

// ---- fuzzy file search ---------------------------------------------------------

export function fuzzySearchToolCallId(searchSessionId: string): string {
    return `fuzzy-file-search:${searchSessionId}`;
}

// ---- guardian review -----------------------------------------------------------

export function guardianReviewToolCallId(reviewId: string): string {
    return `guardian-review:${reviewId}`;
}

// ---- MCP startup ------------------------------------------------------------------
