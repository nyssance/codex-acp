import {randomBytes} from "node:crypto";
import {
    createServer,
    type IncomingHttpHeaders,
    type IncomingMessage,
    request as httpRequest,
    type Server,
    type ServerResponse,
} from "node:http";
import {request as httpsRequest} from "node:https";
import type {Socket} from "node:net";
import {type Duplex, pipeline, Readable as ResponsesReadable} from "node:stream";
import {brotliDecompressSync, gunzipSync, inflateSync, zstdDecompressSync} from "node:zlib";

import WebSocket, {type RawData, WebSocketServer} from "ws-transport";

import {NativeNetworkTransport, nativeNetworkError} from "./nativeNetworkTransport";

import {ProxyDiagnostics} from "./proxyDiagnostics";

import {compatibleResponsesRequest} from "./responsesCompatibility";

const MAX_BODY_BYTES = 64 * 1024 * 1024;
/**
 * DeepSeek reports an exhausted balance as HTTP 402. Codex treats any status it does not know as a
 * retryable connection failure, so the proxy forwards Codex's own usage-limit form instead: 429
 * `usage_limit_reached`, with the upstream host, status and message in `x-codex-promo-message`,
 * which Codex shows in the turn error and keeps in the thread. The diagnostic keeps the upstream
 * status. See docs/fallbacks.md.
 */
const PAYMENT_REQUIRED = 402;
const USAGE_LIMIT_BODY = JSON.stringify({
    error: {type: "usage_limit_reached"},
});

function decodedBody(bytes: Buffer, encoding: string | undefined): Buffer {
    switch (encoding?.trim().toLowerCase()) {
        case undefined:
        case "":
        case "identity":
            return bytes;
        case "gzip":
            return gunzipSync(bytes);
        case "deflate":
            return inflateSync(bytes);
        case "br":
            return brotliDecompressSync(bytes);
        case "zstd":
            return zstdDecompressSync(bytes);
        default:
            throw new Error(`Unsupported upstream content-encoding: ${encoding}`);
    }
}

/** The text Codex shows for an upstream 402: who sent it, and what the provider said. */
export function paymentRequiredNotice(host: string, bytes: Buffer, encoding: string | undefined, contentType: string | undefined): string {
    const text = decodedBody(bytes, encoding).toString("utf8").trim();
    const json = contentType?.toLowerCase().includes("json") ?? false;
    const parsed: unknown = json && text.length > 0 ? JSON.parse(text) : null;
    const error = typeof parsed === "object" && parsed !== null && "error" in parsed ? (parsed as {error: unknown}).error : null;
    const message =
        typeof error === "object" && error !== null && "message" in error && typeof error.message === "string" ? error.message : text;
    const notice = `${host} returned HTTP 402 Payment Required${message ? `: ${message}` : ""}`.replace(/\s+/g, " ").slice(0, 512);
    // A header value is ASCII; other characters are kept as escapes rather than dropped.
    return notice.replace(/[^\x20-\x7e]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function usageLimitHeaders(notice: string): Record<string, string> {
    return {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(USAGE_LIMIT_BODY)),
        "x-codex-promo-message": notice,
    };
}
const HOP_HEADERS = new Set([
    "host",
    "connection",
    "upgrade",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
]);

function forwardingHeaders(headers: IncomingHttpHeaders, websocket: boolean): IncomingHttpHeaders {
    const blocked = new Set(HOP_HEADERS);
    for (const name of (headers.connection ?? "").split(",")) blocked.add(name.trim().toLowerCase());
    if (websocket)
        for (const name of ["sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions", "sec-websocket-protocol"])
            blocked.add(name);
    return Object.fromEntries(Object.entries(headers).filter(([name]) => !blocked.has(name)));
}

async function requestBody(request: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of request) {
        const bytes = Buffer.from(chunk as Uint8Array);
        length += bytes.length;
        if (length > MAX_BODY_BYTES) throw new Error("Responses request is too large");
        chunks.push(bytes);
    }
    return Buffer.concat(chunks);
}

function messageBytes(data: RawData): Buffer {
    return Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
}

