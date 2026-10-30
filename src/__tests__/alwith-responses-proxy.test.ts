import { afterEach, describe, expect, it, vi } from "vitest";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { zstdCompressSync } from "node:zlib";

import WebSocket, { type RawData, WebSocketServer } from "ws";

import { PROXY_DIAGNOSTIC_PREFIX } from "../alwith/codex/proxyDiagnostics";

import { ResponsesProxy } from "../alwith/codex/responsesProxy";

const foreign = {
    type: "reasoning",
    content: [{ type: "reasoning_text", text: "foreign" }],
    summary: [],
    encrypted_content: "opaque",
};
const message = {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "hello" }],
};
const body = JSON.stringify({ input: [foreign, message] });
const cleanup: Array<() => void> = [];
afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    for (const close of cleanup.splice(0).toReversed()) close();
});
async function listen(server: Server): Promise<string> {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    cleanup.push(() => {
        server.closeAllConnections();
        server.close();
    });
    const address = server.address();
    if (!address || typeof address === "string")
        throw new Error("No TCP address");
    return `http://127.0.0.1:${address.port}`;
}
function proxy(): ResponsesProxy {
    const value = new ResponsesProxy();
    cleanup.push(() => value.close());
    return value;
}
async function receive(socket: WebSocket): Promise<string> {
    const [data] = (await once(socket, "message")) as [RawData];
    return rawText(data);
}

/** A ws frame as text: Buffer, Buffer list or ArrayBuffer. */
function rawText(data: RawData): string {
    return (
        Buffer.isBuffer(data)
            ? data
            : Array.isArray(data)
              ? Buffer.concat(data)
              : Buffer.from(data)
    ).toString("utf8");
}

