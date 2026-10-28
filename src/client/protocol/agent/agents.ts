// The agents this app holds: each is a process inside the Runtime, started here (start) or taken over (attachSession),
// handshaken once; we receive its notifications and requests, send it requests, until it exits or is let go.
//
// Things every WorkBuddy must do and that cause incidents when done wrong live here:
// - before spawning, ask the Runtime whether one is already alive (take over instead of starting another);
// - swapping the engine = stop -> wait for exit -> start (one process per agentId at a time; the Runtime rejects concurrent starts);
// - when the process exits / is stopped / is let go, requests still awaiting an answer fail immediately, so the caller's await never hangs;
// - stop must wait for the exit event, otherwise the engine-switch resume would reattach to the old process.
import type * as acp from "@agentclientprotocol/sdk/experimental/v2/unstable";
import { Effect, Exit, Scope } from "effect";

import { attempt, failure, run } from "../lifecycle/internal";
import { type AgentRequest } from "./requests";

/** The only protocol version this library speaks. */
export const PROTOCOL_VERSION = 2;

/** The minimum `attachSession` hands back: which agent, which engine, and the requests still unanswered. A port's own type may carry more (provider, ...). */
export interface AttachInfo {
    agentId: string;
    engine: string;
    pendingAgentRequests: AgentRequest[];
}

/**
 * The full set of requirements `Agents` places on a port: a subset of `RuntimeClient`. An app's own host port (such as the desktop Tauri relay)
 * only needs to provide these.
 */
export interface AgentPort<Launch, Info extends AttachInfo = AttachInfo> {
    start(agentId: string, launch: Launch): Promise<void>;
    stop(agentId: string): Promise<void>;
    agents(): Promise<Array<{ agentId: string }>>;
    attachSession(sessionId: string): Promise<Info | null>;
    releaseSession(sessionId: string): Promise<void>;
    acpRequest<Result = unknown>(
        agentId: string,
        method: string,
        params?: unknown,
        options?: { id?: string | number },
    ): Promise<Result>;
    acpNotify(agentId: string, method: string, params?: unknown): Promise<void>;
    acpRespond(
        agentId: string,
        id: unknown,
        result?: unknown,
        error?: unknown,
    ): Promise<void>;
    onAcpNotification(
        handler: (notification: {
            agentId: string;
            method: string;
            params: unknown;
        }) => void,
    ): Promise<() => void>;
    onAcpAgentRequest(
        handler: (request: {
            agentId: string;
            id: unknown;
            method: string;
            params: unknown;
        }) => void,
    ): Promise<() => void>;
    onExit(
        handler: (payload: { agentId: string }) => void,
    ): Promise<() => void>;
}

export type Handshake = {
    /** ACP v2 requires name and version; add human-facing fields such as title freely, per the protocol. */
    info: { name: string; version: string; [key: string]: unknown };
    capabilities?: Record<string, unknown>;
};

/** The agent went away (exited, was stopped, or was let go) before the request got a reply. */
export class AgentGoneError extends Error {
    readonly agentId: string;
    constructor(agentId: string, reason: string) {
        super(`${reason}: agent ${agentId}`);
        this.name = "AgentGoneError";
        this.agentId = agentId;
    }
}

/** The agent answered initialize with a protocol version this library cannot speak. Nothing after the handshake would be well-defined, so the agent is refused. */
export class ProtocolVersionError extends Error {
    readonly agentId: string;
    readonly protocolVersion: unknown;
    constructor(agentId: string, protocolVersion: unknown) {
        super(
            `agent ${agentId} answered initialize with protocolVersion ${JSON.stringify(protocolVersion)}; this client speaks ${PROTOCOL_VERSION} only`,
        );
        this.name = "ProtocolVersionError";
        this.agentId = agentId;
        this.protocolVersion = protocolVersion;
    }
}

/**
 * The ACP handshake. The protocol lets an agent answer with a lower version than the one requested; this library speaks version 2 only
 * (Zed refuses anything else the same way), so any other answer is a `ProtocolVersionError`. The Runtime answers a repeated initialize for a live
 * process from its cache, so the handshake is safe on takeover.
 */
export async function initialize(
    port: Pick<AgentPort<unknown>, "acpRequest">,
    agentId: string,
    handshake: Handshake,
): Promise<acp.InitializeResponse> {
    const response = await port.acpRequest<unknown>(agentId, "initialize", {
        protocolVersion: PROTOCOL_VERSION,
        info: handshake.info,
        capabilities: handshake.capabilities ?? {},
    });
    const protocolVersion = (response as { protocolVersion?: unknown } | null)
        ?.protocolVersion;
    if (protocolVersion !== PROTOCOL_VERSION)
        throw new ProtocolVersionError(agentId, protocolVersion);
    return response as acp.InitializeResponse;
}

