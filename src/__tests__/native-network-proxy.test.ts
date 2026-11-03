import { listGatewayModels } from "../GatewayModelDiscovery";
import { setRemotePluginEnabled } from "../alwith/codex/remotePluginEnablement";
import type { AppServerClient } from "../alwith/codex/AppServerClient";
import { nativeFetch } from "../alwith/codex/nativeFetch";
import { afterEach, expect, it, vi } from "vitest";
import { once } from "node:events";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { Socket } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import { ResponsesProxy } from "../alwith/codex/responsesProxy";

const cleanup: Array<() => void> = [];
afterEach(() => {
    for (const close of cleanup.splice(0).reverse()) close();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
});
async function listen(server: Server) {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    cleanup.push(() => {
        server.closeAllConnections();
        server.close();
    });
    return (server.address() as { port: number }).port;
}
async function bridge(
    onOpen?: (socket: Socket, request: Record<string, unknown>) => boolean,
) {
    const sockets = new Set<Socket>();
    const opens: Array<Record<string, unknown>> = [];
    const server = createServer((request, response) => {
        const target = new URL(
            String(request.headers["x-alwith-native-target"]),
        );
        const opened = {
            version: 1,
            token: request.headers["x-alwith-native-token"],
            host: target.hostname,
            port: Number(target.port || 443),
        };
        opens.push(opened);
        if (onOpen?.(request.socket, opened) === false) return;
        const upstream = httpRequest(
            {
                hostname: "127.0.0.1",
                port: target.port,
                path: target.pathname + target.search,
                method: request.method,
                headers: { ...request.headers, host: target.host },
            },
            (incoming) => {
                response.writeHead(incoming.statusCode!, incoming.headers);
                incoming.pipe(response);
            },
        );
        upstream.on("error", () => response.destroy());
        response.on("close", () => upstream.destroy());
        request.pipe(upstream);
    });
    server.on("connection", (socket) => {
        sockets.add(socket);
        socket.on("error", () => {});
        socket.on("close", () => sockets.delete(socket));
    });
    server.on("upgrade", (request, socket, head) => {
        const target = new URL(
            String(request.headers["x-alwith-native-target"]),
        );
        opens.push({
            version: 1,
            token: request.headers["x-alwith-native-token"],
            host: target.hostname,
            port: Number(target.port || 443),
        });
        const upstream = httpRequest({
            hostname: "127.0.0.1",
            port: target.port,
            path: target.pathname + target.search,
            headers: { ...request.headers, host: target.host },
        });
        const forwardHeaders = (
            status: number,
            headers: Record<string, unknown>,
        ) =>
            socket.write(
                `HTTP/1.1 ${status} Native response\r\n${Object.entries(headers)
                    .map(([k, v]) => `${k}: ${v}`)
                    .join("\r\n")}\r\n\r\n`,
            );
        upstream.on("upgrade", (response, remote, remoteHead) => {
            forwardHeaders(101, response.headers);
            if (remoteHead.length) socket.write(remoteHead);
            if (head.length) remote.write(head);
            socket.pipe(remote);
            remote.pipe(socket);
            socket.on("close", () => remote.destroy());
        });
        upstream.on("response", (response) => {
            forwardHeaders(response.statusCode!, response.headers);
            response.pipe(socket);
        });
        upstream.on("error", () => socket.destroy());
        socket.on("close", () => upstream.destroy());
        upstream.end();
    });
    const port = await listen(server);
    cleanup.push(() => {
        for (const s of sockets) s.destroy();
    });
    vi.stubEnv(
        "CODEX_ACP_NATIVE_NETWORK_ENDPOINT",
        JSON.stringify({
            version: 1,
            host: "127.0.0.1",
            port,
            token: "a".repeat(64),
        }),
    );
    return opens;
}

function proxy() {
    const proxy = new ResponsesProxy();
    cleanup.push(() => proxy.close());
    return proxy;
}

