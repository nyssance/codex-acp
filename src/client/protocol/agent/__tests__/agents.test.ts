import { describe, expect, test } from "bun:test";

import type {
    RuntimeAcpAgentRequest,
    RuntimeAcpNotification,
    RuntimeAgentInfo,
    RuntimeAttachInfo,
    RuntimeClient,
    RuntimeExitPayload,
} from "@alwith/api";
import { AgentGoneError, Agents, ProtocolVersionError } from "../agents";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Only what Agents touches: start/stop, attach, handshake, the three ACP verbs, the three subscriptions. Nothing else is implemented. */
class FakeRuntime implements Partial<RuntimeClient<{ engine: string }>> {
    readonly calls: string[] = [];
    running = new Set<string>();
    attachable = new Map<string, RuntimeAttachInfo>();
    /** Request → reply, scripted per method; by default echoes params back. */
    answer: (method: string, params: unknown) => unknown = (_method, params) =>
        params;
    /** What initialize answers; the real protocol lets an agent answer a lower version than asked. */
    protocolVersion: unknown = 2;
    private readonly notificationHandlers = new Set<
        (n: RuntimeAcpNotification) => void
    >();
    private readonly requestHandlers = new Set<
        (r: RuntimeAcpAgentRequest) => void
    >();
    private readonly exitHandlers = new Set<(e: RuntimeExitPayload) => void>();
    readonly responded: Array<{
        agentId: string;
        id: unknown;
        result?: unknown;
        error?: unknown;
    }> = [];
    readonly notified: Array<{
        agentId: string;
        method: string;
        params: unknown;
    }> = [];
    /** Requests left pending; the test decides when to answer them. */
    hang = new Set<string>();
    private readonly hung: Array<{ resolve: (v: unknown) => void }> = [];

    start(agentId: string): Promise<void> {
        this.calls.push(`start ${agentId}`);
        if (this.running.has(agentId))
            return Promise.reject(
                new Error(`agent ${agentId} is still running`),
            );
        this.running.add(agentId);

        return Promise.resolve();
    }
    stop(agentId: string): Promise<void> {
        this.calls.push(`stop ${agentId}`);
        this.running.delete(agentId);
        // The Runtime's exit event only arrives after cleanup
        queueMicrotask(() => this.exit(agentId));

        return Promise.resolve();
    }
    exit(agentId: string): void {
        this.running.delete(agentId);
        for (const handler of this.exitHandlers) handler({ agentId });
    }
    agents(): Promise<RuntimeAgentInfo[]> {
        return Promise.resolve(
            [...this.running].map((agentId) => ({
                agentId,
                pid: 1,
                provider: "",
                model: "",
                connection: "",
                cpu: 0,
                memMb: 0,
                uptimeSecs: 0,
            })),
        );
    }
    attachSession(sessionId: string): Promise<RuntimeAttachInfo | null> {
        this.calls.push(`attach ${sessionId}`);
        return Promise.resolve(this.attachable.get(sessionId) ?? null);
    }
    releaseSession(sessionId: string): Promise<void> {
        this.calls.push(`release ${sessionId}`);

        return Promise.resolve();
    }
    acpRequest<T>(
        agentId: string,
        method: string,
        params?: unknown,
    ): Promise<T> {
        if (method === "initialize") {
            this.calls.push(
                `initialize ${agentId} ${(params as { info: { name: string } }).info.name}`,
            );
            return Promise.resolve({
                protocolVersion: this.protocolVersion,
                info: { name: "fake-agent", version: "1" },
            } as T);
        }
        this.calls.push(`request ${agentId} ${method}`);
        if (this.hang.has(method))
            return new Promise<T>((resolve) =>
                this.hung.push({ resolve: resolve as (v: unknown) => void }),
            );
        return Promise.resolve(this.answer(method, params) as T);
    }
    acpNotify(
        agentId: string,
        method: string,
        params?: unknown,
    ): Promise<void> {
        this.notified.push({ agentId, method, params });

        return Promise.resolve();
    }
    acpRespond(
        agentId: string,
        id: unknown,
        result?: unknown,
        error?: unknown,
    ): Promise<void> {
        this.responded.push({ agentId, id, result, error });

        return Promise.resolve();
    }
    onAcpNotification(
        handler: (n: RuntimeAcpNotification) => void,
    ): Promise<() => void> {
        this.notificationHandlers.add(handler);
        return Promise.resolve(() => this.notificationHandlers.delete(handler));
    }
    onAcpAgentRequest(
        handler: (r: RuntimeAcpAgentRequest) => void,
    ): Promise<() => void> {
        this.requestHandlers.add(handler);
        return Promise.resolve(() => this.requestHandlers.delete(handler));
    }
    onExit(handler: (e: RuntimeExitPayload) => void): Promise<() => void> {
        this.exitHandlers.add(handler);
        return Promise.resolve(() => this.exitHandlers.delete(handler));
    }
    emitNotification(agentId: string, method: string, params: unknown): void {
        for (const handler of this.notificationHandlers)
            handler({ agentId, method, params });
    }
    emitRequest(
        agentId: string,
        id: unknown,
        method: string,
        params: unknown,
    ): void {
        for (const handler of this.requestHandlers)
            handler({ agentId, id, method, params });
    }
    answerHung(value: unknown): void {
        this.hung.shift()?.resolve(value);
    }
    get listeners(): number {
        return (
            this.notificationHandlers.size +
            this.requestHandlers.size +
            this.exitHandlers.size
        );
    }
}

