// The Codex client: `@alwith/api/client`'s SessionClient plus everything codex-acp-v2 adds on top
// of ACP (`_codex/*`): the full session list and archive, history browsing and export, skills and
// plugin marketplaces, rate limits, file search, retries, predictions, fork lineage and realtime.
// Moved out of ALwith U's `agent/client.ts` (2026-10-27 chat-layer extraction): the adapter owns
// its extension protocol, so it ships the client that speaks it.
import type * as acp from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {
    type Agent,
    isBooleanOption,
    isSelectOption,
    type Session,
} from "@alwith/api";
import {
    type ClientOptions,
    type ClientState,
    mergeMeta,
    type PromptOptions,
    type ReplayPlan,
    type ReplayScope,
    SessionClient,
    type SessionOperation,
    type SessionRequestOptions,
    type SessionSummary,
    type StateSetter,
} from "@alwith/api/client";

import { readActivityReply } from "./activity-preview";
import {
    CodexCapabilitiesClient,
    type RealtimeEvent,
    type RealtimeStart,
} from "./CodexCapabilitiesClient";
import type {
    AccountReadResponse,
    FuzzyFileSearchParams,
    FuzzyFileSearchResponse,
    FuzzyFileSearchSessionUpdated,
    MarketplaceAddParams,
    MarketplaceAddResponse,
    MarketplaceRemoveParams,
    MarketplaceUpgradeParams,
    MarketplaceUpgradeResponse,
    PluginInstalledParams,
    PluginInstalledResponse,
    PluginInstallParams,
    PluginInstallResponse,
    PluginListParams,
    PluginListResponse,
    PluginReadParams,
    PluginReadResponse,
    PluginUninstallParams,
    RateLimitSnapshot,
    RateLimitsResponse,
    SkillsConfigWriteParams,
    SkillsConfigWriteResponse,
    SkillsListParams,
    SkillsListResponse,
} from "./codex-extensions";
import {
    codexExtensionCapabilities,
    codexTurnStartedAt,
} from "./codex-extensions";
import { exportConversation } from "./history";
import {
    type HistoryNavigationState,
    historyTurnPreview,
    mergeNavigationHistory,
    nativeTurnId,
    readHistoryIndex,
    readHistoryTurn,
} from "./history-navigation";
import {
    type HistoryPageState,
    prependHistory,
    readHistoryPage,
} from "./history-page";

export type ForkOrigin = { sourceId: string; boundaryTurnId: string | null };

export type ForkOptions = SessionRequestOptions & {
    /** Fork after this native turn (requires the `forkAtTurn` capability); the whole record otherwise. */
    lastTurnId?: string;
};

export type CodexClientState = ClientState & {
    archivedSessions: SessionSummary[];
    archivedCursor: string | null;
    archivedLoaded: boolean;
    /** In-memory projection of native fork/resume metadata; never a second persisted history. */
    forkOrigins: Record<string, ForkOrigin>;
    historyPages: Record<string, HistoryPageState>;
    historyNavigation: Record<string, HistoryNavigationState>;
};

/** `session/resume` answered from the read path because another Codex client holds the writer. */
function isReadOnlyResume(response: acp.ResumeSessionResponse): boolean {
    const codex = (
        response._meta as { codex?: { readOnly?: unknown } } | undefined
    )?.codex;
    return codex?.readOnly === true;
}

function isActiveWriterError(error: unknown): boolean {
    const data =
        error && typeof error === "object" && "data" in error
            ? error.data
            : null;
    return (
        !!data &&
        typeof data === "object" &&
        "reason" in data &&
        data.reason === "thread_active_writer"
    );
}

function sessionLineage(
    meta: Record<string, unknown> | null | undefined,
): Pick<SessionSummary, "nativeSessionId" | "forkedFromId"> {
    const codex = meta?.codex;
    if (typeof codex !== "object" || codex === null) return {};
    const { nativeSessionId, forkedFromId } = codex as Record<string, unknown>;
    if (nativeSessionId === undefined && forkedFromId === undefined) return {};
    if (
        typeof nativeSessionId !== "string" ||
        !nativeSessionId ||
        (forkedFromId !== null && typeof forkedFromId !== "string")
    )
        throw new Error("Invalid session lineage from the agent");
    return { nativeSessionId, forkedFromId };
}

function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

export class CodexClient<
    State extends CodexClientState = CodexClientState,