it("streams HTTP through the native channel preserving auth, host and status", async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
        finish = resolve;
    });
    const upstream = createServer(async (req, res) => {
        expect(req.headers.host).toBe(`example.test:${port}`);
        expect(req.headers.authorization).toBe("Bearer upstream-only");
        expect(req.url).toBe("/v1/responses?test=1");
        let body = "";
        for await (const chunk of req) body += String(chunk);
        expect(JSON.parse(body)).toEqual({ input: [] });
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: first\n\n");
        await gate;
        res.end("data: last\n\n");
    });
    const port = await listen(upstream);
    const opens = await bridge();
    const route = await proxy().route(`https://example.test:${port}/v1`);
    const response = await fetch(route + "/responses?test=1", {
        method: "POST",
        headers: { authorization: "Bearer upstream-only" },
        body: '{"input":[]}',
    });
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(
        "first",
    );
    finish();
    let rest = "";
    while (true) {
        const next = await reader.read();
        if (next.done) break;
        rest += new TextDecoder().decode(next.value);
    }
    expect(rest).toContain("last");
    expect(opens[0]).toEqual({
        version: 1,
        token: "a".repeat(64),
        host: "example.test",
        port,
    });
});
it("cancels a pending native HTTP request when HTTP is aborted", async () => {
    let opened!: () => void;
    const ready = new Promise<void>((r) => {
        opened = r;
    });
    let closed!: () => void;
    const ended = new Promise<void>((r) => {
        closed = r;
    });
    await bridge((socket) => {
        socket.on("close", closed);
        opened();
        return false;
    });
    const route = await proxy().route("https://example.test/v1");
    const abort = new AbortController();
    const result = fetch(route + "/responses", {
        method: "POST",
        body: '{"input":[]}',
        signal: abort.signal,
    }).catch(() => null);
    await ready;
    abort.abort();
    await result;
    await ended;
});
it("forwards native network failures without leaking the endpoint token", async () => {
    await bridge((socket) => {
        socket.end(
            "HTTP/1.1 502 Bad Gateway\r\nContent-Length: 29\r\nx-alwith-native-error: NATIVE_NETWORK_CONNECT_FAILED\r\nConnection: close\r\n\r\nNATIVE_NETWORK_CONNECT_FAILED",
        );
        return false;
    });
    const route = await proxy().route("https://example.test/v1");
    const response = await fetch(route + "/responses", {
        method: "POST",
        body: '{"input":[]}',
    });
    expect(response.status).toBe(502);
    const body = await response.text();
    expect(body).toContain("NATIVE_NETWORK_CONNECT_FAILED");
    expect(body).not.toContain("a".repeat(64));
});
it.each(["http", "websocket"])(
    "identifies a reset before the native %s bridge responds",
    async (transport) => {
        const events: Array<Record<string, unknown>> = [];
        vi.spyOn(console, "error").mockImplementation((line) => {
            const prefix = "[alwith-model-proxy] ";
            if (typeof line === "string" && line.startsWith(prefix))
                events.push(JSON.parse(line.slice(prefix.length)));
        });
        const server = createServer();
        server.on("connection", (socket) => socket.destroy());
        const port = await listen(server);
        vi.stubEnv(
            "CODEX_ACP_NATIVE_NETWORK_ENDPOINT",
            JSON.stringify({
                version: 1,
                host: "127.0.0.1",
                port,
                token: "a".repeat(64),
            }),
        );
        const route = await proxy().route("https://example.test/v1");
        if (transport === "http") {
            const response = await fetch(route + "/responses", {
                method: "POST",
                body: '{"input":[]}',
            });
            expect(response.status).toBe(502);
            expect(await response.text()).toContain("ECONNRESET");
        } else {
            const client = new WebSocket(
                route.replace("http:", "ws:") + "/responses",
            );
            cleanup.push(() => client.terminate());
            client.on("error", () => {});
            await expect(once(client, "open")).rejects.toThrow();
        }
        expect(
            events.find((event) => event["phase"] === "failed"),
        ).toMatchObject({
            runtime: "rust-native",
            stage: "connect_native",
            errors: ["ECONNRESET"],
        });
    },
);
it("keeps Bun native HTTP forwarding on the loopback fetch transport", async () => {
    if (!("Bun" in globalThis)) {
        vi.stubGlobal("Bun", {});
        cleanup.push(() => vi.unstubAllGlobals());
    }
    await bridge((socket) => {
        socket.end(
            "HTTP/1.1 502 Bad Gateway\r\nContent-Length: 28\r\nx-alwith-native-error: NATIVE_NETWORK_CONNECT_FAILED\r\nConnection: close\r\n\r\nNATIVE_NETWORK_CONNECT_FAILED",
        );
        return false;
    });
    const localFetch = globalThis.fetch;
    const calls: Array<{
        url: URL;
        options: RequestInit;
    }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((url, options) => {
        if (options && "proxy" in options)
            calls.push({ url: new URL(String(url)), options });
        return localFetch(url, options);
    });
    const route = await proxy().route("https://example.test/v1");
    const response = await fetch(route + "/responses", {
        method: "POST",
        body: '{"input":[]}',
    });
    expect(response.status).toBe(502);
    expect(await response.text()).toContain("NATIVE_NETWORK_CONNECT_FAILED");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.hostname).toBe("127.0.0.1");
    expect(calls[0]!.url.pathname).toBe("/v1/http");
    expect(calls[0]!.options).toMatchObject({
        proxy: false,
        decompress: false,
        redirect: "manual",
    });
});
it("preserves WebSocket messages, close codes and reconnects over the native channel", async () => {
    const server = createServer();
    const ws = new WebSocketServer({ server });
    cleanup.push(() => ws.close());
    ws.on("connection", (socket, request) => {
        expect(request.headers.authorization).toBe("Bearer ws-only");
        socket.on("message", (message) => {
            socket.send(message.toString());
            socket.close(1000, "finished");
        });
    });
    const port = await listen(server);
    const opens = await bridge();
    const route = await proxy().route(`https://example.test:${port}/v1`);
    for (let i = 0; i < 2; i++) {
        const client = new WebSocket(
            route.replace("http:", "ws:") + "/responses",
            { headers: { authorization: "Bearer ws-only" } },
        );
        cleanup.push(() => client.terminate());
        await once(client, "open");
        const message = once(client, "message");
        const closed = once(client, "close");
        client.send(JSON.stringify({ input: [], iteration: i }));
        expect(JSON.parse(String((await message)[0]))).toEqual({
            input: [],
            iteration: i,
        });
        expect((await closed)[0]).toBe(1000);
    }
    expect(opens).toHaveLength(2);
});
it("keeps WebSocket handshake rejection available for auth recovery", async () => {
    const server = createServer();
    server.on("upgrade", (_req, socket) =>
        socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n"),
    );
    const port = await listen(server);
    await bridge();
    const route = await proxy().route(`https://example.test:${port}/v1`);
    const client = new WebSocket(route.replace("http:", "ws:") + "/responses");
    cleanup.push(() => client.terminate());
    client.on("error", () => {});
    const [, response] = await once(client, "unexpected-response");
    expect(response.statusCode).toBe(401);
    response.resume();
});
it("rejects malformed native endpoint configuration", () => {
    vi.stubEnv(
        "CODEX_ACP_NATIVE_NETWORK_ENDPOINT",
        JSON.stringify({
            version: 1,
            host: "external.test",
            port: 80,
            token: "a".repeat(64),
        }),
    );
    expect(() => new ResponsesProxy()).toThrow(
        "Invalid native network endpoint",
    );
});