describe("Responses compatibility transport", () => {
    it.each(["/images/generations", "/alpha/search"])(
        "forwards %s JSON unchanged with auth, query and upstream errors",
        async (path) => {
            let received: unknown;
            const upstream = createServer(async (request, response) => {
                const chunks: Buffer[] = [];
                for await (const chunk of request)
                    chunks.push(Buffer.from(chunk));
                received = {
                    path: request.url,
                    method: request.method,
                    auth: request.headers.authorization,
                    account: request.headers["chatgpt-account-id"],
                    body: Buffer.concat(chunks).toString(),
                };
                response
                    .writeHead(429, { "retry-after": "7" })
                    .end("tool limit");
            });
            const route = await proxy().route(
                `${await listen(upstream)}/backend-api/codex`,
            );
            const payload = JSON.stringify({
                model: "gpt-image-2",
                prompt: "A lakeside walk",
                input: [foreign, message],
            });
            const response = await fetch(`${route}${path}?test=1`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    authorization: "Bearer tool-test",
                    "chatgpt-account-id": "account",
                },
                body: payload,
            });
            expect(response.status).toBe(429);
            expect(response.headers.get("retry-after")).toBe("7");
            expect(await response.text()).toBe("tool limit");
            expect(received).toEqual({
                path: `/backend-api/codex${path}?test=1`,
                method: "POST",
                auth: "Bearer tool-test",
                account: "account",
                body: payload,
            });
        },
    );

    it("preserves image edit multipart bytes and encoding", async () => {
        let received: Buffer | undefined;
        let contentType: string | undefined;
        let encoding: string | undefined;
        const upstream = createServer(async (request, response) => {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            received = Buffer.concat(chunks);
            contentType = request.headers["content-type"];
            encoding = request.headers["content-encoding"];
            response
                .writeHead(200, { "content-type": "application/json" })
                .end('{"data":[{"b64_json":"image"}]}');
        });
        const route = await proxy().route(`${await listen(upstream)}/v1`);
        const multipart = Buffer.concat([
            Buffer.from(
                '--image\r\nContent-Disposition: form-data; name="image"; filename="test.png"\r\nContent-Type: image/png\r\n\r\n',
            ),
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]),
            Buffer.from("\r\n--image--\r\n"),
        ]);
        const bytes = zstdCompressSync(multipart);
        const response = await fetch(`${route}/images/edits`, {
            method: "POST",
            headers: {
                "content-type": "multipart/form-data; boundary=image",
                "content-encoding": "zstd",
            },
            body: new Uint8Array(bytes),
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            data: [{ b64_json: "image" }],
        });
        expect(received).toEqual(bytes);
        expect(contentType).toBe("multipart/form-data; boundary=image");
        expect(encoding).toBe("zstd");
    });

    it("forwards voice listing as GET without a request body", async () => {
        let received: unknown;
        const upstream = createServer(async (request, response) => {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            received = {
                method: request.method,
                path: request.url,
                bytes: Buffer.concat(chunks).length,
            };
            response.writeHead(200).end("voices");
        });
        const route = await proxy().route(await listen(upstream));
        const response = await fetch(`${route}/realtime/voices`);
        expect(response.status).toBe(200);
        expect(await response.text()).toBe("voices");
        expect(received).toEqual({
            method: "GET",
            path: "/realtime/voices",
            bytes: 0,
        });
    });

    it("rejects unsupported tool paths and methods without contacting upstream", async () => {
        let calls = 0;
        const upstream = createServer((_request, response) => {
            calls++;
            response.writeHead(200).end("unexpected");
        });
        const route = await proxy().route(await listen(upstream));
        for (const [path, method] of [
            ["/images/unknown", "POST"],
            ["/images/generations", "GET"],
            ["/alpha/search", "DELETE"],
        ] as const) {
            const response = await fetch(`${route}${path}`, { method });
            expect(response.status).toBe(404);
        }
        expect(calls).toBe(0);
    });

    it("decodes zstd, preserves auth and streams SSE through the original base path", async () => {
        const server = createServer(
            (req, res) =>
                void (async () => {
                    const chunks: Buffer[] = [];
                    for await (const chunk of req as AsyncIterable<Buffer>)
                        chunks.push(chunk);
                    res.writeHead(200, { "content-type": "text/event-stream" });
                    res.write(
                        `data: ${JSON.stringify({ path: req.url, auth: req.headers.authorization, account: req.headers["chatgpt-account-id"], encoding: req.headers["content-encoding"] ?? null, body: JSON.parse(Buffer.concat(chunks).toString()) as unknown })}\n\n`,
                    );
                    res.end("data: [DONE]\n\n");
                })(),
        );
        const base = await listen(server);
        const route = await proxy().route(`${base}/backend-api/codex`);
        const response = await fetch(`${route}/responses`, {
            method: "POST",
            headers: {
                authorization: "Bearer test",
                "chatgpt-account-id": "account",
                "content-encoding": "zstd",
            },
            body: new Uint8Array(zstdCompressSync(body)),
        });
        expect(response.status).toBe(200);
        const text = await response.text();
        expect(JSON.parse(text.split("\n")[0]!.slice(6))).toEqual({
            path: "/backend-api/codex/responses",
            auth: "Bearer test",
            account: "account",
            encoding: null,
            body: { input: [message] },
        });
        expect(text).toContain("data: [DONE]");
    });

    it("does not follow an upstream HTTP redirect", async () => {
        let calls = 0;
        const base = await listen(
            createServer((_req, res) => {
                calls++;
                res.writeHead(307, { location: "/must-not-follow" }).end(
                    "redirect",
                );
            }),
        );
        const route = await proxy().route(base);
        const response = await fetch(`${route}/responses`, {
            method: "POST",
            body,
            redirect: "manual",
        });
        expect(response.status).toBe(307);
        expect(await response.text()).toBe("redirect");
        expect(calls).toBe(1);
    });

    it.runIf("Bun" in globalThis)(
        "reports safe Bun transport codes without upstream credentials",
        async () => {
            const downstreamFetch = globalThis.fetch;
            vi.stubGlobal("fetch", async () => {
                throw Object.assign(
                    new Error("https://secret:token@example.test"),
                    { code: "ECONNREFUSED" },
                );
            });
            const route = await proxy().route("https://example.test/v1");
            const response = await downstreamFetch(`${route}/responses`, {
                method: "POST",
                body,
            });
            expect(response.status).toBe(502);
            const text = await response.text();
            expect(text).toContain("ECONNREFUSED");
            expect(text).not.toMatch(/secret|token|example\.test/);
        },
    );

    it("filters every websocket request, preserves incremental IDs and closes the upstream on cancellation", async () => {
        const server = createServer();
        const wss = new WebSocketServer({ server });
        cleanup.push(() => wss.close());
        let upstreamClosed: Promise<unknown> | undefined;
        wss.on("connection", (socket, req) => {
            upstreamClosed = once(socket, "close");
            socket.on("message", (data) =>
                socket.send(
                    JSON.stringify({
                        body: JSON.parse(rawText(data)) as unknown,
                        auth: req.headers.authorization,
                        path: req.url,
                    }),
                ),
            );
        });
        const route = await proxy().route(await listen(server));
        const client = new WebSocket(
            `${route.replace("http:", "ws:")}/responses`,
            {
                headers: { authorization: "Bearer ws-test" },
            },
        );
        cleanup.push(() => client.terminate());
        await once(client, "open");
        let received = receive(client);
        client.send(body);
        expect(JSON.parse(await received)).toEqual({
            body: { input: [message] },
            auth: "Bearer ws-test",
            path: "/responses",
        });
        received = receive(client);
        client.send(
            JSON.stringify({
                type: "response.create",
                previous_response_id: "previous",
                input: [foreign, message],
            }),
        );
        expect((JSON.parse(await received) as { body: unknown }).body).toEqual({
            type: "response.create",
            previous_response_id: "previous",
            input: [message],
        });
        client.close(1000);
        await upstreamClosed;
    });

    it("forwards HTTP errors without retrying, and rejects unknown routes without upstream traffic", async () => {
        let calls = 0;
        const server = createServer((_req, res) => {
            calls++;
            res.writeHead(429, { "retry-after": "7" }).end("rate limited");
        });
        const route = await proxy().route(await listen(server));
        const response = await fetch(`${route}/responses`, {
            method: "POST",
            body,
        });
        expect(response.status).toBe(429);
        expect(response.headers.get("retry-after")).toBe("7");
        expect(await response.text()).toBe("rate limited");
        const forbidden = await fetch(
            `${new URL(route).origin}/unknown/responses`,
            { method: "POST", body },
        );
        expect(forbidden.status).toBe(404);
        expect(calls).toBe(1);
    });

    it.each([401, 429, 426])(
        "preserves upstream websocket handshake status %s and retry headers",
        async (status) => {
            const server = createServer();
            server.on("upgrade", (_request, socket) =>
                socket.end(
                    `HTTP/1.1 ${status} Rejected\r\nRetry-After: 7\r\nContent-Length: 8\r\nConnection: close\r\n\r\nrejected`,
                ),
            );
            const route = await proxy().route(await listen(server));
            const client = new WebSocket(
                `${route.replace("http:", "ws:")}/responses`,
            );
            cleanup.push(() => client.terminate());
            const result = await new Promise<{
                status: number | undefined;
                retry: string | undefined;
                body: string;
            }>((resolve, reject) => {
                client.on("error", reject);
                client.on("open", () =>
                    reject(
                        new Error(
                            "Proxy accepted a rejected upstream handshake",
                        ),
                    ),
                );
                client.on("unexpected-response", (_request, response) => {
                    const chunks: Buffer[] = [];
                    response.on("data", (data: Buffer) => chunks.push(data));
                    response.on("end", () =>
                        resolve({
                            status: response.statusCode,
                            retry: response.headers["retry-after"],
                            body: Buffer.concat(chunks).toString(),
                        }),
                    );
                });
            });
            expect(result).toEqual({ status, retry: "7", body: "rejected" });
        },
    );

    it("aborts upstream HTTP streaming when the downstream is cancelled", async () => {
        let disconnected: Promise<unknown> | undefined;
        const server = createServer((_req, res) => {
            disconnected = once(res, "close");
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.write("data: first\n\n");
        });
        const route = await proxy().route(await listen(server));
        const abort = new AbortController();
        const response = await fetch(`${route}/responses`, {
            method: "POST",
            body,
            signal: abort.signal,
        });
        expect((await response.body!.getReader().read()).done).toBe(false);
        abort.abort();
        await disconnected;
    });

    it("closes listeners and active websocket connections when disposed", async () => {
        const server = createServer();
        const wss = new WebSocketServer({ server });
        cleanup.push(() => wss.close());
        const value = proxy();
        const route = await value.route(await listen(server));
        const client = new WebSocket(
            `${route.replace("http:", "ws:")}/responses`,
        );
        cleanup.push(() => client.terminate());
        await once(client, "open");
        const closed = once(client, "close");
        value.close();
        await closed;
        await expect(
            fetch(`${route}/responses`, { method: "POST", body }),
        ).rejects.toThrow();
        await expect(value.route("https://api.openai.com/v1")).rejects.toThrow(
            /closed/,
        );
    });
});

