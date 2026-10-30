// The adapter-owned ACP v2 client: holds one agent through the Runtime, routes every update by
// session id, runs the session lifecycle (new, open with replay, prompt with receipt, cancel, close,
// stop, delete, fork, list) and publishes state through a framework-agnostic store.
//
// Engines extend it: an adapter's own `_<engine>/*` methods, metadata and list dialect go into a
// subclass shipped with that adapter (`@nyssance/codex-acp-v2/client`). Product behaviour (draft
// slots per window, model memory, project grouping) stays in the application, also as a subclass.
import type * as acp from "@agentclientprotocol/sdk/experimental/v2/unstable";
import { SessionUpdate as SessionUpdateGuard } from "@agentclientprotocol/sdk/experimental/v2/unstable";

import {
    type Agent,
    AgentGoneError,
    type AgentRequest,
    AgentRequests,
    Agents,
    assertPromptSupported,
    configOptionRequest,
    type PendingRequest,
} from "../agent";
import { type SessionGeneration, SessionLifecycle } from "../lifecycle";
import type { RuntimeClient, SessionRunState } from "@alwith/api";
import {
    configRevisionOf,
    ConfigStaleError,
    configStaleOf,
    createSession,
    type FoldPolicy,
    markDisconnected,
    promptConfigMeta,
    type ReplayCursor,
    replayCursorFor,
    replayReceiptOf,
    type Session,
    SessionStore,
} from "../session";
import { createStore, type StateSetter, type Store } from "@alwith/api/client";
import { UpdateScheduler } from "@alwith/api/client";

export type ConnectionState =
    "disconnected" | "connecting" | "ready" | "failed";

/** What the Runtime starts the agent with: the engine, plus whatever the engine table takes (env, args…). */
export type Launch = { engine: string; [key: string]: unknown };

/** One row of the session list: what `session/list` says about a session, before it is opened. */
export type SessionSummary = {
    projectId?: string | null;
    sessionId: string;
    cwd: string;
    title: string | null;
    updatedAt: string | null;
    archived: boolean;
    /** The engine's own id of the record this session continues, when the engine reports lineage. */
    nativeSessionId?: string;
    /** The session this one was forked from; `null` when the engine says it is not a fork. */
    forkedFromId?: string | null;
};

/** A request awaiting the user's answer, stored in the pending-request ledger under its `id`. */
export type PendingAction =
    | {
          id: string;
          kind: "permission";
          sessionId: string;
          params: acp.RequestPermissionRequest;
      }
    | {
          id: string;
          kind: "elicitation";
          sessionId: string | null;
          params: acp.CreateElicitationRequest;
      };

/** Why a session is being set up: hosts resolve tools and metadata per operation. */
export type SessionOperation =
    | { kind: "new" }
    | { kind: "resume"; sessionId: string }
    | { kind: "fork"; sourceSessionId: string };

/** Host integration data for one session set-up, never persisted in UI state. */
export type SessionContext = {
    mcpServers?: acp.McpServer[];
    appendSystemPrompt?: string;
    /** Opaque revision of the host context; a prompt on a stale revision reopens the session first. */
    revision?: string;
    /** Called with the session id once the agent answered, before the session is considered ready. */
    bind?: (sessionId: string) => Promise<void>;
};

/** Per-call additions to a `session/new`, `session/resume` or `session/fork` request. */
export type SessionRequestOptions = {
    mcpServers?: acp.McpServer[];
    /** Appended to the host's system prompt addition; sent as ACP `systemPrompt { mode: "append" }`. */
    systemPrompt?: string;
    /** Merged into the request's `_meta` (one level deep per top-level key). */
    meta?: Record<string, unknown>;
};

export type NewSessionOptions = SessionRequestOptions & {
    /** A session created before any message; it stays out of the list until its first prompt is dispatched. */
    draft?: boolean;
};

export type PromptOptions = {
    /** What goes on screen for the local copy, when it differs from what is sent (TV shows a summary of a canvas prompt). */
    display?: acp.ContentBlock[];
    /** Merged into `session/prompt`'s `_meta`; the agent echoes it with the user message. */
    meta?: Record<string, unknown>;
};

export type ListSessionsOptions = { reset?: boolean };

export type ClientState = {
    connection: ConnectionState;
    connectionError: string | null;
    agent: acp.InitializeResponse | null;
    sessions: Record<string, Session>;
    sessionList: SessionSummary[];
    sessionListLoaded: boolean;
    sessionListLoading: boolean;
    sessionListError: string | null;
    /** Sessions created as drafts that have not carried a message yet; never listed. */
    drafts: Record<string, true>;
    /** A configuration write is queued or running for the session. */
    configPending: Record<string, boolean>;
    actions: PendingAction[];
    /** The Runtime's view of every session it runs: four states including `done`, keyed by session id. */
    runStates: Record<string, SessionRunState>;
};

export type ClientOptions = {
    /** The one agent that hosts every session of this app. */
    agentId: string;
    launch: Launch;
    /** What `initialize` says this client is. */
    info?: { name: string; version: string };
    /** What `initialize` says this client can do; forms and URL elicitations by default. */
    capabilities?: Record<string, unknown>;
    /** The judgments the protocol cannot answer at fold time (an adapter subclass sets its dialect). */
    fold?: FoldPolicy;
    connectTimeoutMs?: number;
    /** Resolves ephemeral host integration data for the explicit workspace, never persisted in UI state. */
    sessionContext?: (
        cwd: string,
        operation: SessionOperation,
    ) => Promise<SessionContext>;
    sessionContextRevision?: () => Promise<string>;
    prepareSessionTools?: (sessionId: string) => Promise<void>;
    revokeSessionAccess?: (sessionId: string) => Promise<void>;
    /** Host-specific path identity: every alias a historical directory may be recorded under, canonical first. */
    projectPaths?: (cwd: string) => readonly [string, ...string[]];
};

const CLIENT_INFO = { name: "alwith", version: "0.1.0" };
const CLIENT_CAPABILITIES = { elicitation: { form: {}, url: {} } };
const CONNECT_TIMEOUT_MS = 60_000;

const runStateSources = new WeakMap<
    Record<string, SessionRunState>,
    "snapshot" | "event"
>();

/** Whether a `runStates` object came from the initial snapshot or from a later event. */
export function runStateSource(
    states: Record<string, SessionRunState>,
): "snapshot" | "event" {
    return runStateSources.get(states) ?? "snapshot";
}

