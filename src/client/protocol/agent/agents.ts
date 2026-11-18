// The agents this app holds: each is a process inside the Runtime, started here (start) or taken over (attachSession),
// handshaken once; we receive its notifications and requests, send it requests, until it exits or is let go.
//
// Things every WorkBuddy must do and that cause incidents when done wrong live here:
// - before spawning, ask the Runtime whether one is already alive (take over instead of starting another);
// - swapping the engine = stop -> wait for exit -> start (one process per agentId at a time; the Runtime rejects concurrent starts);
// - when the process exits / is stopped / is let go, requests still awaiting an answer fail immediately, so the caller's await never hangs;
// - stop must wait for the exit event, otherwise the engine-switch resume would reattach to the old process.
import * as acp from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {Effect, Exit, Scope} from "effect";

import {attempt, failure, run} from "../lifecycle/internal";
import {type AgentRequest, requestKey} from "./requests";

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
    agents(): Promise<Array<{agentId: string}>>;
    attachSession(sessionId: string): Promise<Info | null>;
    releaseSession(sessionId: string): Promise<void>;
    acpRequest<Result = unknown>(agentId: string, method: string, params?: unknown, options?: {id?: string | number}): Promise<Result>;
    acpNotify(agentId: string, method: string, params?: unknown): Promise<void>;
    acpRespond(agentId: string, id: unknown, result?: unknown, error?: unknown): Promise<void>;
    onAcpNotification(handler: (notification: {agentId: string; method: string; params: unknown}) => void): Promise<() => void>;
    onAcpAgentRequest(handler: (request: {agentId: string; id: unknown; method: string; params: unknown}) => void): Promise<() => void>;
    onExit(handler: (payload: {agentId: string}) => void): Promise<() => void>;
}

