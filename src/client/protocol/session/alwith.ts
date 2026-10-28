import type { FoldPolicy, ToolItem } from "./session";

type AlwithMeta = {
    alwith?: { runInBackground?: boolean };
    claudeCode?: { parentToolUseId?: unknown };
};

export function isAlwithBackgroundTool(tool: ToolItem): boolean {
    return (tool._meta as AlwithMeta | null)?.alwith?.runInBackground === true;
}

/** The alwith-cli dialect, shared by every app consuming that engine. */
export const alwithFoldPolicy: FoldPolicy = {
    outlivesTurn: (tool) =>
        isAlwithBackgroundTool(tool) || tool.name === "Monitor",
    parentOf: (tool) => {
        const parent = (tool._meta as AlwithMeta | null)?.claudeCode
            ?.parentToolUseId;
        return typeof parent === "string" ? parent : null;
    },
    toolContent: "append",
};