function toAction(request: PendingRequest): PendingAction {
    return request.kind === "permission"
        ? {
              id: request.key,
              kind: "permission",
              sessionId: request.sessionId,
              params: request.params,
          }
        : {
              id: request.key,
              kind: "elicitation",
              sessionId: request.sessionId,
              params: request.params,
          };
}

function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

function withTimeout<T>(
    promise: Promise<T>,
    ms: number,
    message: string,
): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(message)), ms);
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error: unknown) => {
                clearTimeout(timer);
                reject(asError(error));
            },
        );
    });
}

/** Merges `_meta` objects one level deep per top-level key (`alwith`, `codex`…); later wins. */
export function mergeMeta(
    ...parts: Array<Record<string, unknown> | undefined>
): Record<string, unknown> | undefined {
    const merged: Record<string, unknown> = {};
    for (const part of parts) {
        if (!part) continue;
        for (const [key, value] of Object.entries(part)) {
            const current = merged[key];
            merged[key] =
                typeof value === "object" &&
                value !== null &&
                !Array.isArray(value) &&
                typeof current === "object" &&
                current !== null &&
                !Array.isArray(current)
                    ? {
                          ...(current as Record<string, unknown>),
                          ...(value as Record<string, unknown>),
                      }
                    : value;
        }
    }
    return Object.keys(merged).length > 0 ? merged : undefined;
}

/** What one replay asks of the agent: where the local projection restarts and what the resume carries. */
export type ReplayPlan = { from: "start" | number; replayFrom?: ReplayCursor };

/** Everything a replay hook needs to tell a stale continuation from the current one. */
export type ReplayScope = {
    agent: Agent;
    signal: AbortSignal;
    generation: SessionGeneration;
    baseline: Session;
};

export class SessionClient<State extends ClientState = ClientState> {
    readonly store: Store<State>;
    protected readonly options: ClientOptions;
    protected readonly sessions: SessionStore;
    /** Agent requests awaiting user input (permissions, questionnaires), including answers, cancellation on Stop, and agent withdrawals. */
    protected readonly requests = new AgentRequests(
        (id, result, error) => void this.agent?.respond(id, result, error),
    );
    /** open / close / delete lane per session: adjacent equal opens share one replay; close and delete revoke queued opens. */
    protected readonly lifecycle = new SessionLifecycle();
    protected readonly updates = new UpdateScheduler<Session>((snapshots) => {
        this.patch((state) => ({
            sessions: { ...state.sessions, ...snapshots },
        }));
    });
    protected agent: Agent | null = null;
    private agents: Agents<Launch> | null = null;
    private connecting: Promise<void> | null = null;
    private stopGap: (() => void) | undefined;
    private readonly openPort: () => Promise<RuntimeClient<Launch>>;
    private readonly contextRevisions = new Map<string, string | undefined>();
    private listRequest: Promise<void> | null = null;
    private listGeneration = 0;
    private readonly retiredChildren = new Set<string>();

    constructor(
        openPort: () => Promise<RuntimeClient<Launch>>,
        options: ClientOptions,
        extraState: Omit<State, keyof ClientState> = {} as Omit<
            State,
            keyof ClientState
        >,
    ) {
        this.openPort = openPort;
        this.options = options;
        this.sessions = new SessionStore(options.fold ?? {});
        const base: ClientState = {
            connection: "disconnected",
            connectionError: null,
            agent: null,
            sessions: {},
            sessionList: [],
            sessionListLoaded: false,
            sessionListLoading: false,
            sessionListError: null,
            drafts: {},
            configPending: {},
            actions: [],
            runStates: {},
        };
        this.store = createStore<State>({ ...base, ...extraState } as State);
        this.requests.onChange((pending) =>
            this.patch({ actions: pending.map(toAction) }),
        );
    }

    get state(): State {
        return this.store.getState();
    }

    /** Shallow state update typed against the base state; subclasses add their own fields through the same store. */
    protected patch(partial: StateSetter<ClientState>): void {
        this.store.setState(partial as StateSetter<State>);
    }

    /** The canonical project path of a directory, per the host's alias rules. */
    projectPath(cwd: string): string {
        return this.projectPaths(cwd)[0];
    }

    protected projectPaths(cwd: string): readonly [string, ...string[]] {
        return this.options.projectPaths?.(cwd) ?? [cwd];
    }

    session(id: string): Session {
        return this.sessions.get(id);
    }

    /** The session is held by this client (opened, created, or seen through a fork). */
    holds(id: string): boolean {
        return this.sessions.sessions.has(id);
    }

    /** A session created as a draft that has not carried a message yet. */
    isDraft(id: string): boolean {
        return this.state.drafts[id] === true;
    }

    // ── Connection ──

    connect(): Promise<void> {
        if (this.state.connection === "ready") return Promise.resolve();
        if (this.connecting) return this.connecting;
        this.connecting = this.doConnect().finally(() => {
            this.connecting = null;
        });
        return this.connecting;
    }

    private async doConnect(): Promise<void> {
        this.patch({ connection: "connecting", connectionError: null });
        try {
            const agent = await withTimeout(
                this.hold(),
                this.options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS,
                "The agent did not answer initialize",
            );
            this.agent = agent;
            agent.onNotification((method, params) => {
                if (this.agent !== agent) return;
                switch (method) {
                    case "session/update": {
                        const update = params as {
                            sessionId: string;
                            update: acp.SessionUpdate;
                        };
                        this.onUpdate(update.sessionId, update.update);
                        break;
                    }
                    case "_alwith/replay_started": {
                        const { sessionId, replayId } = params as {
                            sessionId: string;
                            replayId: string;
                        };
                        this.lifecycle.replays.started(sessionId, replayId);
                        break;
                    }
                    case "_alwith/replay_ended": {
                        const { sessionId, replayId } = params as {
                            sessionId: string;
                            replayId: string;
                        };
                        this.lifecycle.replays.ended(sessionId, replayId);
                        break;
                    }
                    default:
                        // `$/cancel_request` (the agent withdraws a permission / form) and `elicitation/complete`
                        if (!this.handleNotification(method, params))
                            this.requests.onNotification(method, params);
                }
            });
            agent.onAgentRequest((request) => {
                if (this.agent !== agent) return;
                const id = (request.params as { sessionId?: unknown } | null)
                    ?.sessionId;
                if (
                    typeof id === "string" &&
                    (this.retiredChildren.has(id) ||
                        (this.sessions.sessions.get(id)?.subagent &&
                            !this.sessions.get(id).attached))
                ) {
                    void agent.respond(request.id, undefined, {
                        code: -32800,
                        message: "Subagent attachment has been retired",
                    });
                    return;
                }
                if (!this.handleAgentRequest(agent, request))
                    this.requests.receive(request);
            });
            void agent.exited.then(() => this.onClosed(agent));
            this.onConnected(agent);
            this.patch({
                connection: "ready",
                connectionError: null,
                agent: agent.initialized,
            });
        } catch (error) {
            this.agent = null;
            this.patch({
                connection: "failed",
                connectionError: asError(error).message,
            });
            throw error;
        }
    }