/** A process-local transport boundary; it never stores credentials or conversation history. */
export class ResponsesProxy {
    private readonly server: Server;
    private readonly nativeNetwork = NativeNetworkTransport.fromEnvironment();
    private readonly websocket = new WebSocketServer({
        noServer: true,
        maxPayload: MAX_BODY_BYTES,
    });
    private readonly routes = new Map<string, string | (() => Promise<string>)>();
    private readonly routeHeaders = new Map<string, Record<string, string>>();
    private readonly sockets = new Set<Socket>();
    private readonly peers = new Set<WebSocket>();
    private readonly aborts = new Set<AbortController>();
    private starting: Promise<void> | null = null;
    private closed = false;

    /** `anthropic` answers `/responses` from the route's Anthropic Messages endpoint; the route's bearer token is its API key. */
    constructor(
        private readonly destination: "native" | "external" = "native",
        private readonly protocol: "openai" | "anthropic" = "openai",
    ) {
        this.server = createServer((request, response) => {
            const diagnostic = new ProxyDiagnostics("http", this.destination);
            response.once("finish", () => diagnostic.end("completed"));
            response.once("close", () => {
                if (!response.writableFinished) setImmediate(() => diagnostic.end("cancelled"));
            });
            void this.forwardHttp(request, response, diagnostic).catch((error: unknown) => {
                diagnostic.end("failed", error);
                if (response.destroyed) return;
                if (response.headersSent) {
                    response.destroy();
                    return;
                }
                // Transport errors must not expose upstream URLs, headers or conversation content.
                if (!response.headersSent)
                    response.writeHead(502, {
                        "content-type": "text/plain",
                    });
                const code =
                    error !== null &&
                    typeof error === "object" &&
                    "code" in error &&
                    typeof error.code === "string" &&
                    /^[A-Za-z0-9_]+$/.test(error.code)
                        ? error.code
                        : "UPSTREAM_TRANSPORT_ERROR";
                response.end(`Responses compatibility proxy could not forward the request (${code})`);
            });
        });
        this.server.on("connection", socket => {
            this.sockets.add(socket);
            socket.once("error", () => socket.destroy());
            socket.once("close", () => this.sockets.delete(socket));
        });
        this.server.on("upgrade", (request, socket, head) => {
            const diagnostic = new ProxyDiagnostics("websocket", this.destination);
            socket.once("close", () => diagnostic.end("cancelled"));
            void this.target(request)
                .then(target => {
                    if (socket.destroyed) return;
                    if (
                        !target ||
                        request.method !== "GET" ||
                        !/\/(?:responses(?:\/compact)?|live|realtime(?:\/(?:calls|voices))?)$/.test(target.pathname)
                    ) {
                        diagnostic.end("completed");
                        socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
                        return;
                    }
                    diagnostic.target(target);
                    this.upgradeWebsocket(request, socket, head, target, diagnostic);
                })
                .catch((error: unknown) => {
                    diagnostic.end("failed", error);
                    socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
                });
        });
    }

    async route(upstream: string | (() => Promise<string>), headers?: Record<string, string>): Promise<string> {
        if (this.closed) throw new Error("Responses compatibility proxy is closed");
        const canonical = typeof upstream === "string" ? this.validateBase(upstream) : upstream;
        this.starting ??= new Promise<void>((resolve, reject) => {
            this.server.once("error", reject);
            this.server.listen(0, "127.0.0.1", () => {
                this.server.removeListener("error", reject);
                this.server.unref();
                if (this.closed) this.server.close();
                resolve();
            });
        });
        await this.starting;
        if (this.closed) throw new Error("Responses compatibility proxy is closed");
        const normalized =
            headers === undefined
                ? undefined
                : Object.fromEntries(
                      Object.entries(headers)
                          .map(([name, value]) => [name.toLowerCase(), value])
                          .sort(([a], [b]) => a!.localeCompare(b!)),
                  );
        let token = [...this.routes].find(
            ([key, value]) => value === canonical && JSON.stringify(this.routeHeaders.get(key)) === JSON.stringify(normalized),
        )?.[0];
        if (!token) {
            token = randomBytes(24).toString("hex");
            this.routes.set(token, canonical);
            if (normalized !== undefined) this.routeHeaders.set(token, normalized);
        }
        const address = this.server.address();
        if (!address || typeof address === "string") throw new Error("Responses compatibility proxy has no TCP address");
        return `http://127.0.0.1:${address.port}/${token}`;
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        for (const abort of this.aborts) abort.abort();
        for (const peer of this.peers) peer.terminate();
        for (const socket of this.sockets) socket.destroy();
        this.websocket.close();
        this.server.close();
        this.routes.clear();
        this.routeHeaders.clear();
    }