export type Handshake = {
    /** ACP v2 requires name and version; add human-facing fields such as title freely, per the protocol. */
    info: {name: string; version: string; [key: string]: unknown};
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

/** The SDK id of a request, as a map key: JSON-RPC ids are strings or numbers, and `9` and `"9"` differ. */
const idKey = (id: acp.JsonRpcId): string => JSON.stringify(id);

/**
 * A port failure as the JSON-RPC error the SDK settles the request with. A Runtime request error carries the agent's
 * own message as `reason`; its `message` is prefixed with the port method.
 */
function wireError(error: unknown): {code: number; message: string; data?: unknown} {
    const {code, message, reason, data} = error as {code?: unknown; message?: unknown; reason?: unknown; data?: unknown};
    return {
        code: typeof code === "number" ? code : -32603,
        message: typeof reason === "string" ? reason : typeof message === "string" ? message : String(error),
        ...(data === undefined ? {} : {data}),
    };
}

/**
 * A live agent. Created by `Agents.start` / `Agents.attach`; never construct it directly.
 *
 * Its ACP connection is the SDK's own client connection, carried over the Runtime port: the handshake, requests in
 * both directions, their cancellation and their answers all go through it, and `mcp/message` is served by the SDK's
 * MCP-over-ACP provider. The Runtime port is message-oriented, not a byte stream: one refused message does not end the
 * connection, so a failed request settles only that request.
 *
 * Notifications other than `$/cancel_request` reach the app straight from the port, in the order they arrive. The SDK
 * has nothing to do for them, and it dispatches each message asynchronously on its own promise chain, while the exit
 * event is handled synchronously: through the SDK, the last frames before a process exits would reach the app after it
 * learned the process is gone.
 */
export class Agent {
    readonly agentId: string;
    /** The engine reported by the Runtime (on takeover) or supplied at start; the app interprets it. */
    readonly engine: string | null;
    /** Resolves once the process is gone (exit event); detach does not count. */
    readonly exited: Promise<void>;

    private _alive = true;
    private _initialized: acp.InitializeResponse | null = null;
    private readonly port: AgentPort<unknown>;
    private readonly connection: acp.ClientConnection;
    private readonly mcp = new acp.McpOverAcpProvider();
    private inbound!: ReadableStreamDefaultController<acp.AnyMessage>;
    /** Our requests on the wire, by the id the Runtime books them under, with the SDK's id for the reply. */
    private readonly wire = new Map<string, acp.JsonRpcId>();
    /** The wire id of each SDK request id, so a cancellation names the request the Runtime knows. */
    private readonly wireIds = new Map<string, string>();
    /** Requests awaiting a reply, with the method (detach abandons all but a turn). */
    private readonly inflight = new Set<{method: string; fail: (error: Error) => void}>();
    /** Agent requests the app has yet to answer, by request key; `respond` settles them. */
    private readonly answering = new Map<string, {resolve: (result: unknown) => void; reject: (error: unknown) => void}>();
    private readonly notificationHandlers = new Set<(method: string, params: unknown) => void>();
    private readonly requestHandlers = new Set<(request: AgentRequest) => void>();
    private readonly idPrefix = `app-${Math.random().toString(36).slice(2, 8)}`;
    private nextId = 1;
    private readonly subscriptionScope = Scope.makeUnsafe();
    private listening: Promise<void> | null = null;
    private readonly resolveExited: () => void;
    private readonly goneListeners = new Set<() => void>();
    private readonly failureListeners = new Set<(error: Error) => void>();

    /** @internal */
    constructor(port: AgentPort<unknown>, agentId: string, engine: string | null) {
        this.port = port;
        this.agentId = agentId;
        this.engine = engine;
        let resolve: () => void = () => {};
        this.exited = new Promise<void>(r => {
            resolve = r;
        });
        this.resolveExited = resolve;
        this.connection = acp
            .client({name: agentId})
            .onRequest(acp.methods.client.mcp.message, this.mcp.handleRequest)
            .onRequest("*", context => this.answer(context))
            .connect({
                readable: new ReadableStream<acp.AnyMessage>({start: controller => void (this.inbound = controller)}),
                writable: new WritableStream<acp.AnyMessage>({write: message => this.send(message)}),
            });
        // Unanswered agent requests end with the connection: there is no one left to send their answers to.
        void this.connection.closed.then(() => this.answering.clear());
    }

    get alive(): boolean {
        return this._alive;
    }

    /** Result of initialize: the agent's identity, capabilities, and login methods. */
    get initialized(): acp.InitializeResponse {
        if (this._initialized === null) throw new Error(`agent ${this.agentId} has not answered initialize`);
        return this._initialized;
    }

    /** Number of requests still awaiting an agent reply. Check before stop / detach: above zero means a round of work is being cut off. */
    get inflightCount(): number {
        return this.inflight.size;
    }

    /**
     * Registers an MCP server the agent reaches over this connection (MCP-over-ACP). Declare it in a session request only
     * after this returns; it ends with this connection or when disposed.
     */
    registerMcpServer(options: acp.McpServerOptions): acp.McpServerRegistration {
        return this.mcp.registerServer(this.connection.agent, options);
    }

    /**
     * @internal The ACP handshake, through the SDK connection, which refuses any protocol version but 2 (an agent may
     * answer with a lower one). The Runtime answers a repeated initialize for a live process from its cache, so the
     * handshake is safe on takeover.
     */
    async initialize(handshake: Handshake): Promise<acp.InitializeResponse> {
        this._initialized = await this.request(acp.methods.agent.initialize, {
            protocolVersion: PROTOCOL_VERSION,
            info: handshake.info,
            capabilities: handshake.capabilities ?? {},
        });
        return this._initialized;
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
                    Effect.acquireRelease(attempt(acquire), release => Effect.sync(release));
                // Subscribe to exit first so a process dying during later acquisition cannot be published alive.
                yield* own(() =>
                    self.port.onExit(exit => {
                        if (exit.agentId === self.agentId) self.gone("agent exited");
                    }),
                );
                yield* own(() =>
                    self.port.onAcpNotification(notification => {
                        if (!self._alive || notification.agentId !== self.agentId) return;
                        if (notification.method === "$/cancel_request")
                            self.inbound.enqueue({jsonrpc: "2.0", method: notification.method, params: notification.params} as acp.AnyMessage);
                        else for (const handler of self.notificationHandlers) handler(notification.method, notification.params);
                    }),
                );
                yield* own(() =>
                    self.port.onAcpAgentRequest(request => {
                        if (!self._alive || request.agentId !== self.agentId) return;
                        self.receive([request]);
                    }),
                );
                if (!self._alive) return yield* Effect.fail(new AgentGoneError(self.agentId, "agent retired during subscription"));
            }).pipe(
                Effect.provideService(Scope.Scope, this.subscriptionScope),
                Effect.onExit(exit => (Exit.isFailure(exit) ? Scope.close(this.subscriptionScope, exit) : Effect.void)),
            ),
        );
        return this.listening;
    }

    /**
     * Agent requests that reach this connection other than as they are sent: the ones the Runtime hands over on takeover,
     * still waiting for an answer. They enter the connection as if just received.
     */
    receive(requests: readonly AgentRequest[]): void {
        for (const request of requests)
            this.inbound.enqueue({jsonrpc: "2.0", id: request.id, method: request.method, params: request.params} as acp.AnyMessage);
    }

    private closeSubscriptions(): void {
        // Port subscriptions return synchronous disposers; teardown remains synchronous with the exit event.
        const exit = Effect.runSyncExit(Scope.close(this.subscriptionScope, Exit.void));
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
        if (!this._alive) return Promise.reject(new AgentGoneError(this.agentId, "agent is gone"));
        return new Promise<T>((resolve, reject) => {
            const entry = {
                method,
                fail: (error: Error) => {
                    if (this.inflight.delete(entry)) reject(error);
                },
            };
            this.inflight.add(entry);
            const context = this.connection.agent as unknown as {
                request(method: string, params?: unknown, options?: acp.SendRequestOptions): Promise<T>;
            };
            context.request(method, params, options).then(
                result => {
                    if (this.inflight.delete(entry)) resolve(result);
                },
                (error: unknown) => entry.fail(error instanceof Error ? error : new Error(String(error))),
            );
        });
    };

    /** The port reports a failed notification to its sender; written to the SDK stream, it would end the whole connection. */
    notify: acp.ClientContext["notify"] = (method: string, params?: unknown): Promise<void> => {
        return this.port.acpNotify(this.agentId, method, params);
    };

    /** Answers a request sent by the agent, with the original id. */
    respond(id: unknown, result?: unknown, error?: {code: number; message: string; data?: unknown}): Promise<void> {
        const key = requestKey(id);
        const pending = this.answering.get(key);
        if (pending === undefined) throw new Error(`agent ${this.agentId} has no request ${key} awaiting an answer`);
        this.answering.delete(key);
        if (error) pending.reject(new acp.RequestError(error.code, error.message, error.data));
        else pending.resolve(result ?? null);
        return Promise.resolve();
    }

    onNotification(handler: (method: string, params: unknown) => void): () => void {
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
        if (agents.some(agent => agent.agentId === this.agentId)) await exited;
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
        this.close(new AgentGoneError(this.agentId, "agent detached"));
    }

    /** An agent request the app answers later through `respond`; the SDK writes the answer when it settles. */
    private answer(context: acp.ClientRequestContext<unknown>): Promise<unknown> {
        const request: AgentRequest = {id: context.requestId, method: context.method, params: context.params};
        const answered = new Promise<unknown>((resolve, reject) => this.answering.set(requestKey(request.id), {resolve, reject}));
        for (const handler of this.requestHandlers) handler(request);
        // The agent withdrew it (`$/cancel_request`), possibly before the SDK dispatched it: the SDK aborts the handler,
        // and the ledger learns it as the notification it was.
        const withdrawn = () => {
            if (!this._alive || !this.answering.has(requestKey(request.id))) return;
            for (const handler of this.notificationHandlers) handler("$/cancel_request", {requestId: request.id});
        };
        if (context.signal.aborted) withdrawn();
        else context.signal.addEventListener("abort", withdrawn, {once: true});
        return answered;
    }

    /** One message the SDK writes, carried by the Runtime port. Never rejects: a rejected write would end the SDK connection. */
    private send(message: acp.AnyMessage): void {
        if ("method" in message && "id" in message) {
            const sdkId = message.id as acp.JsonRpcId;
            const id = `${this.idPrefix}-${this.nextId++}`;
            this.wire.set(id, sdkId);
            this.wireIds.set(idKey(sdkId), id);
            this.port.acpRequest(this.agentId, message.method, message.params, {id}).then(
                result => this.settle(id, {result}),
                (error: unknown) => this.settle(id, {error: wireError(error)}),
            );
            return;
        }
        if ("method" in message) {
            if (message.method !== "$/cancel_request") throw new Error(`SDK notification ${message.method} bypassed Agent.notify`);
            const sdkId = (message.params as {requestId: acp.JsonRpcId}).requestId;
            const id = this.wireIds.get(idKey(sdkId));
            // Settled before the cancellation was written: nothing is left to cancel.
            if (id === undefined) return;
            this.port.acpNotify(this.agentId, "$/cancel_request", {requestId: id}).catch((error: unknown) =>
                this.settle(id, {error: wireError(error)}),
            );
            return;
        }
        const {id, result, error} = message as {id: unknown; result?: unknown; error?: unknown};
        void this.port.acpRespond(this.agentId, id, result, error);
    }

    /** Hands the Runtime's reply to a request back to the SDK, once; replies to requests already failed here are dropped. */
    private settle(id: string, outcome: {result: unknown} | {error: {code: number; message: string; data?: unknown}}): void {
        const sdkId = this.wire.get(id);
        if (sdkId === undefined) return;
        this.wire.delete(id);
        this.wireIds.delete(idKey(sdkId));
        if (!this.connection.signal.aborted) this.inbound.enqueue({jsonrpc: "2.0", id: sdkId, ...outcome} as acp.AnyMessage);
    }

    private gone(reason: string): void {
        const wasAlive = this._alive;
        this._alive = false;
        this.closeSubscriptions();
        this.close(new AgentGoneError(this.agentId, reason));
        if (!wasAlive) return;
        this.resolveExited();
        for (const listener of [...this.goneListeners]) listener();
    }

    /** Ends the SDK connection: in-flight requests fail with `error`, and unanswered agent requests have no one left to answer them. */
    private close(error: AgentGoneError): void {
        this.failInflight(error);
        this.answering.clear();
        this.connection.close(error);
    }

    private failInflight(error: Error): void {
        for (const listener of this.failureListeners) listener(error);
        for (const {fail} of [...this.inflight]) fail(error);
        // Their replies, if they ever arrive, belong to requests that already failed.
        for (const id of [...this.wire.keys()]) this.settle(id, {error: {code: -32603, message: error.message}});
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
    async start(agentId: string, launch: Launch, engine: string | null = null): Promise<Agent> {
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
                    {cause: stopError},
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
        if (existing?.alive) return {agent: existing, info};
        try {
            return {agent: await this.adopt(info.agentId, info.engine), info};
        } catch (error) {
            // Claimed but the handshake failed: release the claim so other windows are not locked out for good
            await this.port.releaseSession(sessionId).catch((released: unknown) => {
                throw new AggregateError([error, released], `Session ${sessionId} could be neither adopted nor released`);
            });
            throw error;
        }
    }

    /** Swap the engine: stop the old one, wait until it is really gone, then start the new one. */
    async replace(agentId: string, launch: Launch, engine: string | null = null): Promise<Agent> {
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
            if (this.adopting.get(agentId) === result) this.adopting.delete(agentId);
        };
        void result.then(release, release);
        return result;
    }

    private async acquireAgent(agentId: string, engine: string | null): Promise<Agent> {
        const agent = new Agent(this.port, agentId, engine);
        // ACP v2 handshakes once per connection; on takeover the Runtime answers with the cached handshake result, without disturbing the engine
        try {
            await agent.initialize(this.handshake);
        } catch (error) {
            // Nobody will hold an agent that cannot be spoken to; its connection ends here.
            agent.detach();
            throw error;
        }
        await agent.listen();
        if (!agent.alive) throw new AgentGoneError(agentId, "agent exited during adoption");
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
        if (this.held.get(agent.agentId) === agent) this.held.delete(agent.agentId);
    }
}
