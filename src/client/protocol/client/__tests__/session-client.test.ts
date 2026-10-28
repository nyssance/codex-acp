import { afterEach, expect, test } from "bun:test";

import { type ClientOptions, SessionClient } from "../session-client";
import { createFakeAgent } from "./fake-agent";
import { FakeHubPort } from "./fake-runtime-client";

const clients: SessionClient[] = [];
afterEach(() => {
    for (const client of clients.splice(0)) client.disconnect();
});

async function until(predicate: () => boolean, ms = 3000): Promise<void> {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > ms) throw new Error("Timed out");
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

async function make(
    configure?: (fake: ReturnType<typeof createFakeAgent>) => void,
    options: Partial<ClientOptions> = {},
) {
    const fake = createFakeAgent();
    configure?.(fake);
    const port = new FakeHubPort(() => fake.app);
    const client = new SessionClient(() => Promise.resolve(port), {
        agentId: "agent",
        launch: { engine: "fake" },
        ...options,
    });
    clients.push(client);
    await client.connect();
    return { client, fake, port };
}

function replyText(client: SessionClient, id: string): string {
    const reply = client
        .session(id)
        .items.find((item) => item.kind === "assistant");
    const block = reply?.kind === "assistant" ? reply.content[0] : undefined;
    const text = (block as { text?: unknown } | undefined)?.text;
    return typeof text === "string" ? text : "";
}

test("a fresh Runtime starts the agent and the client talks ACP through it", async () => {
    const { client, port } = await make();
    expect(port.started).toEqual(["agent"]);
    expect(client.state.agent?.info.name).toBe("fake-agent");
    const id = await client.newSession("/tmp/a");
    await client.prompt(id, [{ type: "text", text: "hello" }]);
    await until(() => client.session(id).state === "idle");
    expect(replyText(client, id)).toBe(`reply:${id}`);
});

test("a Runtime that already runs the agent is attached, not restarted, and pending permissions replay", async () => {
    const port = new FakeHubPort(() => createFakeAgent().app);
    // Boot once so the fake Runtime has a live agent, exactly as after a webview reload.
    await port.start("agent", { engine: "fake" });
    const permission = {
        id: 41,
        method: "session/request_permission",
        params: {
            sessionId: "s-old",
            title: "Run command?",
            options: [
                {
                    optionId: "allow_once",
                    name: "Allow once",
                    kind: "allow_once",
                },
            ],
        },
    };
    port.seedRunningSession("s-old", "agent", [permission]);
    // Another app's agent on the same Runtime: never attached (attach claims it; releasing it
    // afterwards would leave it ownerless).
    port.seedRunningSession("s-theirs", "desktop-chat1", []);
    const client = new SessionClient(() => Promise.resolve(port), {
        agentId: "agent",
        launch: { engine: "fake" },
    });
    clients.push(client);
    await client.connect();
    expect(port.started).toEqual(["agent"]);
    expect(port.attached).toEqual(["s-old"]);
    expect(client.state.connection).toBe("ready");
    await until(() => client.state.actions.length === 1);
    expect(client.state.actions[0]).toMatchObject({
        kind: "permission",
        sessionId: "s-old",
    });
});

test("a reload reuses a running agent that has no sessions", async () => {
    const port = new FakeHubPort(() => createFakeAgent().app);
    await port.start("agent", { engine: "fake" });
    const client = new SessionClient(() => Promise.resolve(port), {
        agentId: "agent",
        launch: { engine: "fake" },
    });
    clients.push(client);
    await client.connect();
    expect(port.started).toEqual(["agent"]);
    expect(client.state.connection).toBe("ready");
    expect(client.state.agent?.info.name).toBe("fake-agent");
});

test("the user's message is on screen before the agent reports it; the receipt claims it, the echo adopts it", async () => {
    const { client } = await make();
    const id = await client.newSession("/tmp/a");
    const sending = client.prompt(id, [
        { type: "text", text: "shown at once" },
    ]);
    const local = client.session(id).items.find((item) => item.kind === "user");
    expect(local?.kind === "user" ? local.echo : null).toBe("pending");
    expect(await sending).toBe("u");
    const claimed = client
        .session(id)
        .items.find((item) => item.kind === "user");
    expect(claimed?.id).toBe("u");
    await until(() => client.session(id).state === "idle");
    const users = client
        .session(id)
        .items.filter((item) => item.kind === "user");
    expect(users).toHaveLength(1);
    expect(users[0]?.kind === "user" ? users[0].echo : null).toBe("adopted");
});

