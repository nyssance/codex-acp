import { randomBytes } from "node:crypto";
import {
    createServer,
    type IncomingHttpHeaders,
    type IncomingMessage,
    request as httpRequest,
    type Server,
    type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import type { Socket } from "node:net";
import {
    type Duplex,
    pipeline,
    Readable as ResponsesReadable,
} from "node:stream";
import { zstdDecompressSync } from "node:zlib";

import WebSocket, { type RawData, WebSocketServer } from "ws";

import { compatibleResponsesRequest } from "./responsesCompatibility";

const MAX_BODY_BYTES = 64 * 1024 * 1024;
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

function forwardingHeaders(
    headers: IncomingHttpHeaders,
    websocket: boolean,
): IncomingHttpHeaders {
    const blocked = new Set(HOP_HEADERS);
    for (const name of (headers.connection ?? "").split(","))
        blocked.add(name.trim().toLowerCase());
    if (websocket)
        for (const name of [
            "sec-websocket-key",
            "sec-websocket-version",
            "sec-websocket-extensions",
            "sec-websocket-protocol",
        ])
            blocked.add(name);
    return Object.fromEntries(
        Object.entries(headers).filter(([name]) => !blocked.has(name)),
    );
}

async function requestBody(request: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of request) {
        const bytes = Buffer.from(chunk as Uint8Array);
        length += bytes.length;
        if (length > MAX_BODY_BYTES)
            throw new Error("Responses request is too large");
        chunks.push(bytes);
    }
    return Buffer.concat(chunks);
}

function messageBytes(data: RawData): Buffer {
    return Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.from(
              data instanceof ArrayBuffer ? new Uint8Array(data) : data,
          );
}

/** A process-local transport boundary; it never stores credentials or conversation history. */
export class ResponsesProxy {
    private readonly server: Server;
    private readonly websocket = new WebSocketServer({
        noServer: true,
        maxPayload: MAX_BODY_BYTES,
    });
    private readonly routes = new Map<
        string,
        string | (() => Promise<string>)
    >();
    private readonly sockets = new Set<Socket>();
    private readonly peers = new Set<WebSocket>();
    private readonly aborts = new Set<AbortController>();
    private starting: Promise<void> | null = null;
    private closed = false;

    constructor() {
        this.server = createServer((request, response) => {
            void this.forwardHttp(request, response).catch((error: unknown) => {
                // Transport errors must not expose upstream URLs, headers or conversation content.
                if (!response.headersSent)
                    response.writeHead(502, { "content-type": "text/plain" });
                const code =
                    error !== null &&
                    typeof error === "object" &&
                    "code" in error &&
                    typeof error.code === "string" &&
                    /^[A-Za-z0-9_]+$/.test(error.code)
                        ? error.code
                        : "UPSTREAM_TRANSPORT_ERROR";
                response.end(
                    `Responses compatibility proxy could not forward the request (${code})`,
                );
            });
        });
        this.server.on("connection", (socket) => {
            this.sockets.add(socket);
            socket.once("error", () => socket.destroy());
            socket.once("close", () => this.sockets.delete(socket));
        });
        this.server.on("upgrade", (request, socket, head) => {
            void this.target(request)
                .then((target) => {
                    if (socket.destroyed) return;
                    if (!target || request.method !== "GET") {
                        socket.end(
                            "HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n",
                        );
                        return;
                    }
                    this.upgradeWebsocket(request, socket, head, target);
                })
                .catch(() => {
                    socket.end(
                        "HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
                    );
                });
        });
    }

    async route(upstream: string | (() => Promise<string>)): Promise<string> {
        if (this.closed)
            throw new Error("Responses compatibility proxy is closed");
        const canonical =
            typeof upstream === "string"
                ? this.validateBase(upstream)
                : upstream;
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
        if (this.closed)
            throw new Error("Responses compatibility proxy is closed");
        let token = [...this.routes].find(
            ([, value]) => value === canonical,
        )?.[0];
        if (!token) {
            token = randomBytes(24).toString("hex");
            this.routes.set(token, canonical);
        }
        const address = this.server.address();
        if (!address || typeof address === "string")
            throw new Error("Responses compatibility proxy has no TCP address");
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
    }

    private validateBase(base: string): string {
        const url = new URL(base);
        if (
            !["http:", "https:"].includes(url.protocol) ||
            url.username ||
            url.password ||
            url.search ||
            url.hash
        )
            throw new Error("Invalid Responses upstream base URL");
        return url.href.replace(/\/$/, "");
    }