it("preserves the native ChatGPT realtime call contract behind a local route", async () => {
    let received: unknown;
    const upstream = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const bytes of request) chunks.push(Buffer.from(bytes));
        expect(request.url).toBe(
            "/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas",
        );
        expect(request.headers["content-type"]).toBe("application/json");
        received = JSON.parse(Buffer.concat(chunks).toString());
        response
            .writeHead(201, {
                "content-type": "application/sdp",
                location: "/realtime/calls/rtc_test",
            })
            .end("answer");
    });
    const route = await proxy().route(
        `${await listen(upstream)}/backend-api/codex`,
    );
    const form = new FormData();
    form.set("sdp", "v=0\r\no=offer\r\n");
    form.set("session", JSON.stringify({ type: "realtime", model: "test" }));
    const result = await fetch(`${route}/live`, { method: "POST", body: form });
    expect(result.status).toBe(201);
    expect(await result.text()).toBe("answer");
    expect(result.headers.get("location")).toBe("/realtime/calls/rtc_test");
    expect(received).toEqual({
        sdp: "v=0\r\no=offer\r\n",
        session: { type: "realtime", model: "test" },
    });
});

it("preserves API realtime multipart bytes without applying Responses transformations", async () => {
    let received = "";
    const upstream = createServer(async (request, response) => {
        for await (const bytes of request) received += bytes.toString();
        expect(request.url).toBe("/v1/live");
        expect(request.headers["content-type"]).toBe(
            "multipart/form-data; boundary=test",
        );
        response.writeHead(201).end("answer");
    });
    const route = await proxy().route(`${await listen(upstream)}/v1`);
    const body =
        '--test\r\nContent-Disposition: form-data; name="sdp"\r\n\r\noffer\r\n--test--\r\n';
    const result = await fetch(`${route}/live`, {
        method: "POST",
        headers: { "content-type": "multipart/form-data; boundary=test" },
        body,
    });
    expect(result.status).toBe(201);
    expect(await result.text()).toBe("answer");
    expect(received).toBe(body);
});

