// Codex skills, plugin marketplace, account and file search shapes, as exposed by
// codex-acp-v2's `_codex/*` extension methods, are the generated Codex app-server types.

import type * as acp from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {
    DISCONNECTED,
    type MessageItem,
    textOf,
    type TurnError,
} from "./protocol";

export type {
    SkillMetadata,
    SkillErrorInfo,
    SkillsListParams,
    SkillsListResponse,
    SkillsConfigWriteParams,
    SkillsConfigWriteResponse,
    PluginSummary,
    PluginMarketplaceEntry,
    MarketplaceLoadErrorInfo,
    PluginListParams,
    PluginListResponse,
    PluginInstalledParams,
    PluginInstalledResponse,
    PluginInstallParams,
    PluginInstallResponse,
    PluginUninstallParams,
    PluginReadParams,
    PluginDetail,
    PluginReadResponse,
    MarketplaceAddParams,
    MarketplaceAddResponse,
    MarketplaceRemoveParams,
    MarketplaceUpgradeParams,
    MarketplaceUpgradeResponse,
    RateLimitWindow,
    RateLimitSnapshot,
    GetAccountResponse as AccountReadResponse,
    GetAccountRateLimitsResponse as RateLimitsResponse,
} from "../app-server/v2";
export type {
    FuzzyFileSearchParams,
    FuzzyFileSearchResponse,
    FuzzyFileSearchResult,
    FuzzyFileSearchSessionUpdatedNotification as FuzzyFileSearchSessionUpdated,
} from "../app-server";

/** What the adapter advertised under `capabilities._meta.codex`. */
export type CodexExtensionCapabilities = {
    sessionRetry: boolean;
    composerPredictions: boolean;
    forkAtTurn: boolean;
    sessionLineage: boolean;
    skills: boolean;
    plugins: boolean;
    rename: boolean;
    account: boolean;
    fuzzyFileSearch: boolean;
    providerCatalog: boolean;
    realtime: boolean;
    /** `sessionHistory` version 2 with item pages, by mode. */
    sessionHistory: { browse: boolean; export: boolean };
};

export function codexExtensionCapabilities(
    agent: acp.InitializeResponse | null,
): CodexExtensionCapabilities {
    const codex = agent?.capabilities?._meta?.codex;
    const flags =
        typeof codex === "object" && codex !== null
            ? (codex as Record<string, unknown>)
            : {};
    return {
        sessionRetry:
            typeof flags.sessionRetry === "object" &&
            flags.sessionRetry !== null &&
            (flags.sessionRetry as { version?: unknown }).version === 1,
        composerPredictions: flags.composerPredictions === true,
        forkAtTurn: flags.forkAtTurn === true,
        sessionLineage: flags.sessionLineage === true,
        skills: flags.skills === true,
        plugins: flags.plugins === true,
        rename: flags.rename === true,
        account: flags.account === true,
        fuzzyFileSearch: flags.fuzzyFileSearch === true,
        providerCatalog: flags.providerCatalog === true,
        realtime: versionOf(flags.realtime) === 1,
        sessionHistory: {
            browse: historyMode(flags.sessionHistory, "browse"),
            export: historyMode(flags.sessionHistory, "export"),
        },
    };
}

function versionOf(capability: unknown): unknown {
    return typeof capability === "object" && capability !== null
        ? (capability as { version?: unknown }).version
        : undefined;
}

function historyMode(capability: unknown, mode: "browse" | "export"): boolean {
    if (versionOf(capability) !== 2) return false;
    const { items, modes } = capability as { items?: unknown; modes?: unknown };
    return items === true && Array.isArray(modes) && modes.includes(mode);
}

export function codexTurnId(
    meta: Record<string, unknown> | null | undefined,
): string | null {
    const codex = meta?.codex;
    if (typeof codex !== "object" || codex === null) return null;
    const id = (codex as { turnId?: unknown }).turnId;
    return typeof id === "string" && id.length > 0 ? id : null;
}

/** Original native turn start, in Unix milliseconds; never a replay arrival time. */
export function codexTurnStartedAt(
    meta: Record<string, unknown> | null | undefined,
): number | null {
    const codex = meta?.codex;
    if (typeof codex !== "object" || codex === null) return null;
    const value = (codex as { turnStartedAt?: unknown }).turnStartedAt;
    return typeof value === "number" &&
        Number.isFinite(value) &&
        Math.abs(value) <= 8.64e15
        ? value
        : null;
}