test("a refused prompt takes the local copy off screen again", async () => {
    const { client } = await make((fake) => {
        fake.rejectPrompt.current = (text) =>
            text === "refuse" ? new Error("not now") : null;
    });
    const id = await client.newSession("/tmp/a");
    await expect(
        client.prompt(id, [{ type: "text", text: "refuse" }]),
    ).rejects.toThrow("not now");
    expect(client.session(id).items).toHaveLength(0);
    await client.prompt(id, [{ type: "text", text: "fine" }]);
    expect(
        client.session(id).items.filter((item) => item.kind === "user"),
    ).toHaveLength(1);
});

test("prompt acknowledgement is not completion; cancelling one session leaves the other running", async () => {
    const { client } = await make();
    const [a, b] = await Promise.all([
        client.newSession("/tmp/a"),
        client.newSession("/tmp/b"),
    ]);
    await Promise.all([
        client.prompt(a, [{ type: "text", text: "one" }]),
        client.prompt(b, [{ type: "text", text: "two" }]),
    ]);
    expect(client.session(a).state).toBe("running");
    expect(client.session(b).state).toBe("running");
    await client.cancel(a);
    await until(
        () =>
            client.session(a).state === "idle" &&
            client.session(b).state === "idle",
    );
    expect(
        client.session(a).items.some((item) => item.kind === "assistant"),
    ).toBe(false);
    expect(replyText(client, b)).toBe(`reply:${b}`);
    expect(client.state.sessions[b]).toBe(client.session(b));
});

test("permission requests surface as actions and resolve back to the agent", async () => {
    const { client } = await make();
    const id = await client.newSession("/tmp/a");
    await client.prompt(id, [{ type: "text", text: "permission" }]);
    await until(() => client.state.actions.length === 1);
    const action = client.state.actions[0]!;
    expect(action.kind).toBe("permission");
    expect(client.session(id).state).toBe("requires_action");
    expect(() =>
        client.respond(action.id, {
            outcome: { outcome: "selected", optionId: "nope" },
        }),
    ).toThrow();
    client.respond(action.id, {
        outcome: { outcome: "selected", optionId: "allow_once" },
    });
    await until(() => client.session(id).state === "idle");
    expect(client.state.actions).toHaveLength(0);
    expect(replyText(client, id)).toContain("allow_once");
});

test("Stop answers the session's pending permission with cancelled before session/cancel", async () => {
    const { client } = await make();
    const id = await client.newSession("/tmp/a");
    await client.prompt(id, [{ type: "text", text: "permission" }]);
    await until(() => client.state.actions.length === 1);
    await client.cancel(id);
    expect(client.state.actions).toEqual([]);
    await until(() => client.session(id).state === "idle");
    expect(replyText(client, id)).toContain("cancelled");
});

test("stopping a session retains what is on screen, cancels its permission and keeps the shared agent", async () => {
    const { client, port } = await make();
    const a = await client.newSession("/tmp/a");
    const b = await client.newSession("/tmp/b");
    await Promise.all([
        client.prompt(a, [{ type: "text", text: "permission" }]),
        client.prompt(b, [{ type: "text", text: "permission" }]),
    ]);
    await until(() => client.state.actions.length === 2);
    const items = client.session(a).items;
    await client.stopSession(a);
    expect(client.state.sessions[a]).toMatchObject({
        attached: false,
        restoring: false,
        state: "idle",
    });
    expect(client.session(a).items).toEqual(expect.arrayContaining(items));
    expect(client.state.actions.map((action) => action.sessionId)).toEqual([b]);
    expect(client.session(b).state).toBe("requires_action");
    expect((await port.agents()).map((agent) => agent.agentId)).toEqual([
        "agent",
    ]);
    expect(client.state.connection).toBe("ready");
    await client.open(a, "/tmp/a");
    expect(client.session(a).attached).toBe(true);
    await client.close(b);
    expect(client.state.sessions[b]).toBeUndefined();
});