it("closes the upstream when a streaming HTTP response is cancelled", async () => {
    let closed!: () => void;
    const ended = new Promise<void>((resolve) => {
        closed = resolve;
    });
    const server = createServer((_request, response) => {
        response.on("close", closed);
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write("data: first\n\n");
    });
    const port = await listen(server);
    await bridge();
    const route = await proxy().route(`https://example.test:${port}/v1`);
    const abort = new AbortController();
    const response = await fetch(route + "/responses", {
        method: "POST",
        body: '{"input":[]}',
        signal: abort.signal,
    });
    await response.body!.getReader().read();
    abort.abort();
    await ended;
});
it("closes WebSockets when their native upstream disconnects", async () => {
    const server = createServer();
    const ws = new WebSocketServer({ server });
    cleanup.push(() => ws.close());
    ws.on("connection", (socket) =>
        socket.on("message", () => socket.terminate()),
    );
    const port = await listen(server);
    await bridge();
    const route = await proxy().route(`https://example.test:${port}/v1`);
    const client = new WebSocket(route.replace("http:", "ws:") + "/responses");
    cleanup.push(() => client.terminate());
    await once(client, "open");
    const closed = once(client, "close");
    client.send('{"input":[]}');
    expect((await closed)[0]).toBe(1011);
});
it("closes open WebSockets when the proxy owner stops", async () => {
    const server = createServer();
    const ws = new WebSocketServer({ server });
    cleanup.push(() => ws.close());
    const port = await listen(server);
    await bridge();
    const owner = proxy();
    const route = await owner.route(`https://example.test:${port}/v1`);
    const client = new WebSocket(route.replace("http:", "ws:") + "/responses");
    cleanup.push(() => client.terminate());
    await once(client, "open");
    const closed = once(client, "close");
    owner.close();
    await closed;
});