    /**
     * One Runtime agent hosts every session. Attach to a session the Runtime still runs under our
     * agent id (reload, reconnect); otherwise reuse the running process or start the agent. Agent
     * requests still waiting for an answer are handed over on attach and go straight into the ledger.
     */
    private async hold(): Promise<Agent> {
        const port = await this.openPort();
        this.stopGap?.();
        this.stopGap = port.onGap(
            (gap) => void this.reloadAfterGap(gap.sessionId),
        );
        const agents = new Agents<Launch>(port, {
            info: this.options.info ?? CLIENT_INFO,
            capabilities: this.options.capabilities ?? CLIENT_CAPABILITIES,
        });
        this.agents = agents;
        // Which sessions are ours is a read-only question (`agentForSession`); asking it by attaching
        // would claim someone else's session and, on release, leave it ownerless. Ownership is per
        // agent, so claiming one of our sessions claims the process and replays every pending request.
        for (const state of await port.runStates()) {
            if (
                (await port.agentForSession(state.sessionId)) !==
                this.options.agentId
            )
                continue;
            const attached = await agents.attach(state.sessionId);
            if (!attached) continue;
            this.requests.receiveAll(
                attached.info.pendingAgentRequests.filter((request) =>
                    this.acceptsPendingRequest(request),
                ),
            );
            return attached.agent;
        }
        // A freshly started agent has no Runtime session yet. After a webview reload there is
        // therefore no session to attach through, but the process still needs to be reused.
        if (
            (await port.agents()).some(
                (agent) => agent.agentId === this.options.agentId,
            )
        ) {
            try {
                return await agents.adopt(
                    this.options.agentId,
                    this.options.launch.engine,
                );
            } catch (refused) {
                // The previous page's connection is gone (reload, browser reconnect) and its agent had no session
                // to attach through: the Runtime keeps it as an orphan that may only be stopped. Stopping is refused
                // while another live page holds it, which surfaces as the original error.
                const agentId = this.options.agentId;
                let exitedNow = () => {};
                const exited = new Promise<void>((resolve) => {
                    exitedNow = resolve;
                });
                const unlisten = await port.onExit((payload) => {
                    if (payload.agentId === agentId) exitedNow();
                });
                try {
                    await port.stop(agentId).catch(() => {
                        throw refused;
                    });
                    // The Runtime starts the same id again only after the old process has exited.
                    await exited;
                } finally {
                    unlisten();
                }
            }
        }
        return agents.start(
            this.options.agentId,
            this.options.launch,
            this.options.launch.engine,
        );
    }

    private onClosed(agent: Agent): void {
        if (this.agent !== agent) return;
        this.agent = null;
        this.stopGap?.();
        this.stopGap = undefined;
        this.lifecycle.clear();
        this.listRequest = null;
        this.listGeneration++;
        this.updates.cancel();
        this.onDisconnected();
        // The process is gone (or we let go of it): nothing pending can be answered any more.
        this.requests.release();
        const sessions: Record<string, Session> = {};
        for (const session of this.sessions.sessions.values()) {
            const detached = markDisconnected(session);
            this.sessions.set(detached);
            sessions[session.id] = detached;
        }
        this.patch({
            connection: "disconnected",
            connectionError: this.disconnectedMessage(),
            sessionListLoading: false,
            sessions,
            actions: [],
        });
    }

    /** Let go of the agent: the process stays in the Runtime for the next attach. */
    disconnect(): void {
        const agent = this.agent;
        if (!agent) return;
        this.agents?.release(agent);
        this.onClosed(agent);
    }

    protected live(): Agent {
        if (!this.agent || this.state.connection !== "ready")
            throw new Error("The agent is not connected");
        return this.agent;
    }

    /** Runtime run-state snapshot (broadcast on every change). */
    applyRunStates(
        sessions: SessionRunState[],
        source: "snapshot" | "event" = "event",
    ): void {
        const runStates: Record<string, SessionRunState> = {};
        for (const session of sessions) runStates[session.sessionId] = session;
        runStateSources.set(runStates, source);
        this.patch({ runStates });
    }

    // ── Updates ──

    protected onUpdate(sessionId: string, update: acp.SessionUpdate): void {
        // A frame of a replay this session is no longer waiting for arrived late; the one it waits for carries its own id.
        if (!this.lifecycle.accept(sessionId, update)) return;
        if (!this.sessions.sessions.has(sessionId)) {
            // A frame for a session this client does not hold. While a session is being created its id is not known yet, so the
            // frame waits for the response and is applied right after it; otherwise the session was closed here and this is the
            // agent's tail after our close, which belongs to nobody any more.
            this.lifecycle.births.buffer(sessionId, update);
            return;
        }
        const current = this.sessions.get(sessionId);
        if (current.subagent && !current.attached) return;
        if (SessionUpdateGuard.isSubagentUpdate(update)) {
            if (!current.attached && !current.restoring) return;
            const child = this.sessions.announce(sessionId, update);
            const parent = this.sessions.accept(sessionId, update);
            if (!parent.restoring) this.updates.enqueue(sessionId, parent);
            this.retiredChildren.delete(child.id);
            this.publishSession(child);
            return;
        }
        const session = this.sessions.accept(sessionId, update);
        if (!session.restoring && SessionUpdateGuard.isUserMessage(update)) {
            // Use native turn time when available; replay must never look like new activity.
            const updatedAt = new Date(
                this.turnStartedAt(
                    update._meta as Record<string, unknown> | null | undefined,
                ) ?? Date.now(),
            ).toISOString();
            this.patch((state) => ({
                sessionList: state.sessionList.map((item) =>
                    item.sessionId === sessionId &&
                    (item.updatedAt === null || item.updatedAt < updatedAt)
                        ? { ...item, updatedAt }
                        : item,
                ),
            }));
        }
        // A replay folds silently: `replay()` publishes the finished session once the
        // resume answers, so nothing schedules a render per replayed frame.
        if (!session.restoring) {
            this.onSessionChanged(session);
            this.updates.enqueue(sessionId, session);
            if (
                SessionUpdateGuard.isStateUpdate(update) ||
                SessionUpdateGuard.isConfigOptionUpdate(update)
            ) {
                // Live lifecycle and configuration changes are observable immediately,
                // together with all earlier chunks. A completion must never overtake its text.
                this.updates.flush();
            }
        }
        if (SessionUpdateGuard.isSessionInfoUpdate(update)) {
            const frame = update;
            this.patch((state) => ({
                sessionList: state.sessionList.map((item) =>
                    item.sessionId === sessionId
                        ? {
                              ...item,
                              title:
                                  frame.title === undefined
                                      ? item.title
                                      : frame.title,
                              updatedAt:
                                  frame.updatedAt === undefined
                                      ? item.updatedAt
                                      : frame.updatedAt,
                          }
                        : item,
                ),
            }));
        }
    }