const handshake = { info: { name: "test-app", version: "0" } };

function make() {
    const runtime = new FakeRuntime();
    const agents = new Agents<{ engine: string }, RuntimeAttachInfo>(
        runtime,
        handshake,
    );
    return { runtime, agents };
}

describe("start and attach", () => {
    test("start: spawns the process, handshakes once, receives only its own agent's notifications and requests", async () => {
        const { runtime, agents } = make();
        const agent = await agents.start("a1", { engine: "alwith" }, "alwith");
        expect(runtime.calls).toEqual(["start a1", "initialize a1 test-app"]);
        expect(agent.initialized).toMatchObject({
            info: { name: "fake-agent" },
        });
        const seen: string[] = [];
        agent.onNotification((method) => seen.push(method));
        agent.onAgentRequest((request) => seen.push(`req ${request.method}`));
        runtime.emitNotification("a1", "session/update", {});
        runtime.emitNotification("other", "session/update", {});
        runtime.emitRequest("a1", 1, "session/request_permission", {});
        expect(seen).toEqual([
            "session/update",
            "req session/request_permission",
        ]);
    });

    test("start while the same agentId is alive is refused by the Runtime; replace stops, waits for exit, then starts", async () => {
        const { runtime, agents } = make();
        const first = await agents.start("a1", { engine: "alwith" });
        await expect(agents.start("a1", { engine: "dsh" })).rejects.toThrow(
            "still running",
        );
        const second = await agents.replace("a1", { engine: "dsh" }, "dsh");
        expect(first.alive).toBe(false);
        expect(second.alive).toBe(true);
        expect(second.engine).toBe("dsh");
        // The refused start also reached the Runtime (which refused it), so two starts are recorded before the stop
        expect(
            runtime.calls.filter((c) => !c.startsWith("initialize")),
        ).toEqual(["start a1", "start a1", "stop a1", "start a1"]);
    });

    test("attach: takes over a live agent in the Runtime, uses the cached handshake and hands back unanswered requests; null when there is none", async () => {
        const { runtime, agents } = make();
        const pending = [
            { id: 7, method: "session/request_permission", params: {} },
        ];
        runtime.attachable.set("s1", {
            agentId: "live",
            engine: "alwith",
            provider: "anthropic",
            providerRevision: 0,
            pendingAgentRequests: pending,
        });
        runtime.running.add("live");
        const attached = await agents.attach("s1");
        expect(attached?.agent.agentId).toBe("live");
        expect(attached?.agent.engine).toBe("alwith");
        expect(attached?.info.providerRevision).toBe(0);
        expect(attached?.info.pendingAgentRequests).toBe(pending);
        expect(agents.get("live")).toBe(attached?.agent);
        expect(await agents.attach("nobody")).toBeNull();
    });

    test("attaching to an agent already held does not handshake again", async () => {
        const { runtime, agents } = make();
        runtime.attachable.set("s1", {
            agentId: "live",
            engine: "alwith",
            provider: "",
            providerRevision: null,
            pendingAgentRequests: [],
        });
        runtime.attachable.set("s2", {
            agentId: "live",
            engine: "alwith",
            provider: "",
            providerRevision: null,
            pendingAgentRequests: [],
        });
        const one = await agents.attach("s1");
        const two = await agents.attach("s2");
        expect(two?.agent).toBe(one?.agent);
        expect(
            runtime.calls.filter((c) => c.startsWith("initialize")),
        ).toHaveLength(1);
    });
});