it("keeps auxiliary requests and redirects on the native route", async () => {
    const server = createServer((request, response) => {
        if (request.url === "/first") {
            response
                .writeHead(302, {
                    location: `http://elsewhere.test:${port}/last`,
                })
                .end();
            return;
        }
        expect(request.headers.authorization).toBeUndefined();
        response.end("native-redirect-result");
    });
    const port = await listen(server);
    const opens = await bridge();
    const response = await nativeFetch(`http://example.test:${port}/first`, {
        headers: { authorization: "Bearer private" },
    });
    expect(await response.text()).toBe("native-redirect-result");
    expect(opens).toHaveLength(2);
    expect(opens.map((open) => open["host"])).toEqual([
        "example.test",
        "elsewhere.test",
    ]);
});
it("retains redirect rejection for remote plugin mutations", async () => {
    const server = createServer((_request, response) =>
        response.writeHead(302, { location: "https://other.test/" }).end(),
    );
    const port = await listen(server);
    const opens = await bridge();
    await expect(
        nativeFetch(`http://example.test:${port}/first`, {
            method: "POST",
            redirect: "error",
        }),
    ).rejects.toThrow("Native HTTP redirect rejected");
    expect(opens).toHaveLength(1);
});

it("routes gateway model discovery through the native service", async () => {
    const server = createServer((request, response) => {
        expect(request.url).toBe("/v1/models");
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ data: [{ id: "model-test" }] }));
    });
    const port = await listen(server);
    const opens = await bridge();
    expect(
        await listGatewayModels(`https://example.test:${port}/v1`, {}),
    ).toEqual(new Set(["model-test"]));
    expect(opens).toHaveLength(1);
});
it("routes remote plugin enablement through the native service", async () => {
    const server = createServer((request, response) => {
        expect(request.url).toBe("/backend-api/ps/plugins/plugin-test/enable");
        expect(request.method).toBe("POST");
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ id: "plugin-test", enabled: true }));
    });
    const port = await listen(server);
    const opens = await bridge();
    const client = {
        accountRead: async () => ({
            account: { type: "chatgpt" },
            workspaceRouting: {
                backendOrigin: `https://native-test.chatgpt.com:${port}`,
                chatgptAccountId: "test-account",
            },
        }),
        getAuthStatus: async () => ({
            authMethod: "chatgpt",
            authToken: "test-token",
        }),
        disconnectSignal: new AbortController().signal,
    } as unknown as AppServerClient;
    await setRemotePluginEnabled(client, "plugin-test", true);
    expect(opens).toHaveLength(1);
});
