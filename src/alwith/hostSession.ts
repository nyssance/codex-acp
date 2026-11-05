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