describe("requests", () => {
    test("in-flight requests fail immediately when the agent exits instead of hanging; its events are no longer received", async () => {
        const { runtime, agents } = make();
        const agent = await agents.start("a1", { engine: "alwith" });
        runtime.hang.add("session/prompt");
        const turn = agent.request("session/prompt", {
            sessionId: "s",
            prompt: [],
        });
        const exits: string[] = [];
        agents.onExit((a) => exits.push(a.agentId));
        runtime.exit("a1");
        await expect(turn).rejects.toBeInstanceOf(AgentGoneError);
        await flush();
        expect(exits).toEqual(["a1"]);
        expect(agent.alive).toBe(false);
        expect(agents.get("a1")).toBeUndefined();
        expect(runtime.listeners).toBe(0);
    });

    test("stop completes only on exit; a stopped agent is not a crash", async () => {
        const { runtime, agents } = make();
        const agent = await agents.start("a1", { engine: "alwith" });
        const exits: string[] = [];
        agents.onExit((a) => exits.push(a.agentId));
        await agent.stop();
        expect(agent.alive).toBe(false);
        expect(runtime.running.has("a1")).toBe(false);
        await flush();
        // A self-initiated stop still means the process is gone: exited resolves, the agent leaves the held table and onExit fires; the app knows whether it asked for it
        expect(agents.get("a1")).toBeUndefined();
        expect(exits).toEqual(["a1"]);
    });

    test("detach: lets go without stopping the process; in-flight requests fail and the process stays in the Runtime", async () => {
        const { runtime, agents } = make();
        const agent = await agents.start("a1", { engine: "alwith" });
        runtime.hang.add("session/prompt");
        const turn = agent.request("session/prompt", {
            sessionId: "s",
            prompt: [],
        });
        agents.release(agent);
        await expect(turn).rejects.toBeInstanceOf(AgentGoneError);
        expect(runtime.running.has("a1")).toBe(true);
        expect(runtime.calls).not.toContain("stop a1");
        expect(agents.get("a1")).toBeUndefined();
    });

    test("cancellationSignal preserves the peer response and pending request", async () => {
        const { runtime, agents } = make();
        const agent = await agents.start("a1", { engine: "alwith" });
        runtime.hang.add("_alwith/login");
        const controller = new AbortController();
        const login = agent.request(
            "_alwith/login",
            {},
            { cancellationSignal: controller.signal },
        );
        controller.abort();
        await flush();
        expect(agent.inflightCount).toBe(1);
        expect(runtime.notified).toEqual([
            {
                agentId: "a1",
                method: "$/cancel_request",
                params: {
                    requestId: expect.stringMatching(/^app-/) as unknown,
                },
            },
        ]);
        runtime.answerHung({ ok: true });
        await expect(login).resolves.toEqual({ ok: true });
        expect(agent.inflightCount).toBe(0);
    });

    test("a pre-aborted signal sends the request and one cancellation, then preserves its reply", async () => {
        const { runtime, agents } = make();
        const agent = await agents.start("a1", { engine: "alwith" });
        runtime.hang.add("_test/cancel");
        const controller = new AbortController();
        controller.abort();
        const response = agent.request(
            "_test/cancel",
            {},
            { cancellationSignal: controller.signal },
        );
        expect(runtime.calls).toContain("request a1 _test/cancel");
        expect(runtime.notified).toHaveLength(1);
        expect(agent.inflightCount).toBe(1);
        runtime.answerHung({ completed: true });
        await expect(response).resolves.toEqual({ completed: true });
    });

    test("abort after response does not send a cancellation", async () => {
        const { runtime, agents } = make();
        const agent = await agents.start("a1", { engine: "alwith" });
        const controller = new AbortController();
        await agent.request(
            "_test/echo",
            {},
            { cancellationSignal: controller.signal },
        );
        controller.abort();
        expect(runtime.notified).toEqual([]);
        expect(agent.inflightCount).toBe(0);
    });

    test("transport loss settles a cooperatively cancelled request", async () => {
        const { runtime, agents } = make();
        const agent = await agents.start("a1", { engine: "alwith" });
        runtime.hang.add("_test/cancel");
        const controller = new AbortController();
        const response = agent.request(
            "_test/cancel",
            {},
            { cancellationSignal: controller.signal },
        );
        controller.abort();
        runtime.exit("a1");
        await expect(response).rejects.toBeInstanceOf(AgentGoneError);
        expect(agent.inflightCount).toBe(0);
        runtime.answerHung({ late: true });
        await flush();
    });

    test("respond answers the agent with the original id", async () => {
        const { runtime, agents } = make();
        const agent = await agents.start("a1", { engine: "alwith" });
        await agent.respond(9, { outcome: { outcome: "cancelled" } });
        expect(runtime.responded).toEqual([
            {
                agentId: "a1",
                id: 9,
                result: { outcome: { outcome: "cancelled" } },
                error: undefined,
            },
        ]);
    });
});