    protected publishSession(session: Session): void {
        this.sessions.set(session);
        if (!session.restoring) this.onSessionChanged(session);
        this.updates.enqueue(session.id, session);
        this.updates.flush();
    }

    respond(
        actionId: string,
        answer: acp.RequestPermissionResponse | acp.CreateElicitationResponse,
    ): void {
        const request = this.requests.get(actionId);
        if (!request)
            throw new Error("This request has expired or was already answered");
        if (request.kind === "permission") {
            const outcome = (answer as acp.RequestPermissionResponse).outcome;
            const valid =
                outcome.outcome === "cancelled" ||
                (outcome.outcome === "selected" &&
                    request.params.options.some(
                        (option) =>
                            option.optionId ===
                            (outcome as { optionId: string }).optionId,
                    ));
            if (!valid) throw new Error("Invalid permission choice");
        } else if (
            !["accept", "decline", "cancel"].includes(
                (answer as acp.CreateElicitationResponse).action,
            )
        ) {
            throw new Error("Invalid form action");
        }
        this.requests.answer(actionId, answer);
    }

    // ── Session list ──

    /** Include an explicitly selected entry in the shared list (a history pick, a session another window opened). */
    includeSession(summary: SessionSummary): void {
        if (
            this.state.sessionList.some(
                (item) => item.sessionId === summary.sessionId,
            )
        )
            return;
        this.patch((state) => ({
            sessionList: [
                ...state.sessionList,
                { ...summary, cwd: this.projectPath(summary.cwd) },
            ],
        }));
    }

    listSessions(options: ListSessionsOptions = {}): Promise<void> {
        if (this.listRequest) return this.listRequest;
        if (!options.reset && this.state.sessionListLoaded)
            return Promise.resolve();
        const request = this.readSessionList().finally(() => {
            if (this.listRequest === request) this.listRequest = null;
        });
        this.listRequest = request;
        return request;
    }

    protected async readSessionList(): Promise<void> {
        const generation = ++this.listGeneration;
        const before = new Map(
            this.state.sessionList.map((item) => [item.sessionId, item]),
        );
        this.patch({ sessionListLoading: true, sessionListError: null });
        try {
            const page = (await this.fetchSessionList())
                .map((info) => this.summaryOf(info))
                .filter(
                    (item) =>
                        !item.archived && !this.state.drafts[item.sessionId],
                );
            if (generation !== this.listGeneration) return;
            this.patch((current) => {
                // Preserve mutations made after dispatch, including removal and reordering.
                const after = new Map(
                    current.sessionList.map((item) => [item.sessionId, item]),
                );
                const changed = new Set(
                    [...before.keys(), ...after.keys()].filter(
                        (id) => before.get(id) !== after.get(id),
                    ),
                );
                const fresh = page.filter(
                    (item) => !changed.has(item.sessionId),
                );
                const kept = current.sessionList.filter(
                    (item) =>
                        changed.has(item.sessionId) || this.keepUnlisted(item),
                );
                const merged = [
                    ...new Map(
                        [...kept, ...fresh].map((item) => [
                            item.sessionId,
                            item,
                        ]),
                    ).values(),
                ];
                return { sessionList: merged, sessionListLoaded: true };
            });
        } catch (error) {
            if (generation !== this.listGeneration) return;
            this.patch({ sessionListError: asError(error).message });
            throw error;
        } finally {
            if (generation === this.listGeneration)
                this.patch({ sessionListLoading: false });
        }
    }

    /** Every session the agent lists, across pages. An adapter subclass may use its own full-list method. */
    protected async fetchSessionList(): Promise<acp.SessionInfo[]> {
        const agent = this.live();
        const sessions = new Map<string, acp.SessionInfo>();
        const cursors = new Set<string>();
        let cursor: string | undefined;
        do {
            const response = await agent.request(
                "session/list",
                cursor === undefined ? {} : { cursor },
            );
            for (const info of response.sessions)
                sessions.set(info.sessionId, info);
            cursor = response.nextCursor ?? undefined;
            if (cursor !== undefined) {
                if (cursors.has(cursor))
                    throw new Error("Session list returned a repeated cursor");
                cursors.add(cursor);
            }
        } while (cursor !== undefined);
        return [...sessions.values()];
    }

    /** The list row for what the agent reports; adapters read their own `_meta` here. */
    protected summaryOf(info: acp.SessionInfo): SessionSummary {
        return {
            sessionId: info.sessionId,
            cwd: this.projectPath(info.cwd),
            title: info.title ?? null,
            updatedAt: info.updatedAt ?? null,
            archived: false,
            ...this.lineageOf(
                info._meta as Record<string, unknown> | null | undefined,
            ),
        };
    }

    /** Lineage the agent reports in `_meta`; adapters know where. */
    protected lineageOf(
        _meta: Record<string, unknown> | null | undefined,
    ): Pick<SessionSummary, "nativeSessionId" | "forkedFromId"> {
        return {};
    }

    /** A listed row a refresh must keep even when the agent's list lacks it: an attached fork the agent has not indexed yet. */
    protected keepUnlisted(item: SessionSummary): boolean {
        return (
            !item.archived &&
            item.forkedFromId != null &&
            this.state.sessions[item.sessionId]?.attached === true
        );
    }