    private async target(request: IncomingMessage): Promise<URL | null> {
        // Only fixed Responses endpoints are reachable; route tokens cannot select arbitrary hosts.
        const match =
            /^\/([a-f0-9]{48})(\/responses(?:\/compact)?)(\?[^#]*)?$/.exec(
                request.url ?? "",
            );
        const base = match?.[1] ? this.routes.get(match[1]) : undefined;
        if (!base || !match) return null;
        const resolved = this.validateBase(
            typeof base === "string" ? base : await base(),
        );
        if (this.closed)
            throw new Error("Responses compatibility proxy is closed");
        return new URL(`${resolved}${match[2]}${match[3] ?? ""}`);
    }

    private async forwardHttp(
        request: IncomingMessage,
        response: ServerResponse,
    ): Promise<void> {
        const target = await this.target(request);
        if (!target || request.method !== "POST") {
            response.writeHead(404).end();
            return;
        }
        const bytes = await requestBody(request);
        const encoding = request.headers["content-encoding"];
        if (encoding && encoding !== "identity" && encoding !== "zstd") {
            response
                .writeHead(415)
                .end("Unsupported Responses request encoding");
            return;
        }
        let body: Buffer;
        try {
            const decoded =
                encoding === "zstd"
                    ? zstdDecompressSync(bytes, {
                          maxOutputLength: MAX_BODY_BYTES,
                      })
                    : bytes;
            body = Buffer.from(
                compatibleResponsesRequest(decoded.toString("utf8")),
            );
        } catch {
            response.writeHead(400).end("Invalid Responses request body");
            return;
        }
        const headers = forwardingHeaders(request.headers, false);
        delete headers["content-encoding"];
        headers["content-length"] = String(body.length);
        const abort = new AbortController();
        this.aborts.add(abort);
        response.once("close", () => abort.abort());
        try {
            // Bun's native fetch preserves streaming and cancellation without its node:http proxy incompatibility.
            // Node uses raw HTTP below because its fetch always decompresses upstream response bodies.
            if ("Bun" in globalThis) {
                const options: RequestInit & { decompress: boolean } = {
                    method: "POST",
                    headers: headers as Record<string, string>,
                    body: new Uint8Array(body),
                    signal: abort.signal,
                    redirect: "manual",
                    decompress: false,
                };
                const incoming = await fetch(target, options);
                response.writeHead(
                    incoming.status,
                    forwardingHeaders(
                        Object.fromEntries(incoming.headers),
                        false,
                    ),
                );
                if (incoming.body === null) response.end();
                else
                    await new Promise<void>((resolve, reject) => {
                        pipeline(
                            ResponsesReadable.fromWeb(
                                incoming.body as import("node:stream/web").ReadableStream,
                            ),
                            response,
                            (error) => (error ? reject(error) : resolve()),
                        );
                    });
                return;
            }
            await new Promise<void>((resolve, reject) => {
                const send =
                    target.protocol === "https:" ? httpsRequest : httpRequest;
                const upstream = send(
                    target,
                    { method: "POST", headers, signal: abort.signal },
                    (incoming) => {
                        response.writeHead(
                            incoming.statusCode ?? 502,
                            forwardingHeaders(incoming.headers, false),
                        );
                        pipeline(incoming, response, (error) =>
                            error ? reject(error) : resolve(),
                        );
                    },
                );
                upstream.once("error", reject);
                upstream.end(body);
            });
        } finally {
            this.aborts.delete(abort);
        }
    }

    private upgradeWebsocket(
        request: IncomingMessage,
        socket: Duplex,
        head: Buffer,
        target: URL,
    ): void {
        target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
        const upstream = new WebSocket(target, {
            headers: forwardingHeaders(request.headers, true),
            followRedirects: false,
            handshakeTimeout: 15_000,
            maxPayload: MAX_BODY_BYTES,
        });
        this.peers.add(upstream);
        upstream.once("close", () => this.peers.delete(upstream));
        let handedOff = false;
        let rejected = false;
        socket.once("close", () => upstream.terminate());
        upstream.on("error", () => {
            if (!handedOff && !rejected && !socket.destroyed)
                socket.end(
                    "HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
                );
        });
        // Preserve auth recovery, rate limits and Codex's HTTP fallback before committing a 101.
        upstream.once("unexpected-response", (_sent, incoming) => {
            rejected = true;
            const headers = forwardingHeaders(incoming.headers, false);
            const lines = Object.entries(headers).flatMap(([name, value]) =>
                value === undefined
                    ? []
                    : (Array.isArray(value) ? value : [value]).map(
                          (item) => `${name}: ${item}`,
                      ),
            );
            socket.write(
                `HTTP/1.1 ${incoming.statusCode ?? 502} Upstream rejected\r\n${lines.join("\r\n")}\r\nConnection: close\r\n\r\n`,
            );
            pipeline(incoming, socket, () => upstream.terminate());
        });
        upstream.once("open", () => {
            if (socket.destroyed || this.closed) {
                upstream.terminate();
                return;
            }
            handedOff = true;
            this.websocket.handleUpgrade(request, socket, head, (downstream) =>
                this.forwardWebsocket(downstream, upstream),
            );
        });
    }

    private forwardWebsocket(downstream: WebSocket, upstream: WebSocket): void {
        this.peers.add(downstream);
        const fail = (): void => {
            if (downstream.readyState === WebSocket.OPEN)
                downstream.close(1011, "Responses upstream disconnected");
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
                message = compatibleResponsesRequest(
                    messageBytes(data).toString("utf8"),
                );
            } catch {
                downstream.close(1007, "Invalid Responses JSON");
                return;
            }
            if (upstream.readyState === WebSocket.OPEN) {
                upstream.send(message, (error) => {
                    if (error) fail();
                });
                // Bound pending writes while retaining ws's ordered send queue.
                if (upstream.bufferedAmount > MAX_BODY_BYTES) fail();
            }
        });
        upstream.on("message", (data, binary) => {
            if (downstream.readyState !== WebSocket.OPEN) return;
            downstream.send(data, { binary }, (error) => {
                if (error) upstream.terminate();
            });
            if (downstream.bufferedAmount > MAX_BODY_BYTES) fail();
        });
        const closePeer = (peer: WebSocket, code: number): void => {
            if (peer.readyState === WebSocket.CONNECTING) peer.terminate();
            else if (peer.readyState === WebSocket.OPEN)
                peer.close(code === 1005 ? 1000 : code === 1006 ? 1011 : code);
        };
        downstream.once("close", (code) => {
            this.peers.delete(downstream);
            closePeer(upstream, code);
        });
        upstream.once("close", (code) => {
            this.peers.delete(upstream);
            closePeer(downstream, code);
        });
    }
}