it("forwards realtime websocket messages unchanged", async () => {
    const server = createServer();
    const ws = new WebSocketServer({ server });
    cleanup.push(() => ws.close());
    ws.on("connection", (socket) =>
        socket.on("message", (message) =>
            socket.send(message, { binary: false }),
        ),
    );
    const route = await proxy().route(await listen(server));
    const socket = new WebSocket(
        `${route.replace("http:", "ws:")}/realtime?call_id=rtc_test`,
    );
    cleanup.push(() => socket.terminate());
    await once(socket, "open");
    const reply = receive(socket);
    socket.send(body);
    expect(await reply).toBe(body);
});

it("preserves ChatGPT live websocket routing after backend path translation", async () => {
    const server = createServer();
    const ws = new WebSocketServer({ server });
    cleanup.push(() => ws.close());
    let path: string | undefined;
    ws.on("connection", (socket, request) => {
        path = request.url;
        socket.on("message", (message) =>
            socket.send(message, { binary: false }),
        );
    });
    const route = await proxy().route(
        `${await listen(server)}/backend-api/codex`,
    );
    const socket = new WebSocket(`${route.replace("http:", "ws:")}/live`);
    cleanup.push(() => socket.terminate());
    await once(socket, "open");
    const reply = receive(socket);
    socket.send(body);
    expect(await reply).toBe(body);
    expect(path).toBe(
        "/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas",
    );
});