    protected listSession(summary: SessionSummary): void {
        this.patch((state) => ({
            sessionList: [
                summary,
                ...state.sessionList.filter(
                    (item) => item.sessionId !== summary.sessionId,
                ),
            ],
        }));
    }

    protected unlistSession(id: string): void {
        this.patch((state) => ({
            sessionList: state.sessionList.filter(
                (item) => item.sessionId !== id,
            ),
        }));
    }

    // ── Create, open, replay ──

    protected async requestContext(
        cwd: string,
        operation: SessionOperation,
        options: SessionRequestOptions,
    ): Promise<{
        revision?: string;
        bind?: (sessionId: string) => Promise<void>;
        mcpServers?: acp.McpServer[];
        systemPrompt?: acp.SystemPrompt;
        _meta?: Record<string, unknown>;
    }> {
        const host = this.options.sessionContext
            ? await this.options.sessionContext(cwd, operation)
            : {};
        const mcpServers = options.mcpServers ?? host.mcpServers;
        const appended = [host.appendSystemPrompt, options.systemPrompt]
            .filter((text) => !!text)
            .join("\n\n");
        const meta = mergeMeta(this.sessionMeta(operation), options.meta);
        return {
            ...(host.revision === undefined ? {} : { revision: host.revision }),
            ...(host.bind === undefined ? {} : { bind: host.bind }),
            ...(mcpServers ? { mcpServers } : {}),
            ...(appended ? { systemPrompt: this.systemPrompt(appended) } : {}),
            ...(meta ? { _meta: meta } : {}),
        };
    }

    /** ACP v2 `systemPrompt` (append). The protocol only lets a client send it to an agent that advertises `session.systemPrompt`. */
    private systemPrompt(text: string): acp.SystemPrompt {
        if (!this.state.agent?.capabilities?.session?.systemPrompt) {
            throw new Error(
                "The agent does not advertise capabilities.session.systemPrompt",
            );
        }
        return { mode: "append", content: [{ type: "text", text }] };
    }

    async newSession(
        cwd: string,
        options: NewSessionOptions = {},
    ): Promise<string> {
        const { revision, bind, ...context } = await this.requestContext(
            cwd,
            { kind: "new" },
            options,
        );
        const response = await this.born(
            () =>
                this.live().request("session/new", {
                    cwd,
                    mcpServers: [],
                    ...context,
                }),
            (response) => {
                const session: Session = {
                    ...createSession(response.sessionId, cwd),
                    attached: true,
                    configOptions: response.configOptions ?? [],
                    commands: response.availableCommands ?? [],
                    configRevision: configRevisionOf(response),
                };
                this.publishSession(session);
                if (options.draft)
                    this.patch((state) => ({
                        drafts: { ...state.drafts, [session.id]: true },
                    }));
                else
                    this.listSession({
                        ...this.summaryOf({
                            sessionId: session.id,
                            cwd,
                            ...(response._meta
                                ? { _meta: response._meta }
                                : {}),
                        }),
                        updatedAt: new Date().toISOString(),
                    });
            },
        );
        await bind?.(response.sessionId);
        this.contextRevisions.set(response.sessionId, revision);
        await this.afterSessionCreated(response.sessionId);
        return response.sessionId;
    }

    /**
     * Creates a session: the response names it, `settle` records it, and the frames the agent sent for it before the response
     * (held in the shared creation buffer) are applied right after, in order. Frames held for ids that were never born are dropped once nothing is
     * being created.
     */
    protected born<Response extends { sessionId: string }>(
        request: () => Promise<Response>,
        settle: (response: Response) => void,
    ): Promise<Response> {
        return this.lifecycle.births.run(
            request,
            settle,
            (id, update) => this.onUpdate(id, update),
            (id) => this.sessions.sessions.has(id),
        );
    }

    /** A draft that carried its first message enters the list for good. */
    protected materializeDraft(id: string): void {
        if (!this.state.drafts[id]) return;
        this.patch((state) => {
            const { [id]: _draft, ...drafts } = state.drafts;
            return { drafts };
        });
        const session = this.session(id);
        this.listSession({
            ...this.summaryOf({
                sessionId: id,
                cwd: session.cwd,
                title: session.title,
            }),
            updatedAt: new Date().toISOString(),
        });
        this.onDraftMaterialized(id);
    }

    /** Deletes a draft that never carried a message; a no-op for anything else. */
    async discardDraft(id: string): Promise<void> {
        if (!this.state.drafts[id]) return;
        await this.delete(id);
    }

    async open(
        id: string,
        cwd: string,
        options: SessionRequestOptions = {},
    ): Promise<void> {
        this.assertRootSession(id);
        const existing = this.sessions.sessions.get(id);
        // A replay in flight already carries this open. A read-only attach (another client holds the
        // writer) is resumed again: the writer may have let go since.
        if (
            existing?.attached &&
            !existing.restoring &&
            !existing.readOnly &&
            !this.lifecycle.operations.busy(id)
        )
            return;
        await this.replay(id, cwd, options);
    }

    /** Resume a session the Runtime runs without this client having opened it (a remote window's input). */
    async openRemote(
        id: string,
        options: SessionRequestOptions = {},
    ): Promise<void> {
        this.assertRootSession(id);
        const session = this.state.sessions[id];
        if (
            session?.attached &&
            !session.restoring &&
            !session.readOnly &&
            !this.lifecycle.operations.busy(id)
        )
            return;
        const runtime = this.state.runStates[id];
        if (!runtime) throw new Error(`Unknown Runtime session: ${id}`);
        await this.replay(id, runtime.cwd, options);
    }

    /**
     * The client could not refill a hole in this session's event stream (the Runtime journal had
     * already dropped those frames): what we hold is no longer continuous, so replay the whole
     * session from the engine's own record instead of rendering as if nothing happened.
     */
    private async reloadAfterGap(id: string): Promise<void> {
        const session = this.sessions.sessions.get(id);
        if (!session || session.restoring) return;
        await this.replay(id, session.cwd);
    }

    protected replay(
        id: string,
        cwd: string,
        options: SessionRequestOptions = {},
    ): Promise<void> {
        return this.lifecycle.operations.open(id, cwd, (signal) =>
            this.runReplay(id, cwd, signal, options),
        );
    }