test("terminal output is decoded across chunk boundaries", async () => {
    const { client } = await make();
    const id = await client.newSession("/tmp/a");
    await client.prompt(id, [{ type: "text", text: "terminal" }]);
    await until(() => client.session(id).state === "idle");
    expect(client.session(id).terminals.t1?.output).toBe("héllo");
    const tool = client.session(id).items.find((item) => item.kind === "tool");
    expect(tool?.kind === "tool" ? tool.status : null).toBe("completed");
});

test("the session list comes from the agent across pages and open() replays the record", async () => {
    const { client, fake } = await make((fake) => {
        fake.listSessions.current = (request) =>
            request.cursor === undefined
                ? {
                      sessions: [
                          { sessionId: "h1", cwd: "/tmp/one", title: "First" },
                      ],
                      nextCursor: "page-2",
                  }
                : {
                      sessions: [
                          { sessionId: "h2", cwd: "/tmp/two", title: "Second" },
                      ],
                  };
    });
    await client.listSessions();
    expect(fake.listRequests).toEqual([{}, { cursor: "page-2" }]);
    expect(client.state.sessionList.map((item) => item.sessionId)).toEqual([
        "h1",
        "h2",
    ]);
    expect(client.state.sessionListLoaded).toBe(true);
    await client.open("h1", "/tmp/one");
    const session = client.session("h1");
    expect(session.attached).toBe(true);
    expect(session.items.map((item) => item.kind)).toEqual([
        "user",
        "assistant",
    ]);
    await client.delete("h1");
    expect(fake.deleted.has("h1")).toBe(true);
    expect(client.state.sessionList.map((item) => item.sessionId)).toEqual([
        "h2",
    ]);
    expect(client.state.sessions.h1).toBeUndefined();
});

test("a refresh replaces the list but keeps rows that changed while it was in flight", async () => {
    const gate = Promise.withResolvers<void>();
    const { client, fake } = await make();
    await client.listSessions();
    expect(client.state.sessionList.map((item) => item.sessionId)).toEqual([
        "h1",
        "h2",
    ]);
    fake.listSessions.current = async () => {
        await gate.promise;
        return {
            sessions: [{ sessionId: "h1", cwd: "/tmp/one", title: "First" }],
        };
    };
    const refreshing = client.listSessions({ reset: true });
    // Created while the agent's answer is in flight: the stale page must not drop it.
    const id = await client.newSession("/tmp/new");
    expect(client.state.sessionList[0]?.sessionId).toBe(id);
    gate.resolve();
    await refreshing;
    expect(client.state.sessionList.map((item) => item.sessionId)).toEqual([
        id,
        "h1",
    ]);
    // A later refresh is authoritative: a session the agent no longer lists leaves the list.
    await client.listSessions({ reset: true });
    expect(client.state.sessionList.map((item) => item.sessionId)).toEqual([
        "h1",
    ]);
});

test("a draft stays out of the list until its first prompt is dispatched", async () => {
    const { client } = await make();
    await client.listSessions();
    const id = await client.newSession("/tmp/draft", { draft: true });
    expect(client.isDraft(id)).toBe(true);
    expect(client.state.sessionList.some((item) => item.sessionId === id)).toBe(
        false,
    );
    await client.listSessions({ reset: true });
    expect(client.state.sessionList.some((item) => item.sessionId === id)).toBe(
        false,
    );
    await client.prompt(id, [{ type: "text", text: "first" }]);
    expect(client.isDraft(id)).toBe(false);
    expect(client.state.sessionList[0]?.sessionId).toBe(id);
    const abandoned = await client.newSession("/tmp/draft", { draft: true });
    await client.discardDraft(abandoned);
    expect(client.state.sessions[abandoned]).toBeUndefined();
});

test("a gap the client could not refill replays the whole session from the engine's record", async () => {
    const { client, port } = await make();
    await client.open("h1", "/tmp/one");
    expect(client.session("h1").items.map((item) => item.kind)).toEqual([
        "user",
        "assistant",
    ]);
    // The Runtime journal no longer had frames 3..5: what we hold is not continuous any more.
    for (const handler of port.gapHandlers)
        handler({ sessionId: "h1", from: 3, to: 5 });
    expect(client.session("h1").restoring).toBe(true);
    await until(() => !client.session("h1").restoring);
    // Replayed, not appended: the old projection was cleared first.
    expect(client.session("h1").items.map((item) => item.kind)).toEqual([
        "user",
        "assistant",
    ]);
    expect(client.session("h1").attached).toBe(true);
});

