import type * as acp from "@agentclientprotocol/sdk/experimental/v2/unstable";

import type { ThreadItem } from "../../app-server/v2";

type CommandExecutionItem = ThreadItem & { type: "commandExecution" };

/**
 * Commands that Codex could not classify as a friendly action (read, search,
 * list files) stream through an agent-owned ACP terminal keyed by the item id.
 */
export function usesTerminal(item: CommandExecutionItem): boolean {
    if (item.source === "userShell") return true;
    const action =
        item.commandActions.length === 1 ? item.commandActions[0] : undefined;
    return action === undefined || action.type === "unknown";
}

/** Whole-terminal snapshot for history replay: command, full output, and exit status in one frame. */
export function terminalSnapshot(
    item: CommandExecutionItem,
): acp.SessionUpdate {
    return {
        sessionUpdate: "terminal_update",
        terminalId: item.id,
        command: item.command,
        cwd: item.cwd,
        output: { data: encode(item.aggregatedOutput ?? "") },
        ...(item.status === "inProgress"
            ? {}
            : { exitStatus: { exitCode: item.exitCode, signal: null } }),
    };
}

function encode(text: string): string {
    return Buffer.from(text, "utf8").toString("base64");
}