    private async runReplay(
        id: string,
        cwd: string,
        signal: AbortSignal,
        options: SessionRequestOptions,
    ): Promise<void> {
        this.assertRootSession(id);
        this.dropChildren(id);
        const generation = this.lifecycle.beginReplay(id);
        if (!this.sessions.sessions.has(id))
            this.sessions.set(createSession(id, cwd));
        const agent = this.live();
        this.beforeReplay(id);
        const plan = this.replayPlan(agent, this.sessions.get(id));
        this.sessions.beginReplay(id, plan.from);
        const baseline = this.sessions.get(id);
        const scope: ReplayScope = { agent, signal, generation, baseline };
        this.publishSession(this.sessions.get(id));
        try {
            const { revision, bind, ...context } = await this.requestContext(
                cwd,
                { kind: "resume", sessionId: id },
                options,
            );
            signal.throwIfAborted();
            const response = await agent.request(
                "session/resume",
                {
                    sessionId: id,
                    cwd,
                    ...(plan.replayFrom ? { replayFrom: plan.replayFrom } : {}),
                    ...context,
                },
                { cancellationSignal: signal },
            );
            signal.throwIfAborted();
            if (!this.current(scope))
                throw new Error("Session retired during resume");
            await bind?.(id);
            signal.throwIfAborted();
            if (!this.current(scope))
                throw new Error("Session retired during binding");
            this.contextRevisions.set(id, revision);
            await this.afterResume(id, cwd, scope);
            signal.throwIfAborted();
            if (!this.current(scope))
                throw new Error("Session retired during history load");
            this.sessions.endReplay(id, replayReceiptOf(response));
            this.publishSession({
                ...this.sessions.get(id),
                cwd,
                readOnly: this.resumeReadOnly(response),
                configOptions: response.configOptions ?? [],
                commands:
                    response.availableCommands ??
                    this.sessions.get(id).commands,
                configRevision:
                    configRevisionOf(response) ??
                    this.sessions.get(id).configRevision,
                error: null,
            });
            this.onReplayed(id, response);
        } catch (error) {
            if (!this.current(scope) || !this.sessions.sessions.has(id))
                throw error;
            this.dropChildren(id);
            if (await this.recoverReplay(id, cwd, error, scope)) return;
            this.publishSession({
                ...this.sessions.get(id),
                restoring: false,
                attached: false,
            });
            throw error;
        }
    }

    /** Whether a replay continuation still belongs to the live agent and the session's current attachment. */
    protected current(scope: ReplayScope): boolean {
        return (
            this.agent === scope.agent &&
            this.lifecycle.isCurrent(scope.generation)
        );
    }

    // ── Prompt, cancel, configure ──

    /**
     * Sends one turn and returns the message id the agent inserted it under. The user's message goes on
     * screen now under a local id; the receipt claims the local copy by that id alone, never by the
     * later `user_message` echo or its text. Echo and receipt may arrive in either order.
     */
    prompt(
        id: string,
        prompt: acp.ContentBlock[],
        options: PromptOptions = {},
    ): Promise<string> {
        this.assertRootSession(id);
        return this.lifecycle.prompt(
            id,
            (checkpoint) => {
                if (
                    this.options.sessionContextRevision ||
                    this.options.prepareSessionTools
                )
                    return this.preparePrompt(id, prompt, checkpoint);
                return undefined;
            },
            () => this.dispatchPrompt(id, prompt, options).receipt,
            (operation) => this.enqueueSession(id, operation, false),
        );
    }

    private async preparePrompt(
        id: string,
        prompt: acp.ContentBlock[],
        checkpoint: () => void,
    ): Promise<void> {
        let session = this.sessions.get(id);
        if (!session.attached)
            throw new Error("Open the session before sending");
        if (prompt.length === 0) throw new Error("Enter a message");
        const run = this.state.runStates[id]?.state;
        // Refresh tools on the next idle prompt; active turns must still accept replies and steering.
        if (
            run !== "running" &&
            run !== "requires_action" &&
            this.options.sessionContextRevision &&
            this.contextRevisions.get(id) !==
                (await this.options.sessionContextRevision())
        ) {
            checkpoint();
            await this.live().request("session/close", { sessionId: id });
            checkpoint();
            this.updates.remove(id);
            this.publishSession({ ...this.sessions.get(id), attached: false });
            checkpoint();
            await this.replay(id, session.cwd);
            session = this.sessions.get(id);
        }
        checkpoint();
        if (this.options.prepareSessionTools) {
            const run = this.state.runStates[id]?.state;
            if (run !== "running" && run !== "requires_action") {
                try {
                    await this.options.prepareSessionTools(id);
                } catch {
                    checkpoint();
                    await this.live().request("session/close", {
                        sessionId: id,
                    });
                    checkpoint();
                    this.updates.remove(id);
                    this.publishSession({
                        ...this.sessions.get(id),
                        attached: false,
                    });
                    checkpoint();
                    await this.replay(id, session.cwd);
                    await this.options.prepareSessionTools(id);
                }
            }
        }
        checkpoint();
    }

    private dispatchPrompt(
        id: string,
        prompt: acp.ContentBlock[],
        options: PromptOptions,
    ): { receipt: Promise<string> } {
        if (!this.sessions.get(id).attached)
            throw new Error("Open the session before sending");
        if (prompt.length === 0) throw new Error("Enter a message");
        const agent = this.live();
        assertPromptSupported(agent.initialized, prompt);
        const generation = this.lifecycle.capture(id);
        const localId = this.sessions.addPrompt(id, options.display ?? prompt);
        this.publishSession(this.sessions.get(id));
        // Once a request leaves the client, transport failure cannot prove it was not accepted.
        // Retire draft cleanup eligibility before dispatch so a lost receipt can never erase a conversation.
        this.materializeDraft(id);
        const bound = promptConfigMeta(
            agent.initialized,
            this.sessions.get(id),
        );
        const meta = mergeMeta(
            this.promptMeta(id, options),
            Object.keys(bound).length > 0 ? { alwith: bound } : undefined,
        );
        const response = this.lifecycle.submissions.submit(
            id,
            () =>
                agent.request("session/prompt", {
                    sessionId: id,
                    prompt,
                    ...(meta ? { _meta: meta } : {}),
                }),
            undefined,
            (error) => configStaleOf(error) !== null,
        ).receipt;
        // Return the receipt as data: admission ends at dispatch, not at receipt or turn completion.
        return {
            receipt: this.acceptPromptReceipt(
                id,
                localId,
                agent,
                generation,
                response,
            ),
        };
    }