/**
 * A live agent. Created by `Agents.start` / `Agents.attach`; never construct it directly.
 */
export class Agent {
    readonly agentId: string;
    /** The engine reported by the Runtime (on takeover) or supplied at start; the app interprets it. */
    readonly engine: string | null;
    /** Result of initialize: the agent's identity, capabilities, and login methods. */
    readonly initialized: acp.InitializeResponse;
    /** Resolves once the process is gone (exit event); detach does not count. */
    readonly exited: Promise<void>;

    private _alive = true;
    private readonly port: AgentPort<unknown>;
    /** Requests awaiting a reply, by the id we gave them, with the method (detach abandons all but a turn). */
    private readonly inflight = new Map<
        string,
        { method: string; fail: (error: Error) => void }
    >();
    private readonly notificationHandlers = new Set<
        (method: string, params: unknown) => void
    >();
    private readonly requestHandlers = new Set<
        (request: AgentRequest) => void
    >();
    private readonly idPrefix = `app-${Math.random().toString(36).slice(2, 8)}`;
    private nextId = 1;
    private readonly subscriptionScope = Scope.makeUnsafe();
    private listening: Promise<void> | null = null;
    private readonly resolveExited: () => void;
    private readonly goneListeners = new Set<() => void>();
    private readonly failureListeners = new Set<(error: Error) => void>();

    /** @internal */
    constructor(
        port: AgentPort<unknown>,
        agentId: string,
        engine: string | null,
        initialized: acp.InitializeResponse,
    ) {
        this.port = port;
        this.agentId = agentId;
        this.engine = engine;
        this.initialized = initialized;
        let resolve: () => void = () => {};
        this.exited = new Promise<void>((r) => {
            resolve = r;
        });
        this.resolveExited = resolve;
    }

    get alive(): boolean {
        return this._alive;
    }

    /** Number of requests still awaiting an agent reply. Check before stop / detach: above zero means a round of work is being cut off. */
    get inflightCount(): number {
        return this.inflight.size;
    }

    /**
     * The Runtime reported a fault for this agent (`_alwith/runtimeError` and the like): its replies will never arrive, so in-flight requests fail at once.
     * The agent itself is still held: the process has not exited; the exit event says whether it does.
     */
    fail(reason: string): void {
        this.failInflight(new AgentGoneError(this.agentId, reason));
    }

    /** Requests and receipt-completed turns both terminate when this connection becomes unavailable. */
    onFailure(listener: (error: Error) => void): () => void {
        this.failureListeners.add(listener);
        return () => this.failureListeners.delete(listener);
    }

    /** @internal Notified synchronously the moment the process is gone (in the same call stack as the exit event); `exited` is the Promise form. */
    onGone(listener: () => void): () => void {
        this.goneListeners.add(listener);
        return () => this.goneListeners.delete(listener);
    }

    /** @internal Attaches the three Runtime subscriptions; only once. */
    listen(): Promise<void> {
        if (this.listening) return this.listening;
        const self = this;
        this.listening = run(
            Effect.gen(function* () {
                const own = (acquire: () => Promise<() => void>) =>
                    Effect.acquireRelease(attempt(acquire), (release) =>
                        Effect.sync(release),
                    );
                // Subscribe to exit first so a process dying during later acquisition cannot be published alive.
                yield* own(() =>
                    self.port.onExit((exit) => {
                        if (exit.agentId === self.agentId)
                            self.gone("agent exited");
                    }),
                );
                yield* own(() =>
                    self.port.onAcpNotification((notification) => {
                        if (
                            !self._alive ||
                            notification.agentId !== self.agentId
                        )
                            return;
                        for (const handler of self.notificationHandlers)
                            handler(notification.method, notification.params);
                    }),
                );
                yield* own(() =>
                    self.port.onAcpAgentRequest((request) => {
                        if (!self._alive || request.agentId !== self.agentId)
                            return;
                        for (const handler of self.requestHandlers)
                            handler({
                                id: request.id,
                                method: request.method,
                                params: request.params,
                            });
                    }),
                );
                if (!self._alive)
                    return yield* Effect.fail(
                        new AgentGoneError(
                            self.agentId,
                            "agent retired during subscription",
                        ),
                    );
            }).pipe(
                Effect.provideService(Scope.Scope, this.subscriptionScope),
                Effect.onExit((exit) =>
                    Exit.isFailure(exit)
                        ? Scope.close(this.subscriptionScope, exit)
                        : Effect.void,
                ),
            ),
        );
        return this.listening;
    }