it("exports correlated reset diagnostics without credentials, routing tokens or request content", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const upstream = createServer((request) => request.socket.destroy());
    const base = await listen(upstream);
    const route = await proxy().route(`${base}/private-provider-path`);
    const response = await fetch(`${route}/responses`, {
        method: "POST",
        headers: { authorization: "Bearer private-api-key" },
        body: JSON.stringify({
            input: [
                {
                    type: "message",
                    role: "user",
                    content: [{ type: "input_text", text: "private-prompt" }],
                },
            ],
        }),
    });
    expect(response.status).toBe(502);
    await response.text();
    const lines = log.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.startsWith(PROXY_DIAGNOSTIC_PREFIX));
    const allEvents = lines.map((line) =>
        JSON.parse(line.slice(PROXY_DIAGNOSTIC_PREFIX.length)),
    );
    const requestId = allEvents.findLast(
        (event) => event.phase === "started",
    ).requestId;
    const events = allEvents.filter((event) => event.requestId === requestId);
    expect(events.map((event) => event.phase)).toEqual(["started", "failed"]);
    expect(new Set(events.map((event) => event.requestId)).size).toBe(1);
    expect(events[1]).toMatchObject({
        stage: "connect_upstream",
        targetHost: "127.0.0.1",
        endpoint: "responses",
        status: null,
    });
    expect(events[1].errors).toContain("ECONNRESET");
    for (const secret of [
        "private-api-key",
        "private-prompt",
        "private-provider-path",
        new URL(route).pathname.slice(1),
    ]) {
        expect(lines.join("\n")).not.toContain(secret);
    }
});

it("records upstream status, request ID and streamed bytes with a single terminal diagnostic", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const upstream = createServer((_request, response) => {
        response.writeHead(200, {
            "content-type": "text/event-stream",
            "x-request-id": "req_test123",
        });
        response.write("data: first\n\n");
        response.end("data: [DONE]\n\n");
    });
    const route = await proxy().route(await listen(upstream));
    const response = await fetch(`${route}/responses`, {
        method: "POST",
        body,
    });
    const text = await response.text();
    const events = log.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.startsWith(PROXY_DIAGNOSTIC_PREFIX))
        .map((line) => JSON.parse(line.slice(PROXY_DIAGNOSTIC_PREFIX.length)));
    expect(events.map((event) => event.phase)).toEqual([
        "started",
        "headers",
        "completed",
    ]);
    expect(events.at(-1)).toMatchObject({
        status: 200,
        upstreamRequestId: "req_test123",
        receivedBytes: Buffer.byteLength(text),
        errors: [],
    });
    expect(events.at(-1).firstByteMs).toBeTypeOf("number");
});

it("reports a truncated upstream stream as failure without injecting error text into SSE", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const upstream = createServer((_request, response) => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write("data: partial\n\n");
        setTimeout(() => response.destroy(), 10);
    });
    const route = await proxy().route(await listen(upstream));
    const response = await fetch(`${route}/responses`, {
        method: "POST",
        body,
    });
    await expect(response.text()).rejects.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
    const allEvents = log.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.startsWith(PROXY_DIAGNOSTIC_PREFIX))
        .map((line) => JSON.parse(line.slice(PROXY_DIAGNOSTIC_PREFIX.length)));
    const requestId = allEvents.findLast(
        (event) => event.phase === "started",
    ).requestId;
    const events = allEvents.filter((event) => event.requestId === requestId);
    expect(events.map((event) => event.phase)).toEqual([
        "started",
        "headers",
        "failed",
    ]);
    expect(events.at(-1)).toMatchObject({
        stage: "read_response",
        status: 200,
    });
});