    private async acceptPromptReceipt(
        id: string,
        localId: string,
        agent: Agent,
        generation: SessionGeneration,
        response: Promise<acp.PromptResponse>,
    ): Promise<string> {
        const assertCurrent = () => {
            if (this.agent !== agent || !this.lifecycle.isCurrent(generation))
                throw new AgentGoneError(
                    agent.agentId,
                    "prompt receipt belongs to a retired session",
                );
        };
        let accepted: acp.PromptResponse;
        try {
            accepted = await response;
        } catch (error) {
            assertCurrent();
            // The connection went away with the request out: whether it became a turn is unknown, so the
            // local copy stays; the replay after reconnecting shows what the agent recorded.
            if (error instanceof AgentGoneError) throw error;
            const current = this.sessions.get(id);
            const withoutLocal = current.items.filter(
                (item) => item.id !== localId,
            );
            // The config moved past what the user saw: take the agent's actual options, take the local copy
            // off screen (nothing was sent) and say so, so the user can resend against what is current.
            const stale = configStaleOf(error);
            if (stale !== null) {
                this.publishSession({
                    ...current,
                    items: withoutLocal,
                    configOptions: stale.configOptions,
                    configRevision: stale.actual,
                });
                throw new ConfigStaleError(stale);
            }
            // The agent refused the request, so it never became a turn: take the unacknowledged local copy
            // off screen again; the caller keeps the text in its composer.
            this.publishSession({ ...current, items: withoutLocal });
            throw error;
        }
        assertCurrent();
        this.sessions.acknowledgePrompt(id, localId, accepted.messageId);
        this.publishSession(this.sessions.get(id));
        return accepted.messageId;
    }

    async cancel(id: string): Promise<void> {
        if (this.retiredChildren.has(id))
            throw new Error(`Subagent ${id} attachment has been retired`);
        const child = this.sessions.sessions.get(id);
        if (child?.subagent) {
            if (!child.attached || !child.subagent.capabilities?.cancel)
                throw new Error(`Subagent ${id} does not allow cancellation`);
            this.cancelTreeRequests(id);
            await this.live().notify("session/cancel", { sessionId: id });
            return;
        }
        this.cancelTreeRequests(id);
        this.lifecycle.cancelPreparing(id);
        // The protocol: every pending permission of the session MUST be answered `cancelled`
        // (and forms cancelled) — otherwise they hang in the agent and the Runtime and come back
        // as zombie prompts on the next attach.
        this.requests.cancelSession(id);
        this.onCancel(id);
        await this.stopWithAccessRevocation(id, () =>
            this.live().notify("session/cancel", { sessionId: id }),
        );
    }