    private closeSubscriptions(): void {
        // Port subscriptions return synchronous disposers; teardown remains synchronous with the exit event.
        const exit = Effect.runSyncExit(
            Scope.close(this.subscriptionScope, Exit.void),
        );
        if (Exit.isFailure(exit)) throw failure(exit.cause);
    }

    /**
     * The SDK's request contract over the Runtime's paired transport.
     * Cancellation is cooperative: keep the request pending until its real reply or transport loss.
     * An already-aborted signal still sends the request before its cancellation notification.
     */
    request: acp.ClientContext["request"] = <T = unknown>(
        method: string,
        params?: unknown,
        options?: acp.SendRequestOptions,
    ): Promise<T> => {
        const signal = options?.cancellationSignal;
        if (!this._alive)
            return Promise.reject(
                new AgentGoneError(this.agentId, "agent is gone"),
            );
        const id = `${this.idPrefix}-${this.nextId++}`;
        return new Promise<T>((resolve, reject) => {
            let settled = false;
            let cancellationSent = false;
            const settle = () => {
                settled = true;
                this.inflight.delete(id);
                signal?.removeEventListener("abort", onAbort);
            };
            const fail = (error: Error) => {
                if (settled) return;
                settle();
                reject(error);
            };
            const onAbort = () => {
                if (settled || cancellationSent) return;
                cancellationSent = true;
                signal?.removeEventListener("abort", onAbort);
                void this.notify("$/cancel_request", { requestId: id }).catch(
                    (error: unknown) => {
                        fail(
                            error instanceof Error
                                ? error
                                : new Error(String(error)),
                        );
                    },
                );
            };
            signal?.addEventListener("abort", onAbort, { once: true });
            this.inflight.set(id, { method, fail });
            this.port.acpRequest<T>(this.agentId, method, params, { id }).then(
                (result) => {
                    if (settled) return;
                    settle();
                    resolve(result);
                },
                (error: unknown) =>
                    fail(
                        error instanceof Error
                            ? error
                            : new Error(String(error)),
                    ),
            );
            if (signal?.aborted) onAbort();
        });
    };

    notify: acp.ClientContext["notify"] = (
        method: string,
        params?: unknown,
    ): Promise<void> => {
        return this.port.acpNotify(this.agentId, method, params);
    };

    /** Answers a request sent by the agent, with the original id. */
    respond(
        id: unknown,
        result?: unknown,
        error?: { code: number; message: string },
    ): Promise<void> {
        return this.port.acpRespond(this.agentId, id, result, error);
    }

    onNotification(
        handler: (method: string, params: unknown) => void,
    ): () => void {
        this.notificationHandlers.add(handler);
        return () => this.notificationHandlers.delete(handler);
    }

    onAgentRequest(handler: (request: AgentRequest) => void): () => void {
        this.requestHandlers.add(handler);
        return () => this.requestHandlers.delete(handler);
    }

    /**
     * Stops the process and waits until it is really gone. The Runtime's stop only sends a termination signal; the exit event arrives after the session is unbound and the process cleaned up;
     * without waiting, the start after an engine switch would hit "still running". The process may have exited before we subscribed, in which case no exit event will come; confirm with
     * the Runtime's current process table.
     */
    async stop(): Promise<void> {
        if (!this._alive) return;
        const exited = this.exited;
        await this.port.stop(this.agentId);
        const agents = await this.port.agents();
        if (agents.some((agent) => agent.agentId === this.agentId))
            await exited;
        // A failed stop or failed confirmation is not evidence that the process exited.
        this.gone("agent stopped");
    }

    /**
     * Let go: drop subscriptions, fail in-flight requests locally, and leave the process in the Runtime for the next taker (cross-window handoff).
     * Letting go only ends this holder's waiting; it is not a cancellation on the wire. The agent's counterpart is the Runtime, and only the Runtime
     * knows whether a request still has a taker: on handoff it transfers the in-flight requests to the new holder, and when a holder is gone for good it
     * retracts the ones nobody will collect. A window cannot tell those two apart, so it never sends `$/cancel_request` on its own behalf here.
     */
    detach(): void {
        if (!this._alive) return;
        this._alive = false;
        this.closeSubscriptions();
        this.failInflight(new AgentGoneError(this.agentId, "agent detached"));
    }

    private gone(reason: string): void {
        const wasAlive = this._alive;
        this._alive = false;
        this.closeSubscriptions();
        this.failInflight(new AgentGoneError(this.agentId, reason));
        if (!wasAlive) return;
        this.resolveExited();
        for (const listener of [...this.goneListeners]) listener();
    }

    private failInflight(error: Error): void {
        for (const listener of this.failureListeners) listener(error);
        for (const { fail } of [...this.inflight.values()]) fail(error);
        this.inflight.clear();
    }
}

export type Attached<Info extends AttachInfo = AttachInfo> = {
    agent: Agent;
    info: Info;
};

