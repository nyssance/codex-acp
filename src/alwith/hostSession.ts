import { RequestError } from "@agentclientprotocol/sdk/experimental/v2/unstable";
import { AgentMode } from "../AgentMode";
import type { JsonValue } from "../app-server/serde_json/JsonValue";

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

export function seedHistory(meta: unknown): JsonValue[] {
    const raw = (meta as { codex?: { seedHistory?: unknown } } | null)?.codex
        ?.seedHistory;
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw))
        throw RequestError.invalidParams(
            undefined,
            "seedHistory must be an array",
        );
    return raw.map((entry, index) => {
        const role = entry?.role,
            text = entry?.text;
        if (
            (role !== "user" && role !== "assistant") ||
            typeof text !== "string"
        ) {
            throw RequestError.invalidParams(
                { index },
                "seedHistory entries require a user/assistant role and text",
            );
        }
        return {
            type: "message",
            role,
            content: [
                { type: role === "user" ? "input_text" : "output_text", text },
            ],
        };
    });
}