    private async stopWithAccessRevocation(
        id: string,
        stop: () => Promise<unknown>,
    ): Promise<void> {
        // A native cleanup failure must not leave the turn running. Start revocation first, attempt
        // both operations, and report every failure.
        const revoke = Promise.resolve().then(() =>
            this.options.revokeSessionAccess?.(id),
        );
        const results = await Promise.allSettled([
            revoke,
            Promise.resolve().then(stop),
        ]);
        const errors = results.flatMap((result) =>
            result.status === "rejected" ? [result.reason as unknown] : [],
        );
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1)
            throw new AggregateError(errors, "Session stop failed");
    }

    setConfig(
        id: string,
        configId: string,
        value: string | boolean,
    ): Promise<void> {
        this.assertRootSession(id);
        const write = async (): Promise<void> => {
            const agent = this.live();
            const generation = this.lifecycle.capture(id);
            const response = await agent.request(
                "session/set_config_option",
                configOptionRequest(
                    id,
                    this.sessions.get(id).configOptions,
                    configId,
                    value,
                ),
            );
            if (this.agent !== agent || !this.lifecycle.isCurrent(generation))
                throw new AgentGoneError(
                    agent.agentId,
                    "configuration belongs to a retired session",
                );
            this.publishSession({
                ...this.sessions.get(id),
                configOptions: response.configOptions,
                configRevision:
                    configRevisionOf(response) ??
                    this.sessions.get(id).configRevision,
            });
            this.onConfigChanged(id, configId, response);
        };
        this.patch((state) => ({
            configPending: { ...state.configPending, [id]: true },
        }));
        return this.enqueueSession(id, write, false);
    }

    /** One ordered lane per session; `configPending` clears once the lane drains. */
    protected enqueueSession<T>(
        id: string,
        operation: () => Promise<T>,
        continueAfterFailure = true,
    ): Promise<T> {
        const next = this.lifecycle.admission.enqueue(
            id,
            operation,
            continueAfterFailure,
        );
        const release = (): void => {
            if (this.lifecycle.admission.pending(id) === undefined) {
                this.patch((state) => {
                    const { [id]: _pending, ...configPending } =
                        state.configPending;
                    return { configPending };
                });
            }
        };
        void next.then(release, release);
        return next;
    }

    // ── Close, stop, delete, fork ──

    async close(id: string): Promise<void> {
        this.assertRootSession(id);
        this.cancelTreeRequests(id);
        this.lifecycle.cancelPreparing(id);
        await this.lifecycle.operations.close(id, () =>
            this.enqueueSession(id, async () => {
                this.requests.cancelSession(id);
                await this.stopWithAccessRevocation(id, () =>
                    this.live().request("session/close", { sessionId: id }),
                );
                this.dropSession(id);
            }),
        );
    }

    /** End the live session while retaining what is on screen. */
    async stopSession(id: string): Promise<void> {
        this.assertRootSession(id);
        this.cancelTreeRequests(id);
        this.lifecycle.cancelPreparing(id);
        await this.lifecycle.operations.close(id, () =>
            this.enqueueSession(id, async () => {
                this.requests.cancelSession(id);
                await this.stopWithAccessRevocation(id, () =>
                    this.live().request("session/close", { sessionId: id }),
                );
                this.dropChildren(id);
                this.updates.remove(id);
                this.lifecycle.retire(id);
                const session = this.sessions.sessions.get(id);
                // The Runtime may run sessions this client never opened.
                if (session) {
                    this.publishSession({
                        ...session,
                        attached: false,
                        restoring: false,
                        readOnly: false,
                        state: "idle",
                    });
                }
            }),
        );
    }

    async delete(id: string): Promise<void> {
        this.assertRootSession(id);
        this.cancelTreeRequests(id);
        this.lifecycle.cancelPreparing(id);
        await this.lifecycle.operations.delete(id, async () => {
            // Host access is revoked before the lifecycle changes; a failed revocation leaves the session as it was.
            await this.options.revokeSessionAccess?.(id);
            await this.deleteRemote(id);
            this.dropSession(id);
            this.unlistSession(id);
        });
    }

    /** `session/delete`; an adapter subclass may treat its own "already gone" answer as success. */
    protected async deleteRemote(id: string): Promise<void> {
        await this.live().request("session/delete", { sessionId: id });
    }

    async fork(
        id: string,
        cwd: string,
        options: SessionRequestOptions = {},
    ): Promise<string> {
        this.assertRootSession(id);
        const { revision, bind, ...context } = await this.requestContext(
            cwd,
            { kind: "fork", sourceSessionId: id },
            options,
        );
        const response = await this.born(
            () =>
                this.live().request("session/fork", {
                    sessionId: id,
                    cwd,
                    ...context,
                }),
            // Fork history arrives before the new session id is known: it waits in the creation buffer and is applied as replay below.
            (response) =>
                this.sessions.set({
                    ...createSession(response.sessionId, cwd),
                    attached: true,
                }),
        );
        await bind?.(response.sessionId);
        this.contextRevisions.set(response.sessionId, revision);
        const forked = this.sessions.get(response.sessionId);
        this.publishSession({
            ...forked,
            items: forked.items.map((item) => ({ ...item, replayed: true })),
            cwd,
            attached: true,
            restoring: false,
            configOptions: response.configOptions ?? [],
            commands: response.availableCommands ?? forked.commands,
            configRevision: configRevisionOf(response) ?? forked.configRevision,
        });
        this.listSession({
            ...this.summaryOf({
                sessionId: response.sessionId,
                cwd,
                title: forked.title,
                ...(response._meta === undefined
                    ? {}
                    : { _meta: response._meta }),
            }),
            updatedAt: new Date().toISOString(),
        });
        this.onForked(response.sessionId, response);
        return response.sessionId;
    }

    private assertRootSession(id: string): void {
        if (
            this.retiredChildren.has(id) ||
            this.sessions.sessions.get(id)?.subagent
        )
            throw new Error(
                `Subagent ${id} is managed by its parent; only advertised cancellation is supported`,
            );
    }

    private cancelTreeRequests(id: string): void {
        this.requests.cancelSession(id);
        for (const child of this.sessions.children(id))
            this.cancelTreeRequests(child.id);
    }

    private dropChildren(id: string): void {
        for (const child of this.sessions.children(id))
            this.dropSession(child.id);
    }

    protected dropSession(id: string): void {
        this.dropChildren(id);
        this.lifecycle.retire(id);
        this.contextRevisions.delete(id);
        this.updates.remove(id);
        this.requests.cancelSession(id);
        if (this.sessions.sessions.get(id)?.subagent)
            this.retiredChildren.add(id);
        this.sessions.delete(id);
        this.onSessionDropped(id);
        this.patch((state) => {
            const { [id]: _removed, ...sessions } = state.sessions;
            const { [id]: _draft, ...drafts } = state.drafts;
            return { sessions, drafts };
        });
    }

    // ── Login ──

    async login(
        methodId: string,
        extra: Record<string, unknown> = {},
    ): Promise<void> {
        await this.live().request("auth/login", {
            methodId,
            ...(Object.keys(extra).length ? { _meta: extra } : {}),
        });
    }

    async logout(): Promise<void> {
        await this.live().request("auth/logout", {});
    }

    // ── Extension points (engine adapters and applications override these) ──

    /** A pending request handed over on attach that this client answers through its ledger. */
    protected acceptsPendingRequest(_request: AgentRequest): boolean {
        return true;
    }

    /** A notification the subclass consumes; `false` leaves it to the request ledger. */
    protected handleNotification(_method: string, _params: unknown): boolean {
        return false;
    }

    /** An agent request the subclass answers itself (a client tool call); `false` puts it in the ledger. */
    protected handleAgentRequest(
        _agent: Agent,
        _request: AgentRequest,
    ): boolean {
        return false;
    }

    protected onConnected(_agent: Agent): void {}
    protected onDisconnected(): void {}
    /** What `connectionError` says once the agent is gone; an adapter names its engine. */
    protected disconnectedMessage(): string {
        return "The agent disconnected";
    }

    /** `_meta` every set-up request of this engine carries for the operation. */
    protected sessionMeta(
        _operation: SessionOperation,
    ): Record<string, unknown> | undefined {
        return undefined;
    }

    /** `_meta` a prompt carries; the caller's `options.meta` by default. */
    protected promptMeta(
        _id: string,
        options: PromptOptions,
    ): Record<string, unknown> | undefined {
        return options.meta;
    }

    /** When the engine recorded the turn a user message opened, in Unix milliseconds; `null` to use arrival time. */
    protected turnStartedAt(
        _meta: Record<string, unknown> | null | undefined,
    ): number | null {
        return null;
    }

    /** From where this session has the record when the agent can continue from a position; otherwise from the start. */
    protected replayPlan(agent: Agent, session: Session): ReplayPlan {
        const cursor = replayCursorFor(agent.initialized, session);
        return {
            from: cursor.type === "start" ? "start" : cursor.after,
            replayFrom: cursor,
        };
    }

    /** `session/resume` answered from a read path because another client holds the writer. */
    protected resumeReadOnly(_response: acp.ResumeSessionResponse): boolean {
        return false;
    }

    protected beforeReplay(_id: string): void {}
    /** Runs after the resume answered and the host bound the session, before the session is published live. */
    protected async afterResume(
        _id: string,
        _cwd: string,
        _scope: ReplayScope,
    ): Promise<void> {}
    protected onReplayed(
        _id: string,
        _response: acp.ResumeSessionResponse,
    ): void {}
    /** Turns a failed resume into a settled state; `true` means the session was published and the failure consumed. */
    protected async recoverReplay(
        _id: string,
        _cwd: string,
        _error: unknown,
        _scope: ReplayScope,
    ): Promise<boolean> {
        return false;
    }

    protected async afterSessionCreated(_id: string): Promise<void> {}
    protected onSessionChanged(_session: Session): void {}
    protected onConfigChanged(
        _id: string,
        _configId: string,
        _response: acp.SetSessionConfigOptionResponse,
    ): void {}
    protected onForked(_id: string, _response: acp.ForkSessionResponse): void {}
    protected onDraftMaterialized(_id: string): void {}
    protected onCancel(_id: string): void {}
    protected onSessionDropped(_id: string): void {}
}