test("fork replays the source's history into the new session and lists it", async () => {
    const { client, fake } = await make();
    const source = await client.newSession("/tmp/fork");
    fake.replayUpdates.push({
        sessionUpdate: "user_message",
        messageId: "f",
        content: [{ type: "text", text: "from the source" }],
    });
    const id = await client.fork(source, "/tmp/fork", {
        meta: { codex: { lastTurnId: "t9" } },
    });
    expect(fake.forks[0]).toMatchObject({
        sessionId: source,
        cwd: "/tmp/fork",
        _meta: { codex: { lastTurnId: "t9" } },
    });
    expect(client.session(id)).toMatchObject({
        attached: true,
        restoring: false,
    });
    expect(client.session(id).items.map((item) => item.kind)).toEqual(["user"]);
    expect(client.state.sessionList[0]?.sessionId).toBe(id);
});

test("host context rides on session set-up: MCP servers, system prompt and bind", async () => {
    const bound: string[] = [];
    const { client, fake } = await make(undefined, {
        sessionContext: async (cwd, operation) => ({
            mcpServers: [
                {
                    type: "stdio",
                    name: "host",
                    command: "host-mcp",
                    args: [],
                    env: [],
                },
            ],
            appendSystemPrompt: `cwd=${cwd} op=${operation.kind}`,
            revision: "r1",
            bind: async (sessionId) => {
                bound.push(sessionId);
            },
        }),
    });
    const id = await client.newSession("/tmp/ctx", {
        systemPrompt: "extra",
        meta: { alwith: { model: "m1" } },
    });
    expect(bound).toEqual([id]);
    expect(fake.created[0]).toMatchObject({
        cwd: "/tmp/ctx",
        mcpServers: [{ name: "host" }],
        systemPrompt: {
            mode: "append",
            content: [{ type: "text", text: "cwd=/tmp/ctx op=new\n\nextra" }],
        },
        _meta: { alwith: { model: "m1" } },
    });
    await client.stopSession(id);
    await client.open(id, "/tmp/ctx");
    expect(fake.resumed[0]).toMatchObject({
        sessionId: id,
        systemPrompt: { mode: "append" },
    });
    expect(bound).toEqual([id, id]);
});

test("close during tool preparation retires the prompt without waiting on a nested replay", async () => {
    const entered = Promise.withResolvers<void>();
    const preparation = Promise.withResolvers<void>();
    const { client } = await make(undefined, {
        prepareSessionTools: () => {
            entered.resolve();
            return preparation.promise;
        },
    });
    const id = await client.newSession("/tmp/preparation-close");
    const sending = client
        .prompt(id, [{ type: "text", text: "must not send" }])
        .catch((error: unknown) => error);
    await entered.promise;
    const closing = client.close(id);
    preparation.reject(new Error("tool refresh failed"));
    expect(await sending).toMatchObject({ name: "AbortError" });
    await closing;
    expect(client.state.sessions[id]).toBeUndefined();
});

test("authentication errors propagate from session/new and the run states mirror the Runtime", async () => {
    const { client } = await make();
    await expect(client.newSession("/needs-auth")).rejects.toThrow();
    client.applyRunStates(
        [
            {
                sessionId: "r1",
                state: "running",
                reusableDraft: false,
                owner: "",
                cwd: "/tmp",
                title: "",
                since: 0,
                tasks: [],
                listeningPorts: [],
                executionId: null,
                executionRole: null,
                lastActivityAt: 0,
                version: 1,
                interruption: null,
            },
        ],
        "snapshot",
    );
    expect(client.state.runStates.r1?.state).toBe("running");
});

test("disconnect marks every held session disconnected and releases the agent for the next holder", async () => {
    const { client, port } = await make();
    const id = await client.newSession("/tmp/a");
    client.disconnect();
    expect(client.state.connection).toBe("disconnected");
    expect(client.state.sessions[id]?.attached).toBe(false);
    expect((await port.agents()).map((agent) => agent.agentId)).toEqual([
        "agent",
    ]);
    await client.connect();
    expect(port.started).toEqual(["agent"]);
    expect(client.state.connection).toBe("ready");
});
