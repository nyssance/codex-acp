import type {CodexErrorInfo} from "./app-server/v2";
import {isWorkspaceRoutingUnavailableMessage} from "./CodexThreadErrors";

/** What kind of thing failed, as the AIR session failure contract names it. */
export type SessionFailureCategory =
    | "connection" | "access" | "limit" | "request" | "service" | "unknown";

/** What the user can do about a failure. */
export type SessionFailureAction = "retry" | "login" | "new_session";

/** The adapter's classification of a failed turn, shared by AIR session failures and ACP v2 turn errors. */
export type CodexFailureKind =
    | "transport_lost" | "auth_required" | "rate_limited" | "quota_exhausted" | "overloaded"
    | "context_exhausted" | "budget_exhausted" | "policy_denied" | "bad_request"
    | "provider_error" | "internal_error";

export type SessionFailurePolicy = {
    category: SessionFailureCategory;
    actions: SessionFailureAction[];
};

export const SESSION_FAILURE_POLICY: Record<CodexFailureKind, SessionFailurePolicy> = {
    transport_lost: {
        category: "connection",
        actions: ["retry", "new_session"],
    },
    auth_required: {
        category: "access",
        actions: ["login"],
    },
    rate_limited: {
        category: "limit",
        actions: ["retry"],
    },
    quota_exhausted: {
        category: "limit",
        actions: [],
    },
    overloaded: {
        category: "service",
        actions: ["retry"],
    },
    context_exhausted: {
        category: "limit",
        actions: ["new_session"],
    },
    budget_exhausted: {
        category: "limit",
        actions: ["new_session"],
    },
    policy_denied: {
        category: "request",
        actions: [],
    },
    bad_request: {
        category: "request", actions: [],
    },
    provider_error: {
        category: "service",
        actions: ["retry"],
    },
    internal_error: {
        category: "service",
        actions: ["retry", "new_session"],
    },
};

type StringCodexErrorInfo = Extract<CodexErrorInfo, string>;
type StructuredCodexErrorInfo = Exclude<CodexErrorInfo, string>;
type KeysOfUnion<T> = T extends unknown ? keyof T : never;
type StructuredCodexErrorKind = KeysOfUnion<StructuredCodexErrorInfo>;

/**
 * Known error codes map to ACP categories; extensible upstream codes fall back to provider_error.
 */
const STRING_CODEX_ERROR_CATEGORIES: Partial<Record<string, CodexFailureKind>> = {
    contextWindowExceeded: "context_exhausted",
    sessionBudgetExceeded: "budget_exhausted",
    usageLimitExceeded: "quota_exhausted",
    rateLimitExceeded: "rate_limited",
    flexUnavailable: "provider_error",
    serverOverloaded: "overloaded",
    cyberPolicy: "policy_denied",
    misalignmentPolicyViolation: "policy_denied",
    tooManyDenials: "provider_error",
    internalServerError: "internal_error",
    unauthorized: "auth_required",
    badRequest: "bad_request",
    threadRollbackFailed: "provider_error",
    sandboxError: "provider_error",
    other: "provider_error",
} satisfies Record<StringCodexErrorInfo, CodexFailureKind>;

const STRUCTURED_CODEX_ERROR_CATEGORIES: Partial<Record<string, CodexFailureKind>> = {
    httpConnectionFailed: "transport_lost",
    responseStreamConnectionFailed: "transport_lost",
    responseStreamDisconnected: "transport_lost",
    responseTooManyFailedAttempts: "transport_lost",
    activeTurnNotSteerable: "provider_error",
} satisfies Record<StructuredCodexErrorKind, CodexFailureKind>;

export function httpStatusCode(error: CodexErrorInfo | null): number | null {
    if (error === null || typeof error !== "object") return null;
    const details: unknown = Object.values(error)[0];
    if (details === null || typeof details !== "object" || !("httpStatusCode" in details)) return null;
    return typeof details.httpStatusCode === "number" ? details.httpStatusCode : null;
}

export function isAuthenticationRequired(error: CodexErrorInfo | null): boolean {
    return error === "unauthorized" || httpStatusCode(error) === 401;
}

export function codexFailureKind(
    {message, codexErrorInfo: error}: {message: string; codexErrorInfo: CodexErrorInfo | null},
): CodexFailureKind {
    if (isAuthenticationRequired(error)) return "auth_required";
    if (isWorkspaceRoutingUnavailableMessage(message)) return "transport_lost";
    if (httpStatusCode(error) === 429) return "rate_limited";
    if (typeof error === "string") {
        return Object.hasOwn(STRING_CODEX_ERROR_CATEGORIES, error)
            ? STRING_CODEX_ERROR_CATEGORIES[error] ?? "provider_error"
            : "provider_error";
    }
    if (error !== null) {
        for (const kind of Object.keys(STRUCTURED_CODEX_ERROR_CATEGORIES) as StructuredCodexErrorKind[]) {
            if (kind in error) {
                return STRUCTURED_CODEX_ERROR_CATEGORIES[kind] ?? "provider_error";
            }
        }
    }
    return "provider_error";
}