/** Single-boolean store selectors (a fresh object per call would re-render forever). */
export function hasRename(agent: acp.InitializeResponse | null): boolean {
    return codexExtensionCapabilities(agent).rename;
}
export function hasAccount(agent: acp.InitializeResponse | null): boolean {
    return codexExtensionCapabilities(agent).account;
}
export function hasFuzzyFileSearch(
    agent: acp.InitializeResponse | null,
): boolean {
    return codexExtensionCapabilities(agent).fuzzyFileSearch;
}

/**
 * Store selector: a single boolean, so `useStore` sees a stable value. Selecting the
 * capabilities object itself re-renders forever (a new object every call).
 */
export function hasPluginStore(agent: acp.InitializeResponse | null): boolean {
    const capabilities = codexExtensionCapabilities(agent);
    return capabilities.skills || capabilities.plugins;
}

/** Standard ACP errors carry the message; Codex data supplies retry classification. */
export type CodexTurnError = {
    message: string;
    category: string | null;
    retryable: boolean;
};

export function codexTurnError(error: TurnError): CodexTurnError {
    const data = error.error?.data;
    const codexData =
        typeof data === "object" && data !== null
            ? (data as { codex?: unknown }).codex
            : undefined;
    const codex = error.meta?.codex;
    const detail =
        codexData ??
        (typeof codex === "object" && codex !== null
            ? (codex as { error?: unknown }).error
            : undefined);
    const fields =
        typeof detail === "object" && detail !== null
            ? (detail as Record<string, unknown>)
            : undefined;
    return {
        message:
            error.error != null
                ? error.error.message
                : typeof fields?.message === "string"
                  ? fields.message
                  : error.stopReason === DISCONNECTED
                    ? "Codex disconnected while this turn was running"
                    : `Turn ended: ${error.stopReason}`,
        category: typeof fields?.category === "string" ? fields.category : null,
        retryable: fields?.retryable === true,
    };
}

/** Error diagnostics are transcript items; the session error is only the current run's state. */
export function codexMessageError(
    item: Pick<MessageItem, "content" | "_meta">,
): TurnError | null {
    const codex = item._meta?.codex;
    if (typeof codex !== "object" || codex === null) return null;
    const error = (codex as { error?: unknown }).error;
    if (typeof error !== "object" || error === null) return null;
    const detail = error as Record<string, unknown>;
    if (typeof detail.message !== "string") return null;
    return {
        stopReason:
            typeof detail.stopReason === "string" ? detail.stopReason : "error",
        error: {
            code: -32603,
            message: textOf(item.content),
            data: { codex: detail },
        },
        meta: item._meta,
    };
}

export function codexRetryNotice(
    meta: SessionMeta,
): { message: string; capacity: boolean } | null {
    const codex = meta?.codex;
    if (typeof codex !== "object" || codex === null) return null;
    const retry = (codex as { retry?: unknown }).retry;
    if (typeof retry !== "object" || retry === null) return null;
    const value = retry as Record<string, unknown>;
    return typeof value.message === "string"
        ? {
              message: value.message,
              capacity: value.codexErrorInfo === "serverOverloaded",
          }
        : null;
}

type SessionMeta = Record<string, unknown> | null;

export type ComposerPrediction = {
    sourceTurnId: string;
    result:
        | { type: "completed"; text: string | null }
        | { type: "failed"; message: string };
};

export function composerPrediction(
    meta: Record<string, unknown> | null,
): ComposerPrediction | null {
    const codex = meta?.codex;
    if (typeof codex !== "object" || codex === null) return null;
    const prediction = (codex as Record<string, unknown>).prediction;
    if (prediction === undefined || prediction === null) return null;
    if (typeof prediction !== "object")
        throw new Error("Invalid composer prediction");
    const { sourceTurnId, result } = prediction as Record<string, unknown>;
    if (
        typeof sourceTurnId !== "string" ||
        !sourceTurnId ||
        typeof result !== "object" ||
        result === null
    )
        throw new Error("Invalid composer prediction");
    const value = result as Record<string, unknown>;
    if (value.type === "failed" && typeof value.message === "string")
        return {
            sourceTurnId,
            result: { type: "failed", message: value.message },
        };
    if (
        value.type === "completed" &&
        (value.text === null || typeof value.text === "string")
    )
        return {
            sourceTurnId,
            result: { type: "completed", text: value.text },
        };
    throw new Error("Invalid composer prediction result");
}

/** Effective application availability from Codex, without credentials. */
export type InstalledApp = { id: string; runtimeName: string | null; enabled: boolean; callable: boolean };
export type AppsInstalledParams = { threadId?: string | null; forceRefresh?: boolean };
export type AppsInstalledResponse = { apps: InstalledApp[] };

export type McpToolCallParams = { threadId: string; server: string; tool: string; arguments?: Record<string, unknown> };
export type McpToolCallResult = { content: unknown[]; structuredContent?: unknown; isError?: boolean };