describe("Runtime failure", () => {
    test("fail: in-flight requests fail at once, the agent is still held and can send again", async () => {
        const { runtime, agents } = make();
        const agent = await agents.start("a1", { engine: "alwith" });
        runtime.hang.add("session/prompt");
        const turn = agent.request("session/prompt", {
            sessionId: "s",
            prompt: [],
        });
        expect(agent.inflightCount).toBe(1);
        agent.fail("disk full");
        await expect(turn).rejects.toThrow("disk full");
        expect(agent.alive).toBe(true);
        expect(agent.inflightCount).toBe(0);
        runtime.hang.delete("session/prompt");
        await expect(agent.request("_test/echo", { ok: 1 })).resolves.toEqual({
            ok: 1,
        });
    });
});

describe("handshake", () => {
    test("an agent answering initialize with any protocol version but 2 is refused; a process started here is stopped again", async () => {
        const { runtime, agents } = make();
        runtime.protocolVersion = 1;
        await expect(
            agents.start("a1", { engine: "alwith" }),
        ).rejects.toBeInstanceOf(ProtocolVersionError);
        await flush();
        expect(runtime.calls).toEqual([
            "start a1",
            "initialize a1 test-app",
            "stop a1",
        ]);
        expect(agents.get("a1")).toBeUndefined();
        runtime.running.add("a2");
        runtime.attachable.set("s2", {
            agentId: "a2",
            engine: "alwith",
            pendingAgentRequests: [],
        } as never);
        runtime.protocolVersion = "2";
        await expect(agents.attach("s2")).rejects.toBeInstanceOf(
            ProtocolVersionError,
        );
        // Attached but refused: the claim is given back; the process is someone else's to stop
        expect(runtime.calls.slice(-3)).toEqual([
            "attach s2",
            "initialize a2 test-app",
            "release s2",
        ]);
    });

    test("adopt: holds a running process that no session leads to, handshaking once; a second adopt is the same agent", async () => {
        const { runtime, agents } = make();
        runtime.running.add("a1");
        const agent = await agents.adopt("a1", "alwith");
        expect(runtime.calls).toEqual(["initialize a1 test-app"]);
        expect(agent.engine).toBe("alwith");
        expect(await agents.adopt("a1", "alwith")).toBe(agent);
        expect(runtime.calls).toEqual(["initialize a1 test-app"]);
        expect(agents.get("a1")).toBe(agent);
    });
});