> extends SessionClient<State> {
    private nativeClient: CodexCapabilitiesClient | null = null;
    private readonly skillsListeners = new Set<() => void>();
    private readonly rateLimitListeners = new Set<
        (limits: RateLimitSnapshot) => void
    >();
    private readonly fileSearchListeners = new Set<
        (update: FuzzyFileSearchSessionUpdated) => void
    >();
    /** Forks allocate titles and lineage one at a time. */
    private forkQueue: Promise<unknown> = Promise.resolve();
    private archivedGeneration = 0;
    private readonly historyRequests = new Map<string, Promise<void>>();
    private readonly retryRequests = new Map<string, Promise<void>>();
    private readonly navigationRequests = new Map<string, Promise<void>>();
    private readonly navigationEpochs = new Map<string, object>();
    private readonly turnHistoryRequests = new Map<
        string,
        Map<string, Promise<void>>
    >();
    private readonly previewHistoryRequests = new Map<
        string,
        Map<string, Promise<void>>
    >();
    private readonly activityReplyRequests = new Map<
        string,
        Promise<string | null>
    >();
    private readonly loadedHistoryTurns = new Map<string, Set<string>>();

    constructor(
        openPort: ConstructorParameters<typeof SessionClient>[0],
        options: ClientOptions,
        extraState: Omit<State, keyof CodexClientState> = {} as Omit<
            State,
            keyof CodexClientState
        >,
    ) {
        const codex: Omit<CodexClientState, keyof ClientState> = {
            archivedSessions: [],
            archivedCursor: null,
            archivedLoaded: false,
            forkOrigins: {},
            historyPages: {},
            historyNavigation: {},
        };
        super(
            openPort,
            // Codex's dialect for the fold: `tool_call_update.content` carries the whole output every time
            // (alwith-cli sends deltas), and nothing outlives a turn or is dispatched by another tool.
            { fold: { toolContent: "replace" }, ...options },
            { ...codex, ...extraState } as Omit<State, keyof ClientState>,
        );
    }

    /** Shallow state update typed against the Codex state. */
    protected set(partial: StateSetter<CodexClientState>): void {
        this.store.setState(partial as StateSetter<State>);
    }

    get codexCapabilities(): CodexCapabilitiesClient {
        this.live();
        if (this.nativeClient === null)
            throw new Error("Codex is not connected");
        return this.nativeClient;
    }

    /** Whether the agent can host gateway models in the per-session model option. */
    get providerCatalog(): boolean {
        const codex = this.state.agent?.capabilities?._meta?.codex;
        return (
            typeof codex === "object" &&
            codex !== null &&
            (codex as { providerCatalog?: unknown }).providerCatalog === true
        );
    }

    // ── Connection hooks ──

    protected override live(): Agent {
        if (!this.agent || this.state.connection !== "ready")
            throw new Error("Codex is not connected");
        return this.agent;
    }

    protected override onConnected(agent: Agent): void {
        this.nativeClient = new CodexCapabilitiesClient(agent);
    }

    protected override disconnectedMessage(): string {
        return "Codex disconnected";
    }

    protected override onDisconnected(): void {
        this.nativeClient?.dispose();
        this.nativeClient = null;
        this.archivedGeneration++;
        this.historyRequests.clear();
        this.activityReplyRequests.clear();
    }

    protected override handleNotification(
        method: string,
        params: unknown,
    ): boolean {
        switch (method) {
            // Codex rescanned its skills or plugins (`skills/changed`): catalogs are stale.
            case "_codex/skills_changed":
                for (const listener of this.skillsListeners) listener();
                return true;
            // Codex's rolling rate-limit updates (`account/rateLimits/updated`), payload verbatim.
            case "_codex/rate_limits_updated":
                for (const listener of this.rateLimitListeners)
                    listener((params as RateLimitsResponse).rateLimits);
                return true;
            // Incremental results of a `fuzzyFileSearch` session; the final page arrives here too.
            case "_codex/fuzzy_file_search_updated":
                for (const listener of this.fileSearchListeners)
                    listener(params as FuzzyFileSearchSessionUpdated);
                return true;
            default:
                return false;
        }
    }

    // ── List dialect ──

    /** codex-acp-v2's full list in one answer; `session/list` is paged and filtered. */
    protected override async fetchSessionList(): Promise<acp.SessionInfo[]> {
        const response = await this.live().request<acp.ListSessionsResponse>(
            "_codex/session_list",
            {},
        );
        if (response.nextCursor != null)
            throw new Error("Full session list returned a cursor");
        return response.sessions;
    }

    protected override summaryOf(info: acp.SessionInfo): SessionSummary {
        const codex = info._meta?.codex;
        const archived =
            typeof codex === "object" &&
            codex !== null &&
            (codex as { archived?: unknown }).archived === true;
        return { ...super.summaryOf(info), archived };
    }

    protected override lineageOf(
        meta: Record<string, unknown> | null | undefined,
    ): Pick<SessionSummary, "nativeSessionId" | "forkedFromId"> {
        return sessionLineage(meta);
    }

    protected override turnStartedAt(
        meta: Record<string, unknown> | null | undefined,
    ): number | null {
        return codexTurnStartedAt(meta);
    }

    /** Archived sessions, one page per call; `reset` starts over. */
    async listArchived(options: { reset?: boolean } = {}): Promise<void> {
        const state = this.state;
        const cursor = options.reset ? null : state.archivedCursor;
        if (!options.reset && state.archivedLoaded && cursor === null) return;
        const generation = ++this.archivedGeneration;
        const before = new Map(
            [...state.sessionList, ...state.archivedSessions].map(
                (item) => [item.sessionId, item] as const,
            ),
        );
        const response = await this.live().request("session/list", {
            ...(cursor ? { cursor } : {}),
            _meta: { codex: { archived: true } },
        });
        if (generation !== this.archivedGeneration) return;
        const page = response.sessions
            .map((info) => this.summaryOf(info))
            .filter(
                (item) => item.archived && !this.state.drafts[item.sessionId],
            );
        const nextCursor = response.nextCursor ?? null;
        this.set((current) => {
            const after = new Map(
                [...current.sessionList, ...current.archivedSessions].map(
                    (item) => [item.sessionId, item] as const,
                ),
            );
            const changed = new Set(
                [...before.keys(), ...after.keys()].filter(
                    (id) => before.get(id) !== after.get(id),
                ),
            );
            const fresh = page.filter((item) => !changed.has(item.sessionId));
            const previous = options.reset
                ? current.archivedSessions.filter((item) =>
                      changed.has(item.sessionId),
                  )
                : current.archivedSessions;
            const merged = [
                ...new Map(
                    [...previous, ...fresh].map((item) => [
                        item.sessionId,
                        item,
                    ]),
                ).values(),
            ];
            return {
                archivedSessions: merged,
                archivedCursor: nextCursor,
                archivedLoaded: true,
            };
        });
    }

    /**
     * Every session the agent knows under `cwd` (every alias of it), or everywhere, across pages;
     * attached forks the agent has not indexed yet are included. Never attaches or selects anything.
     */
    async indexSessions(
        cwd?: string,
        archived = false,
    ): Promise<SessionSummary[]> {
        const agent = this.live();
        const sessions = new Map<string, SessionSummary>();
        const project = cwd === undefined ? undefined : this.projectPath(cwd);
        // Codex filters historical cwd strings literally; query each system alias with its own cursor.
        for (const queryCwd of cwd === undefined
            ? [undefined]
            : this.projectPaths(cwd)) {
            const cursors = new Set<string>();
            let cursor: string | undefined;
            do {
                const response = await agent.request("session/list", {
                    ...(queryCwd === undefined ? {} : { cwd: queryCwd }),
                    ...(archived
                        ? { _meta: { codex: { archived: true } } }
                        : {}),
                    ...(cursor === undefined ? {} : { cursor }),
                });
                for (const info of response.sessions) {
                    const item = this.summaryOf(info);
                    if (this.state.drafts[item.sessionId]) continue;
                    if (
                        (project === undefined || item.cwd === project) &&
                        item.archived === archived
                    )
                        sessions.set(item.sessionId, item);
                }
                cursor = response.nextCursor ?? undefined;
                if (cursor !== undefined) {
                    if (cursors.has(cursor))
                        throw new Error(
                            "Session list returned a repeated cursor",
                        );
                    cursors.add(cursor);
                }
            } while (cursor !== undefined);
        }
        if (!archived) {
            // Codex can read a just-forked thread before it includes it in thread/list.
            // Keep the native fork response visible while that thread is attached; this is not a persisted index.
            for (const item of this.liveForks(cwd))
                if (!sessions.has(item.sessionId))
                    sessions.set(item.sessionId, item);
        }
        return [...sessions.values()];
    }

    private liveForks(cwd?: string): SessionSummary[] {
        return this.state.sessionList.filter(
            (item) =>
                !item.archived &&
                item.forkedFromId != null &&
                this.state.sessions[item.sessionId]?.attached === true &&
                (cwd === undefined || item.cwd === this.projectPath(cwd)),
        );
    }

    /** A listed or indexed session's row, without opening it. */
    async readSessionSummary(id: string): Promise<SessionSummary | null> {
        const known = [
            ...this.state.sessionList,
            ...this.state.archivedSessions,
        ].find((item) => item.sessionId === id);
        if (known) return known;
        const indexes = await Promise.all([
            this.indexSessions(),
            this.indexSessions(undefined, true),
        ]);
        return indexes.flat().find((item) => item.sessionId === id) ?? null;
    }

    // ── Session set-up dialect ──

    /** Reopening or forking keeps the source's approval destination (`_meta.codex.mode`). */
    protected override sessionMeta(
        operation: SessionOperation,
    ): Record<string, unknown> | undefined {
        const sourceId =
            operation.kind === "resume"
                ? operation.sessionId
                : operation.kind === "fork"
                  ? operation.sourceSessionId
                  : null;
        if (sourceId === null) return undefined;
        const mode = this.sessions.sessions
            .get(sourceId)
            ?.configOptions.find(
                (option) =>
                    option.category === "mode" && isSelectOption(option),
            );
        return mode && isSelectOption(mode)
            ? { codex: { mode: mode.currentValue } }
            : undefined;
    }

    protected override promptMeta(
        _id: string,
        options: PromptOptions,
    ): Record<string, unknown> | undefined {
        return mergeMeta(
            { codex: { messageSentAt: Date.now() } },
            options.meta,
        );
    }

    /** New chats use standard speed even when Codex's global default is priority. */
    protected override async afterSessionCreated(id: string): Promise<void> {
        const fast = this.session(id).configOptions.find(
            (option) => option.configId === "fast-mode",
        );
        if (!fast || !isBooleanOption(fast) || !fast.currentValue) return;
        try {
            await this.setConfig(id, fast.configId, false);
        } catch (error) {
            try {
                await this.delete(id);
            } catch (cleanupError) {
                throw new AggregateError(
                    [error, cleanupError],
                    "Failed to initialize and clean up the new session",
                    {
                        cause: cleanupError,
                    },
                );
            }
            throw error;
        }
    }

    /** Old project indexes and a retry after a successful remote delete may outlive the rollout. */
    protected override async deleteRemote(id: string): Promise<void> {
        try {
            await this.live().request("session/delete", { sessionId: id });
        } catch (error) {
            // Only Codex's explicit absence of this exact thread is idempotent success.
            if (
                !asError(error).message.endsWith(
                    `no rollout found for thread id ${id}`,
                )
            )
                throw error;
        }
    }

    // ── Replay with history ──

    private historyCapability(mode: "browse" | "export"): boolean {
        const codex = this.state.agent?.capabilities?._meta?.codex;
        const capability =
            codex && typeof codex === "object" && "sessionHistory" in codex
                ? codex.sessionHistory
                : null;
        return !!(
            capability &&
            typeof capability === "object" &&
            "version" in capability &&
            capability.version === 2 &&
            "items" in capability &&
            capability.items === true &&
            "modes" in capability &&
            Array.isArray(capability.modes) &&
            capability.modes.includes(mode)
        );
    }

    /** With history browsing the resume carries no replay; the first page is read instead. */
    protected override replayPlan(agent: Agent, session: Session): ReplayPlan {
        return this.historyCapability("browse")
            ? { from: 0 }
            : super.replayPlan(agent, session);
    }

    protected override resumeReadOnly(
        response: acp.ResumeSessionResponse,
    ): boolean {
        return isReadOnlyResume(response);
    }

    protected override beforeReplay(id: string): void {
        this.historyRequests.delete(id);
        this.navigationEpochs.set(id, {});
        this.navigationRequests.delete(id);
        this.turnHistoryRequests.delete(id);
        this.previewHistoryRequests.delete(id);
        this.loadedHistoryTurns.delete(id);
        this.set((state) => {
            const { [id]: _navigation, ...historyNavigation } =
                state.historyNavigation;
            return { historyNavigation };
        });
    }

    protected override async afterResume(
        id: string,
        cwd: string,
        scope: ReplayScope,
    ): Promise<void> {
        if (!this.historyCapability("browse")) return;
        const page = await readHistoryPage(id, cwd, null, (params) =>
            scope.agent.request("_codex/session_history", params, {
                cancellationSignal: scope.signal,
            }),
        );
        scope.signal.throwIfAborted();
        if (this.agent !== scope.agent)
            throw new Error("Codex disconnected during history load");
        this.sessions.set(
            prependHistory(this.sessions.get(id), page.session, scope.baseline),
        );
        this.noteLoadedHistory(id, page.turnIds);
        this.set((state) => ({
            historyPages: {
                ...state.historyPages,
                [id]: { cursor: page.cursor, loading: false, error: null },
            },
        }));
    }

    protected override onReplayed(
        id: string,
        response: acp.ResumeSessionResponse,
    ): void {
        this.recordForkOrigin(
            id,
            response._meta as Record<string, unknown> | null | undefined,
        );
    }

    /** Browsing is independent of acquiring the writer: a locked thread is shown read-only from its history. */
    protected override async recoverReplay(
        id: string,
        cwd: string,
        error: unknown,
        scope: ReplayScope,
    ): Promise<boolean> {
        if (!isActiveWriterError(error) || !this.historyCapability("browse"))
            return false;
        let historyError: string | null = null;
        try {
            const page = await readHistoryPage(id, cwd, null, (params) =>
                scope.agent.request("_codex/session_history", params, {
                    cancellationSignal: scope.signal,
                }),
            );
            scope.signal.throwIfAborted();
            if (!this.current(scope) || !this.holds(id)) return true;
            this.sessions.set(
                prependHistory(
                    this.sessions.get(id),
                    page.session,
                    scope.baseline,
                ),
            );
            this.noteLoadedHistory(id, page.turnIds);
            this.set((state) => ({
                historyPages: {
                    ...state.historyPages,
                    [id]: { cursor: page.cursor, loading: false, error: null },
                },
            }));
        } catch (reason) {
            scope.signal.throwIfAborted();
            if (!this.current(scope) || !this.holds(id)) return true;
            historyError = asError(reason).message;
        }
        if (historyError)
            this.set((state) => ({
                historyPages: {
                    ...state.historyPages,
                    [id]: { cursor: null, loading: false, error: historyError },
                },
            }));
        this.publishSession({
            ...this.sessions.get(id),
            cwd,
            attached: false,
            restoring: false,
            readOnly: true,
            error: null,
        });
        return true;
    }

    protected override onSessionDropped(id: string): void {
        this.historyRequests.delete(id);
        this.navigationEpochs.delete(id);
        this.navigationRequests.delete(id);
        this.turnHistoryRequests.delete(id);
        this.previewHistoryRequests.delete(id);
        this.loadedHistoryTurns.delete(id);
        this.set((state) => {
            const { [id]: _origin, ...forkOrigins } = state.forkOrigins;
            const { [id]: _history, ...historyPages } = state.historyPages;
            const { [id]: _navigation, ...historyNavigation } =
                state.historyNavigation;
            return { forkOrigins, historyPages, historyNavigation };
        });
    }

    private noteLoadedHistory(id: string, turnIds: string[]): void {
        const loaded = this.loadedHistoryTurns.get(id) ?? new Set<string>();
        for (const turnId of turnIds) loaded.add(turnId);
        this.loadedHistoryTurns.set(id, loaded);
        const navigation = this.state.historyNavigation[id];
        if (navigation)
            this.setHistoryNavigation(id, {
                ...navigation,
                loadedTurnIds: [...loaded],
            });
    }

    private setHistoryNavigation(
        id: string,
        navigation: HistoryNavigationState,
    ): void {
        this.set((state) => ({
            historyNavigation: { ...state.historyNavigation, [id]: navigation },
        }));
    }

    /** One request per session; closing or reconnecting invalidates its result. */
    loadOlderHistory(id: string): Promise<void> {
        const pending = this.historyRequests.get(id);
        if (pending) return pending;
        const page = this.state.historyPages[id];
        if (page?.cursor == null) return Promise.resolve();
        const agent = this.live();
        const session = this.sessions.get(id);
        this.set((state) => ({
            historyPages: {
                ...state.historyPages,
                [id]: { ...page, loading: true, error: null },
            },
        }));
        const current = () =>
            this.agent === agent &&
            this.holds(id) &&
            this.historyRequests.get(id) === request;
        const request = readHistoryPage(
            id,
            session.cwd,
            page.cursor,
            (params) => agent.request("_codex/session_history", params),
        )
            .then((result) => {
                if (!current()) return;
                const navigation = this.state.historyNavigation[id];
                const merged = navigation?.complete
                    ? mergeNavigationHistory(
                          this.sessions.get(id),
                          result.session,
                          navigation.turns,
                      )
                    : prependHistory(this.sessions.get(id), result.session);
                this.sessions.set(merged);
                this.noteLoadedHistory(id, result.turnIds);
                this.updates.remove(id);
                this.set((state) => ({
                    sessions: { ...state.sessions, [id]: merged },
                    historyPages: {
                        ...state.historyPages,
                        [id]: {
                            cursor: result.cursor,
                            loading: false,
                            error: null,
                        },
                    },
                }));
            })
            .catch((error: unknown) => {
                if (current())
                    this.set((state) => ({
                        historyPages: {
                            ...state.historyPages,
                            [id]: {
                                ...page,
                                loading: false,
                                error: asError(error).message,
                            },
                        },
                    }));
                throw error;
            })
            .finally(() => {
                if (this.historyRequests.get(id) === request)
                    this.historyRequests.delete(id);
            });
        this.historyRequests.set(id, request);
        return request;
    }

    /** Turn metadata has its own traversal; opening a session never waits for its full index. */
    loadHistoryNavigation(id: string): Promise<void> {
        const pending = this.navigationRequests.get(id);
        if (pending) return pending;
        if (
            this.state.historyNavigation[id]?.complete ||
            !this.state.historyPages[id]
        )
            return Promise.resolve();
        const agent = this.live();
        const epoch = this.navigationEpochs.get(id);
        const current = () =>
            this.agent === agent &&
            this.holds(id) &&
            this.navigationEpochs.get(id) === epoch;
        const check = () => {
            if (!current()) throw new Error("History navigation was cancelled");
        };
        const loaded =
            this.loadedHistoryTurns.get(id) ??
            new Set(
                this.sessions.get(id).items.flatMap((item) => {
                    const turnId = nativeTurnId(item);
                    return turnId === null ? [] : [turnId];
                }),
            );
        this.loadedHistoryTurns.set(id, loaded);
        this.setHistoryNavigation(id, {
            turns: [],
            loadedTurnIds: [...loaded],
            loading: true,
            complete: false,
            error: null,
            previews: {},
            turnErrors: {},
        });
        const request = readHistoryIndex(
            id,
            (method, params) => agent.request(method, params),
            check,
        )
            .then((turns) => {
                check();
                const navigation = this.state.historyNavigation[id];
                this.setHistoryNavigation(id, {
                    ...navigation,
                    turns,
                    loading: false,
                    complete: true,
                });
            })
            .catch((error: unknown) => {
                if (current())
                    this.setHistoryNavigation(id, {
                        ...this.state.historyNavigation[id],
                        loading: false,
                        error: asError(error).message,
                    });
                throw error;
            })
            .finally(() => {
                if (this.navigationRequests.get(id) === request)
                    this.navigationRequests.delete(id);
            });
        this.navigationRequests.set(id, request);
        return request;
    }

    /** Hover fetches one bounded preview page, leaving the session untouched. */
    previewHistoryTurn(id: string, turnId: string): Promise<void> {
        return this.hydrateHistoryTurn(id, turnId, true);
    }

    loadHistoryTurn(id: string, turnId: string): Promise<void> {
        return this.hydrateHistoryTurn(id, turnId, false);
    }

    private hydrateHistoryTurn(
        id: string,
        turnId: string,
        preview: boolean,
    ): Promise<void> {
        if (preview) {
            const hydrating = this.turnHistoryRequests.get(id)?.get(turnId);
            if (hydrating) return hydrating;
        }
        const navigation = this.state.historyNavigation[id];
        if (
            navigation?.loadedTurnIds.includes(turnId) ||
            (preview && navigation?.previews[turnId]?.state === "loaded")
        )
            return Promise.resolve();
        const turn = navigation?.turns.find((turn) => turn.turnId === turnId);
        if (!turn)
            return Promise.reject(
                new Error(`History navigation turn is missing: ${turnId}`),
            );
        const requests = preview
            ? this.previewHistoryRequests
            : this.turnHistoryRequests;
        const turns = requests.get(id) ?? new Map<string, Promise<void>>();
        requests.set(id, turns);
        const pending = turns.get(turnId);
        if (pending) return pending;
        const agent = this.live();
        const epoch = this.navigationEpochs.get(id);
        const current = () =>
            this.agent === agent &&
            this.holds(id) &&
            this.navigationEpochs.get(id) === epoch;
        const check = () => {
            if (!current()) throw new Error("History navigation was cancelled");
        };
        this.setHistoryNavigation(id, {
            ...navigation,
            previews: {
                ...navigation.previews,
                [turnId]: { state: "loading", messages: [] },
            },
            turnErrors: { ...navigation.turnErrors, [turnId]: "" },
        });
        const request = readHistoryTurn(
            id,
            this.sessions.get(id).cwd,
            turn,
            (method, params) => agent.request(method, params),
            check,
            preview,
        )
            .then((session) => {
                check();
                if (!preview) {
                    const merged = mergeNavigationHistory(
                        this.sessions.get(id),
                        session,
                        this.state.historyNavigation[id].turns,
                    );
                    this.sessions.set(merged);
                    this.updates.remove(id);
                    this.noteLoadedHistory(id, [turnId]);
                    this.publishSession(merged);
                }
                const latest = this.state.historyNavigation[id];
                // A late bounded preview cannot replace a fully hydrated turn's preview.
                if (!preview || !latest.loadedTurnIds.includes(turnId))
                    this.setHistoryNavigation(id, {
                        ...latest,
                        previews: {
                            ...latest.previews,
                            [turnId]: historyTurnPreview(session),
                        },
                    });
            })
            .catch((error: unknown) => {
                if (current()) {
                    const latest = this.state.historyNavigation[id];
                    if (preview && latest.loadedTurnIds.includes(turnId))
                        return;
                    this.setHistoryNavigation(id, {
                        ...latest,
                        previews: {
                            ...latest.previews,
                            [turnId]: { state: "unavailable", messages: [] },
                        },
                        turnErrors: preview
                            ? latest.turnErrors
                            : {
                                  ...latest.turnErrors,
                                  [turnId]: asError(error).message,
                              },
                    });
                }
                throw error;
            })
            .finally(() => {
                if (turns.get(turnId) === request) turns.delete(turnId);
            });
        turns.set(turnId, request);
        return request;
    }

    /** Read-only sidebar projection; never attaches or changes the selected chat. */
    activityReply(sessionId: string): Promise<string | null> {
        const pending = this.activityReplyRequests.get(sessionId);
        if (pending) return pending;
        const agent = this.live();
        if (!this.historyCapability("browse"))
            throw new Error("Activity preview requires history browsing");
        const request = readActivityReply(
            sessionId,
            (params) => agent.request("_codex/session_history_items", params),
            () => {
                if (this.agent !== agent || !this.state.runStates[sessionId])
                    throw new Error("Activity preview was cancelled");
            },
        ).finally(() => {
            if (this.activityReplyRequests.get(sessionId) === request)
                this.activityReplyRequests.delete(sessionId);
        });
        this.activityReplyRequests.set(sessionId, request);
        return request;
    }

    private requireHistory(): void {
        this.live();
        if (!this.historyCapability("export"))
            throw new Error(
                "Session export requires codex-acp-v2 0.7.7 or a compatible history interface",
            );
    }

    async listHistorySessions(check: () => void): Promise<SessionSummary[]> {
        check();
        this.requireHistory();
        const current = await this.indexSessions(undefined, false);
        check();
        const archived = await this.indexSessions(undefined, true);
        check();
        return [
            ...new Map(
                [...current, ...archived].map((item) => [item.sessionId, item]),
            ).values(),
        ];
    }

    async exportHistory(
        sessionId: string,
        check: () => void,
        signal?: AbortSignal,
    ): Promise<string> {
        this.requireHistory();
        return exportConversation(
            sessionId,
            (params) =>
                this.live().request("_codex/session_history_items", params, {
                    cancellationSignal: signal,
                }),
            check,
        );
    }

    // ── Fork lineage, archive, rename, retry, prediction ──

    override fork(
        id: string,
        cwd: string,
        options: ForkOptions = {},
    ): Promise<string> {
        const pending = this.forkQueue.then(() =>
            this.forkInternal(id, cwd, options),
        );
        this.forkQueue = pending.catch(() => {});
        return pending;
    }

    /** One fork at a time; an application subclass wraps this to name the fork from what it already lists. */
    protected async forkInternal(
        id: string,
        cwd: string,
        options: ForkOptions,
    ): Promise<string> {
        const { lastTurnId, ...rest } = options;
        if (
            lastTurnId !== undefined &&
            (!lastTurnId ||
                !codexExtensionCapabilities(this.state.agent).forkAtTurn)
        )
            throw new Error("The agent does not support forking at this turn");
        return super.fork(id, cwd, {
            ...rest,
            meta: mergeMeta(
                rest.meta,
                lastTurnId === undefined
                    ? undefined
                    : { codex: { lastTurnId } },
            ),
        });
    }

    protected override onForked(
        id: string,
        response: acp.ForkSessionResponse,
    ): void {
        this.recordForkOrigin(
            id,
            response._meta as Record<string, unknown> | null | undefined,
        );
    }

    private recordForkOrigin(
        id: string,
        meta: Record<string, unknown> | null | undefined,
    ): void {
        const lineage = sessionLineage(meta);
        const sourceId = lineage.forkedFromId;
        if (!sourceId) return;
        const codex = meta?.codex as Record<string, unknown>;
        const boundary = codex.forkedAtTurnId;
        if (
            boundary !== undefined &&
            boundary !== null &&
            (typeof boundary !== "string" || !boundary)
        )
            throw new Error("Invalid fork boundary from the agent");
        this.set((state) => ({
            forkOrigins: {
                ...state.forkOrigins,
                [id]: {
                    sourceId,
                    boundaryTurnId:
                        typeof boundary === "string" ? boundary : null,
                },
            },
        }));
    }

    async archive(id: string): Promise<void> {
        this.lifecycle.cancelPreparing(id);
        await this.lifecycle.operations.delete(id, async () => {
            // Host access is revoked before the lifecycle changes; a failed revocation leaves the session as it was.
            await this.options.revokeSessionAccess?.(id);
            await this.live().request("_codex/session_archive", {
                sessionId: id,
            });
            this.dropSession(id);
            this.set((state) => {
                const item = state.sessionList.find(
                    (entry) => entry.sessionId === id,
                );
                return {
                    sessionList: state.sessionList.filter(
                        (entry) => entry.sessionId !== id,
                    ),
                    archivedSessions: item
                        ? [
                              { ...item, archived: true },
                              ...state.archivedSessions.filter(
                                  (entry) => entry.sessionId !== id,
                              ),
                          ]
                        : state.archivedSessions,
                };
            });
        });
    }

    async unarchive(id: string): Promise<void> {
        await this.live().request("_codex/session_unarchive", {
            sessionId: id,
        });
        this.set((state) => {
            const item = state.archivedSessions.find(
                (entry) => entry.sessionId === id,
            );
            return {
                archivedSessions: state.archivedSessions.filter(
                    (entry) => entry.sessionId !== id,
                ),
                sessionList: item
                    ? [{ ...item, archived: false }, ...state.sessionList]
                    : state.sessionList,
            };
        });
    }

    override async delete(id: string): Promise<void> {
        await super.delete(id);
        this.set((state) => ({
            archivedSessions: state.archivedSessions.filter(
                (item) => item.sessionId !== id,
            ),
        }));
    }

    /** Codex `thread/name/set`; the list is patched at once, the `session_info_update` confirms it. */
    async renameSession(id: string, name: string): Promise<void> {
        await this.live().request("_codex/session_rename", {
            sessionId: id,
            name,
        });
        const rename = (item: SessionSummary) =>
            item.sessionId === id ? { ...item, title: name } : item;
        this.set((state) => ({
            sessionList: state.sessionList.map(rename),
            archivedSessions: state.archivedSessions.map(rename),
        }));
        const session = this.sessions.sessions.get(id);
        if (session) this.publishSession({ ...session, title: name });
    }

    retrySession(
        id: string,
        turnId: string,
        trigger: "manual" | "automatic",
    ): Promise<void> {
        const pending = this.retryRequests.get(id);
        if (pending !== undefined) return pending;
        const request = this.enqueueSession(
            id,
            async () => {
                const session = this.sessions.get(id);
                if (
                    !session.attached ||
                    session.readOnly ||
                    session.restoring ||
                    session.state !== "idle"
                )
                    throw new Error(
                        "Open the idle conversation before retrying",
                    );
                if (!codexExtensionCapabilities(this.state.agent).sessionRetry)
                    throw new Error(
                        "The Codex adapter does not support retrying turns",
                    );
                if (this.options.prepareSessionTools)
                    await this.options.prepareSessionTools(id);
                await this.live().request("_codex/session_retry", {
                    sessionId: id,
                    turnId,
                    trigger,
                });
            },
            false,
        ).finally(() => {
            if (this.retryRequests.get(id) === request)
                this.retryRequests.delete(id);
        });
        this.retryRequests.set(id, request);
        return request;
    }

    async requestPrediction(
        sessionId: string,
        sourceTurnId: string,
    ): Promise<void> {
        if (!codexExtensionCapabilities(this.state.agent).composerPredictions)
            throw new Error("The agent does not support composer predictions");
        await this.live().request("_codex/session_prediction_request", {
            sessionId,
            sourceTurnId,
        });
    }

    // ── Account, rate limits, file search ──

    readAccount(): Promise<AccountReadResponse> {
        return this.live().request<AccountReadResponse>(
            "_codex/account_read",
            {},
        );
    }

    async readRateLimits(): Promise<RateLimitSnapshot> {
        const response = await this.live().request<RateLimitsResponse>(
            "_codex/rate_limits",
            {},
        );
        return response.rateLimits;
    }

    /** Fires on every `_codex/rate_limits_updated`; returns the unsubscribe. */
    onRateLimits(listener: (limits: RateLimitSnapshot) => void): () => void {
        this.rateLimitListeners.add(listener);
        return () => this.rateLimitListeners.delete(listener);
    }

    /** Codex's own file search (`fuzzyFileSearch`), the one the official app's `@` uses. */
    fuzzyFileSearch(
        params: FuzzyFileSearchParams,
    ): Promise<FuzzyFileSearchResponse> {
        return this.live().request<FuzzyFileSearchResponse>(
            "_codex/fuzzy_file_search",
            params,
        );
    }

    onFileSearchUpdate(
        listener: (update: FuzzyFileSearchSessionUpdated) => void,
    ): () => void {
        this.fileSearchListeners.add(listener);
        return () => this.fileSearchListeners.delete(listener);
    }

    // ── Skills and plugin marketplaces ──

    /** Fires after `_codex/skills_changed`; returns the unsubscribe. */
    onSkillsChanged(listener: () => void): () => void {
        this.skillsListeners.add(listener);
        return () => this.skillsListeners.delete(listener);
    }

    listSkills(
        cwds?: string[],
        forceReload = false,
    ): Promise<SkillsListResponse> {
        return this.live().request<SkillsListResponse>("_codex/skills_list", {
            ...(cwds && cwds.length > 0 ? { cwds } : {}),
            ...(forceReload ? { forceReload } : {}),
        } satisfies SkillsListParams);
    }

    setSkillEnabled(
        params: SkillsConfigWriteParams,
    ): Promise<SkillsConfigWriteResponse> {
        return this.live().request<SkillsConfigWriteResponse>(
            "_codex/skills_config_write",
            params,
        );
    }

    listPlugins(params: PluginListParams = {}): Promise<PluginListResponse> {
        return this.live().request<PluginListResponse>(
            "_codex/plugin_list",
            params,
        );
    }

    installedPlugins(cwds?: string[]): Promise<PluginInstalledResponse> {
        return this.live().request<PluginInstalledResponse>(
            "_codex/plugin_installed",
            (cwds && cwds.length > 0
                ? { cwds }
                : {}) satisfies PluginInstalledParams,
        );
    }

    installPlugin(params: PluginInstallParams): Promise<PluginInstallResponse> {
        return this.live().request<PluginInstallResponse>(
            "_codex/plugin_install",
            params,
        );
    }

    setPluginEnabled(
        pluginId: string,
        enabled: boolean,
        remotePluginId?: string,
    ): Promise<{ enabled: boolean }> {
        return this.live().request("_codex/plugin_set_enabled", {
            pluginId,
            enabled,
            ...(remotePluginId ? { remotePluginId } : {}),
        });
    }

    async uninstallPlugin(pluginId: string): Promise<void> {
        await this.live().request("_codex/plugin_uninstall", {
            pluginId,
        } satisfies PluginUninstallParams);
    }

    readPlugin(params: PluginReadParams): Promise<PluginReadResponse> {
        return this.live().request<PluginReadResponse>(
            "_codex/plugin_read",
            params,
        );
    }

    addMarketplace(
        params: MarketplaceAddParams,
    ): Promise<MarketplaceAddResponse> {
        return this.live().request<MarketplaceAddResponse>(
            "_codex/marketplace_add",
            params,
        );
    }

    async removeMarketplace(marketplaceName: string): Promise<void> {
        await this.live().request("_codex/marketplace_remove", {
            marketplaceName,
        } satisfies MarketplaceRemoveParams);
    }

    upgradeMarketplaces(
        marketplaceName?: string,
    ): Promise<MarketplaceUpgradeResponse> {
        return this.live().request<MarketplaceUpgradeResponse>(
            "_codex/marketplace_upgrade",
            (marketplaceName
                ? { marketplaceName }
                : {}) satisfies MarketplaceUpgradeParams,
        );
    }

    // ── Realtime ──

    startRealtime(
        sessionId: string,
        params: RealtimeStart,
    ): Promise<Record<string, never>> {
        this.session(sessionId);
        return this.codexCapabilities.startRealtime(sessionId, params);
    }
    stopRealtime(sessionId: string): Promise<Record<string, never>> {
        return this.codexCapabilities.stopRealtime(sessionId);
    }
    onRealtime(
        sessionId: string,
        receive: (event: RealtimeEvent) => void,
    ): () => void {
        return this.codexCapabilities.onRealtime(sessionId, receive);
    }
}