/**
 * The agents this app holds. One per Runtime connection.
 */
export class Agents<Launch = unknown, Info extends AttachInfo = AttachInfo> {
    private readonly port: AgentPort<Launch, Info>;
    private readonly handshake: Handshake;
    private readonly held = new Map<string, Agent>();
    private readonly adopting = new Map<string, Promise<Agent>>();
    private readonly exitHandlers = new Set<(agent: Agent) => void>();

    constructor(port: AgentPort<Launch, Info>, handshake: Handshake) {
        this.port = port;
        this.handshake = handshake;
    }

    /** The one currently held; undefined if none (never started, exited, or let go). */
    get(agentId: string): Agent | undefined {
        return this.held.get(agentId);
    }

    /** A held agent process is gone, whether it crashed or was `stop`ped (letting go does not count). The app knows whether it stopped it itself. */
    onExit(handler: (agent: Agent) => void): () => void {
        this.exitHandlers.add(handler);
        return () => this.exitHandlers.delete(handler);
    }

    /**
     * Starts a new process. If the same agentId is still alive the Runtime rejects it outright; swapping the engine is `replace`.
     * The handshake happens here once; afterwards the Runtime answers repeated initialize from its cache. A process started here that cannot be
     * spoken to (handshake refused, wrong protocol version) is stopped again rather than left behind for someone else to find.
     */
    async start(
        agentId: string,
        launch: Launch,
        engine: string | null = null,
    ): Promise<Agent> {
        await this.port.start(agentId, launch);
        try {
            return await this.adopt(agentId, engine);
        } catch (error) {
            try {
                await this.port.stop(agentId);
            } catch (stopError) {
                throw new AggregateError(
                    [error, stopError],
                    `agent ${agentId}: the handshake failed and the process could not be stopped`,
                    { cause: stopError },
                );
            }
            throw error;
        }
    }

    /**
     * Takes over a session's live agent: if the Runtime has one, connect to it directly (process, context, and unanswered requests all still there); otherwise returns null.
     * `info.pendingAgentRequests` are requests the agent is still waiting on; hand them to the to-do ledger as if just received.
     */
    async attach(sessionId: string): Promise<Attached<Info> | null> {
        const info = await this.port.attachSession(sessionId);
        if (info === null) return null;
        const existing = this.held.get(info.agentId);
        if (existing?.alive) return { agent: existing, info };
        try {
            return { agent: await this.adopt(info.agentId, info.engine), info };
        } catch (error) {
            // Claimed but the handshake failed: release the claim so other windows are not locked out for good
            await this.port.releaseSession(sessionId).catch(() => undefined);
            throw error;
        }
    }

    /** Swap the engine: stop the old one, wait until it is really gone, then start the new one. */
    async replace(
        agentId: string,
        launch: Launch,
        engine: string | null = null,
    ): Promise<Agent> {
        await this.held.get(agentId)?.stop();
        return this.start(agentId, launch, engine);
    }

    /**
     * Holds a process the Runtime already runs that no session leads to (a fresh agent after a reload, before its first session): handshake, subscribe,
     * and take it into the held table. `start` and `attach` end here as well.
     */
    adopt(agentId: string, engine: string | null): Promise<Agent> {
        const existing = this.held.get(agentId);
        if (existing?.alive) return Promise.resolve(existing);
        const pending = this.adopting.get(agentId);
        if (pending) return pending;
        const result = this.acquireAgent(agentId, engine);
        this.adopting.set(agentId, result);
        const release = () => {
            if (this.adopting.get(agentId) === result)
                this.adopting.delete(agentId);
        };
        void result.then(release, release);
        return result;
    }

    private async acquireAgent(
        agentId: string,
        engine: string | null,
    ): Promise<Agent> {
        // ACP v2 handshakes once per connection; on takeover the Runtime answers with the cached handshake result, without disturbing the engine
        const initialized = await initialize(
            this.port,
            agentId,
            this.handshake,
        );
        const agent = new Agent(this.port, agentId, engine, initialized);
        await agent.listen();
        if (!agent.alive)
            throw new AgentGoneError(agentId, "agent exited during adoption");
        this.held.set(agentId, agent);
        // Synchronous: in the same call stack as the exit event, clear the held table and notify the app; reaping and crash notices must not lag by a microtask
        agent.onGone(() => {
            if (this.held.get(agentId) === agent) this.held.delete(agentId);
            for (const handler of this.exitHandlers) handler(agent);
        });
        return agent;
    }

    /** @internal Removes it from the held table after letting go. */
    release(agent: Agent): void {
        agent.detach();
        if (this.held.get(agent.agentId) === agent)
            this.held.delete(agent.agentId);
    }
}
