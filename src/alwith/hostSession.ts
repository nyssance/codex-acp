import { RequestError } from "@agentclientprotocol/sdk/experimental/v2/unstable";
import { AgentMode } from "../AgentMode";

export function hostThreadOptions(meta: unknown, initialMode?: AgentMode) {
    const codex = (meta as { codex?: { mode?: unknown } } | null)?.codex;
    if (codex?.mode === undefined) {
        if (initialMode === undefined) return {};
        return {
            approvalPolicy: initialMode.approvalPolicy,
            approvalsReviewer: initialMode.approvalsReviewer,
            sandbox: initialMode.sandboxMode,
        };
    }
    // A custom mode belongs to the existing thread; do not replace it with a preset.
    if (codex.mode === "custom") return {};
    const mode =
        typeof codex.mode === "string" ? AgentMode.find(codex.mode) : null;
    if (!mode)
        throw RequestError.invalidParams(
            undefined,
            "Unknown Codex session mode",
        );
    return {
        approvalPolicy: mode.approvalPolicy,
        approvalsReviewer: mode.approvalsReviewer,
        sandbox: mode.sandboxMode,
    };
}

/** A native source survives history discovery and adapter restarts. */
export function hostThreadSource(meta: unknown): string | undefined {
    const source = (meta as { codex?: { threadSource?: unknown } } | null)
        ?.codex?.threadSource;
    if (source === undefined || source === null) return undefined;
    if (typeof source !== "string" || source.trim().length === 0)
        throw RequestError.invalidParams(
            undefined,
            "threadSource must be a non-empty string",
        );
    return source;
}