    private requestHeaders(request: IncomingMessage, websocket: boolean): IncomingHttpHeaders {
        const token = /^\/([a-f0-9]{48})\//.exec(request.url ?? "")?.[1];
        const override = token === undefined ? undefined : this.routeHeaders.get(token);
        if (override === undefined) return forwardingHeaders(request.headers, websocket);
        // A gateway owns authentication; native account and private headers must never escape.
        const safe = new Set(["accept", "accept-encoding", "content-type", "content-encoding", "user-agent", "openai-beta"]);
        const headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) => safe.has(name)));
        return forwardingHeaders({...headers, ...override}, websocket);
    }

    private validateBase(base: string): string {
        const url = new URL(base);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
            throw new Error("Invalid Responses upstream base URL");
        return url.href.replace(/\/$/, "");
    }

    private async target(request: IncomingMessage): Promise<URL | null> {
        // Only fixed provider endpoints are reachable; route tokens cannot select arbitrary hosts.
        const match =
            /^\/([a-f0-9]{48})(\/(?:responses(?:\/compact)?|images\/(?:generations|edits)|alpha\/search|live|realtime(?:\/(?:calls|voices))?))(\?[^#]*)?$/.exec(
                request.url ?? "",
            );
        const base = match?.[1] ? this.routes.get(match[1]) : undefined;
        if (!base || !match) return null;
        const resolved = this.validateBase(typeof base === "string" ? base : await base());
        if (this.closed) throw new Error("Responses compatibility proxy is closed");
        const path = match[2] === "/live" && resolved.includes("/backend-api") ? "/realtime/calls" : match[2];
        const target = new URL(`${resolved}${path}${match[3] ?? ""}`);
        if (match[2] === "/live" && path === "/realtime/calls") {
            target.searchParams.set("intent", "quicksilver");
            target.searchParams.set("architecture", "avas");
        }
        return target;
    }

    private async forwardHttp(request: IncomingMessage, response: ServerResponse, diagnostic: ProxyDiagnostics): Promise<void> {
        const target = await this.target(request);
        if (target) diagnostic.target(target);
        if (!target || (request.method !== "POST" && !(request.method === "GET" && target.pathname.endsWith("/realtime/voices")))) {
            response.writeHead(404).end();
            return;
        }
        const transformResponses = /\/responses(?:\/compact)?$/.test(target.pathname);
        diagnostic.stage("read_request");
        const bytes = await requestBody(request);
        diagnostic.stage("prepare_request");
        const encoding = request.headers["content-encoding"];
        if (transformResponses && encoding && encoding !== "identity" && encoding !== "zstd") {
            response.writeHead(415).end("Unsupported Responses request encoding");
            return;
        }
        let body: Buffer;
        const headers = this.requestHeaders(request, false);
        if (!transformResponses) {
            body = bytes;
            // Codex selects API multipart from the local URL. ChatGPT's backend requires the
            // same SDP and session as JSON; preserve that native backend contract at this boundary.
            if (target.pathname.includes("/backend-api/") && target.pathname.endsWith("/realtime/calls")) {
                const form = await new Request("http://localhost", {
                    method: request.method,
                    headers: {
                        "content-type": request.headers["content-type"] ?? "",
                    },
                    body: new Uint8Array(bytes),
                }).formData();
                const sdp = form.get("sdp");
                const session = form.get("session");
                if (typeof sdp !== "string" || typeof session !== "string") {
                    response.writeHead(400).end("Invalid realtime call payload");
                    return;
                }
                body = Buffer.from(JSON.stringify({sdp, session: JSON.parse(session)}));
                headers["content-type"] = "application/json";
                delete headers["content-encoding"];
            }
        } else
            try {
                const decoded =
                    encoding === "zstd"
                        ? zstdDecompressSync(bytes, {
                              maxOutputLength: MAX_BODY_BYTES,
                          })
                        : bytes;
                body = Buffer.from(compatibleResponsesRequest(decoded.toString("utf8"), this.destination));
            } catch {
                response.writeHead(400).end("Invalid Responses request body");
                return;
            }
        if (transformResponses) delete headers["content-encoding"];
        headers["content-length"] = String(body.length);
        const abort = new AbortController();
        this.aborts.add(abort);
        response.once("close", () => abort.abort());
        diagnostic.sent(body.length);
        if (this.protocol === "anthropic") {
            try {
                await this.forwardMessages(response, target, body, headers, abort, diagnostic);
            } finally {
                this.aborts.delete(abort);
            }
            return;
        }
        const native = this.nativeNetwork?.route(target, false, diagnostic.requestId);
        if (native) diagnostic.nativeNetwork();
        diagnostic.stage(native ? "connect_native" : "connect_upstream");
        try {
            // Use Bun's native HTTP client for loopback too; node:http compatibility is not a transport boundary.
            // Node uses raw HTTP below because its fetch always decompresses upstream response bodies.
            if ("Bun" in globalThis) {
                const options: RequestInit & {
                    decompress: boolean;
                    proxy?: false;
                } = {
                    method: request.method,
                    headers: (native ? {...headers, ...native.headers} : headers) as Record<string, string>,
                    ...(native ? {proxy: false as const} : {}),
                    ...(request.method === "GET" ? {} : {body: new Uint8Array(body)}),
                    signal: abort.signal,
                    redirect: "manual",
                    decompress: false,
                };
                const incoming = await fetch(native?.url ?? target, options);
                const nativeError = native && nativeNetworkError(incoming.headers.get("x-alwith-native-error"));
                if (nativeError) {
                    diagnostic.stage("connect_upstream");
                    await incoming.body?.cancel();
                    throw nativeError;
                }
                diagnostic.headers(incoming.status, incoming.headers.get("x-request-id"));
                if (this.paymentRequired(incoming.status)) {
                    this.usageLimit(
                        response,
                        diagnostic,
                        paymentRequiredNotice(
                            target.hostname,
                            Buffer.from(await incoming.arrayBuffer()),
                            incoming.headers.get("content-encoding") ?? undefined,
                            incoming.headers.get("content-type") ?? undefined,
                        ),
                    );
                    return;
                }
                response.writeHead(incoming.status, forwardingHeaders(Object.fromEntries(incoming.headers), false));
                const responseBody = incoming.body;
                if (responseBody === null) response.end();
                else
                    await new Promise<void>((resolve, reject) => {
                        const stream = ResponsesReadable.from(responseBody);
                        stream.on("data", (chunk: Uint8Array) => diagnostic.received(chunk.byteLength));
                        pipeline(stream, response, error => (error ? reject(error) : resolve()));
                    });
                return;
            }
            await new Promise<void>((resolve, reject) => {
                const send = target.protocol === "https:" && !native ? httpsRequest : httpRequest;
                const upstream = send(
                    native?.url ?? target,
                    {
                        method: request.method,
                        headers: native ? {...headers, ...native.headers} : headers,
                        signal: abort.signal,
                        ...(native ? {agent: false} : {}),
                    },
                    incoming => {
                        const nativeError = native && nativeNetworkError(incoming.headers["x-alwith-native-error"]);
                        if (nativeError) {
                            diagnostic.stage("connect_upstream");
                            incoming.resume();
                            reject(nativeError);
                            return;
                        }
                        const requestId = incoming.headers["x-request-id"];
                        diagnostic.headers(incoming.statusCode!, typeof requestId === "string" ? requestId : null, upstream.reusedSocket);
                        if (this.paymentRequired(incoming.statusCode!)) {
                            const chunks: Buffer[] = [];
                            incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
                            incoming.once("error", reject);
                            incoming.once("end", () => {
                                this.usageLimit(
                                    response,
                                    diagnostic,
                                    paymentRequiredNotice(
                                        target.hostname,
                                        Buffer.concat(chunks),
                                        incoming.headers["content-encoding"],
                                        incoming.headers["content-type"],
                                    ),
                                );
                                resolve();
                            });
                            return;
                        }
                        incoming.on("data", (chunk: Buffer) => diagnostic.received(chunk.length));
                        response.writeHead(incoming.statusCode!, forwardingHeaders(incoming.headers, false));
                        pipeline(incoming, response, error => (error ? reject(error) : resolve()));
                    },
                );
                upstream.once("error", reject);
                upstream.end(body);
            });
        } finally {
            this.aborts.delete(abort);
        }
    }

    private async forwardMessages(
        response: ServerResponse,
        target: URL,
        body: Buffer,
        headers: IncomingHttpHeaders,
        abort: AbortController,
        diagnostic: ProxyDiagnostics,
    ): Promise<void> {
        if (!target.pathname.endsWith("/responses")) {
            response.writeHead(404).end();
            return;
        }
        const apiKey = /^Bearer (.+)$/.exec(String(headers["authorization"]))?.[1];
        if (apiKey === undefined) {
            response.writeHead(401).end("The Anthropic provider has no API key");
            return;
        }
        // The translation core needs Bun; loading it here keeps it out of every other route.
        const {anthropicResponses} = await import("./anthropicMessages");
        const translated = await anthropicResponses(body.toString("utf8"), {
            baseUrl: target.href.slice(0, -"/responses".length),
            apiKey,
            signal: abort.signal,
            send: async (url, init) => {
                const native = this.nativeNetwork?.route(url, false, diagnostic.requestId);
                if (native) diagnostic.nativeNetwork();
                diagnostic.stage(native ? "connect_native" : "connect_upstream");
                const options: RequestInit & {proxy?: false} = {
                    method: init.method,
                    headers: native ? {...init.headers, ...native.headers} : init.headers,
                    ...(native ? {proxy: false as const} : {}),
                    body: init.body,
                    signal: abort.signal,
                    redirect: "manual",
                };
                const incoming = await fetch(native?.url ?? url, options);
                const nativeError = native && nativeNetworkError(incoming.headers.get("x-alwith-native-error"));
                if (nativeError) {
                    diagnostic.stage("connect_upstream");
                    await incoming.body?.cancel();
                    throw nativeError;
                }
                diagnostic.headers(incoming.status, incoming.headers.get("request-id"));
                return incoming;
            },
        });
        response.writeHead(translated.status, Object.fromEntries(translated.headers));
        const translatedBody = translated.body;
        if (translatedBody === null) response.end();
        else
            await new Promise<void>((resolve, reject) => {
                const stream = ResponsesReadable.from(translatedBody);
                stream.on("data", (chunk: Uint8Array) => diagnostic.received(chunk.byteLength));
                pipeline(stream, response, error => (error ? reject(error) : resolve()));
            });
    }

    private paymentRequired(status: number): boolean {
        return this.destination === "external" && status === PAYMENT_REQUIRED;
    }

    private usageLimit(response: ServerResponse, diagnostic: ProxyDiagnostics, notice: string): void {
        diagnostic.forwarded(429);
        response.writeHead(429, usageLimitHeaders(notice));
        response.end(USAGE_LIMIT_BODY);
    }

    private upgradeWebsocket(request: IncomingMessage, socket: Duplex, head: Buffer, target: URL, diagnostic: ProxyDiagnostics): void {
        const native = this.nativeNetwork?.route(target, true, diagnostic.requestId);
        if (native) diagnostic.nativeNetwork();
        diagnostic.stage(native ? "connect_native" : "connect_upstream");
        const upstreamTarget = native?.url ?? new URL(target);
        upstreamTarget.protocol = upstreamTarget.protocol === "https:" ? "wss:" : "ws:";
        const upstream = new WebSocket(upstreamTarget, {
            ...(native ? {agent: false} : {}),
            headers: {
                ...this.requestHeaders(request, true),
                ...(native ? native.headers : {}),
            },
            followRedirects: false,
            handshakeTimeout: native ? 40_000 : 15_000,
            maxPayload: MAX_BODY_BYTES,
        });
        this.peers.add(upstream);
        upstream.once("close", () => this.peers.delete(upstream));
        let handedOff = false;
        let rejected = false;
        socket.once("close", () => upstream.terminate());
        upstream.on("error", error => {
            diagnostic.end("failed", error);
            if (!handedOff && !rejected && !socket.destroyed)
                socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        });
        // Preserve auth recovery, rate limits and Codex's HTTP fallback before committing a 101.
        upstream.once("unexpected-response", (_sent, incoming) => {
            rejected = true;
            const nativeError = native && nativeNetworkError(incoming.headers["x-alwith-native-error"]);
            if (nativeError) {
                diagnostic.stage("connect_upstream");
                diagnostic.end("failed", nativeError);
            }
            const requestId = incoming.headers["x-request-id"];
            diagnostic.headers(incoming.statusCode!, typeof requestId === "string" ? requestId : null);
            incoming.once("end", () => diagnostic.end("completed"));
            incoming.once("error", error => diagnostic.end("failed", error));
            if (this.paymentRequired(incoming.statusCode!)) {
                const chunks: Buffer[] = [];
                incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
                incoming.once("end", () => {
                    diagnostic.forwarded(429);
                    const headers = usageLimitHeaders(
                        paymentRequiredNotice(
                            target.hostname,
                            Buffer.concat(chunks),
                            incoming.headers["content-encoding"],
                            incoming.headers["content-type"],
                        ),
                    );
                    socket.end(
                        `HTTP/1.1 429 Too Many Requests\r\n${Object.entries(headers)
                            .map(([name, value]) => `${name}: ${value}`)
                            .join("\r\n")}\r\nConnection: close\r\n\r\n${USAGE_LIMIT_BODY}`,
                    );
                    upstream.terminate();
                });
                return;
            }
            const headers = forwardingHeaders(incoming.headers, false);
            const lines = Object.entries(headers).flatMap(([name, value]) =>
                value === undefined ? [] : (Array.isArray(value) ? value : [value]).map(item => `${name}: ${item}`),
            );
            socket.write(`HTTP/1.1 ${incoming.statusCode!} Upstream rejected\r\n${lines.join("\r\n")}\r\nConnection: close\r\n\r\n`);
            pipeline(incoming, socket, () => upstream.terminate());
        });
        upstream.once("upgrade", incoming => {
            const requestId = incoming.headers["x-request-id"];
            diagnostic.headers(101, typeof requestId === "string" ? requestId : null);
        });
        upstream.once("close", code => {
            if (handedOff) diagnostic.websocketClosed(code);
        });
        upstream.once("open", () => {
            if (socket.destroyed || this.closed) {
                upstream.terminate();
                return;
            }
            handedOff = true;
            this.websocket.handleUpgrade(request, socket, head, downstream =>
                this.forwardWebsocket(downstream, upstream, target.pathname.endsWith("/responses"), diagnostic),
            );
        });
    }

    private forwardWebsocket(downstream: WebSocket, upstream: WebSocket, transformResponses: boolean, diagnostic: ProxyDiagnostics): void {
        this.peers.add(downstream);
        const fail = (error?: Error): void => {
            diagnostic.end("failed", error);
            if (downstream.readyState === WebSocket.OPEN) downstream.close(1011, "Responses upstream disconnected");
            upstream.terminate();
        };
        upstream.on("error", fail);
        downstream.on("error", () => upstream.terminate());
        downstream.on("message", (data, binary) => {
            if (binary) {
                downstream.close(1003, "Expected a JSON text frame");
                return;
            }
            let message: string;
            try {
                const text = messageBytes(data).toString("utf8");
                message = transformResponses ? compatibleResponsesRequest(text, this.destination) : text;
            } catch {
                downstream.close(1007, "Invalid Responses JSON");
                return;
            }
            if (upstream.readyState !== WebSocket.OPEN) {
                fail(new Error("A client frame arrived after the upstream closed"));
                return;
            }
            diagnostic.sent(Buffer.byteLength(message));
            upstream.send(message, error => {
                if (error) fail(error);
            });
            // Bound pending writes while retaining ws's ordered send queue.
            if (upstream.bufferedAmount > MAX_BODY_BYTES) fail();
        });
        upstream.on("message", (data, binary) => {
            diagnostic.received(messageBytes(data).length);
            if (downstream.readyState !== WebSocket.OPEN) {
                diagnostic.end("failed", new Error("An upstream frame arrived after the client closed"));
                upstream.terminate();
                return;
            }
            downstream.send(data, {binary}, error => {
                if (error) upstream.terminate();
            });
            if (downstream.bufferedAmount > MAX_BODY_BYTES) fail();
        });
        const closePeer = (peer: WebSocket, code: number): void => {
            if (peer.readyState === WebSocket.CONNECTING) peer.terminate();
            else if (peer.readyState === WebSocket.OPEN) peer.close(code === 1005 ? 1000 : code === 1006 ? 1011 : code);
        };
        downstream.once("close", code => {
            this.peers.delete(downstream);
            closePeer(upstream, code);
        });
        upstream.once("close", code => {
            this.peers.delete(upstream);
            closePeer(downstream, code);
        });
    }
}