describe("abandoned requests", () => {
    test("detach only ends this holder's waiting: nothing is cancelled on the wire, the Runtime decides whether the next holder collects or the request is retracted", async () => {
        const { runtime, agents } = make();
        const agent = await agents.start("a1", { engine: "alwith" });
        runtime.hang.add("session/list");
        runtime.hang.add("session/prompt");
        const list = agent.request("session/list", {});
        const prompt = agent.request("session/prompt", {
            sessionId: "s",
            prompt: [],
        });
        agent.detach();
        await expect(list).rejects.toBeInstanceOf(AgentGoneError);
        await expect(prompt).rejects.toBeInstanceOf(AgentGoneError);
        expect(runtime.notified).toEqual([]);
        expect(runtime.running.has("a1")).toBe(true);
    });

    test("every request carries its own id, so the Runtime can book it under this holder and a cancellation has something to name", async () => {
        const { runtime, agents } = make();
        const agent = await agents.start("a1", { engine: "alwith" });
        const seen: unknown[] = [];
        runtime.acpRequest = ((
            _agentId: string,
            _method: string,
            _params?: unknown,
            options?: { id?: unknown },
        ) => {
            seen.push(options?.id);
            return Promise.resolve({});
        }) as typeof runtime.acpRequest;
        await agent.request("session/list", {});
        await agent.request("session/list", {});
        expect(seen.map((id) => typeof id)).toEqual(["string", "string"]);
        expect(seen[0]).not.toBe(seen[1]);
    });
});

describe("binding acquisition ownership", () => {
    test("concurrent adoption handshakes and subscribes only once", async () => {
        const runtime = new FakeRuntime();
        const agents = new Agents(runtime, {
            info: { name: "test-app", version: "1" },
        });
        const first = agents.adopt("shared", "alwith");
        const second = agents.adopt("shared", "alwith");
        expect(second).toBe(first);
        const agent = await first;
        expect(
            runtime.calls.filter((call) => call.startsWith("initialize")),
        ).toHaveLength(1);
        expect(runtime.listeners).toBe(3);
        agents.release(agent);
        expect(runtime.listeners).toBe(0);
    });

    test("a failed subscription releases every previously acquired subscription", async () => {
        const runtime = new FakeRuntime();
        const error = new Error("request subscription failed");
        runtime.onAcpAgentRequest = () => Promise.reject(error);
        const agents = new Agents(runtime, {
            info: { name: "test-app", version: "1" },
        });
        await expect(agents.adopt("shared", "alwith")).rejects.toBe(error);
        expect(runtime.listeners).toBe(0);
        expect(agents.get("shared")).toBeUndefined();
    });

    test("exit during subscription acquisition releases the late subscription", async () => {
        const runtime = new FakeRuntime();
        const subscribe = runtime.onAcpNotification.bind(runtime);
        let complete!: () => void;
        let acquired!: () => void;
        const ready = new Promise<void>((resolve) => {
            acquired = resolve;
        });
        runtime.onAcpNotification = async (handler) => {
            const unsubscribe = await subscribe(handler);
            return new Promise<() => void>((resolve) => {
                complete = () => resolve(unsubscribe);
                acquired();
            });
        };
        const agents = new Agents(runtime, {
            info: { name: "test-app", version: "1" },
        });
        const adopting = agents.adopt("shared", "alwith");
        const result = adopting.then(
            () => "unexpected success",
            () => "rejected",
        );
        await ready;
        runtime.exit("shared");
        complete();
        expect(await result).toBe("rejected");
        expect(runtime.listeners).toBe(0);
        expect(agents.get("shared")).toBeUndefined();
    });
});

test("a rejected stop preserves the live binding and its subscriptions", async () => {
    const runtime = new FakeRuntime();
    const agents = new Agents(runtime, {
        info: { name: "test-app", version: "1" },
    });
    const agent = await agents.start("a1", { engine: "alwith" });
    const error = new Error("stop rejected");
    runtime.stop = () => Promise.reject(error);
    await expect(agent.stop()).rejects.toBe(error);
    expect(agent.alive).toBe(true);
    expect(agents.get("a1")).toBe(agent);
    expect(runtime.listeners).toBe(3);
    agents.release(agent);
});
