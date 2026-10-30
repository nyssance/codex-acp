import { randomBytes } from "node:crypto";

export const PROXY_DIAGNOSTIC_PREFIX = "[alwith-model-proxy] ";

const ERROR_CODES = new Set([
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "ENOTFOUND",
    "EAI_AGAIN",
    "EPIPE",
    "ECONNABORTED",
    "ABORT_ERR",
    "ERR_STREAM_PREMATURE_CLOSE",
    "CERT_HAS_EXPIRED",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "ERR_TLS_CERT_ALTNAME_INVALID",
]);

/** Keep only transport codes; exception messages and stacks can contain credentials. */
export function transportErrors(error: unknown): string[] {
    const codes: string[] = [];
    const seen = new Set<unknown>();
    for (
        let depth = 0;
        depth < 4 &&
        error !== null &&
        typeof error === "object" &&
        !seen.has(error);
        depth++
    ) {
        seen.add(error);
        const value = error as {
            code?: unknown;
            name?: unknown;
            cause?: unknown;
        };
        const code =
            typeof value.code === "string" && ERROR_CODES.has(value.code)
                ? value.code
                : value.name === "AbortError"
                  ? "ABORT_ERR"
                  : "UNKNOWN";
        codes.push(code);
        error = value.cause;
    }
    return codes.length ? codes : ["UNKNOWN"];
}

export class ProxyDiagnostics {
    private readonly started = performance.now();
    private ended = false;
    private readonly data = {
        version: 1,
        requestId: randomBytes(12).toString("hex"),
        transport: "http" as "http" | "websocket",
        destination: "native" as "native" | "external",
        runtime: "Bun" in globalThis ? "bun-fetch" : "node-http",
        stage: "resolve_target",
        targetHost: null as string | null,
        targetPort: null as number | null,
        endpoint: "other",
        status: null as number | null,
        closeCode: null as number | null,
        upstreamRequestId: null as string | null,
        sentBytes: 0,
        receivedBytes: 0,
        firstByteMs: null as number | null,
        reusedSocket: null as boolean | null,
        proxyEnv: [
            "HTTPS_PROXY",
            "https_proxy",
            "HTTP_PROXY",
            "http_proxy",
            "ALL_PROXY",
            "all_proxy",
        ].filter((name) => Boolean(process.env[name])),
        noProxySet: Boolean(process.env["NO_PROXY"] || process.env["no_proxy"]),
    };

    constructor(
        transport: "http" | "websocket",
        destination: "native" | "external",
    ) {
        this.data.transport = transport;
        this.data.destination = destination;
        if (transport === "websocket") this.data.runtime = "node-websocket";
        this.emit("started");
    }

    target(target: URL): void {
        this.data.targetHost = target.hostname;
        this.data.targetPort = Number(
            target.port || (target.protocol === "https:" ? 443 : 80),
        );
        this.data.endpoint =
            [
                "responses/compact",
                "responses",
                "images/generations",
                "images/edits",
                "alpha/search",
                "realtime/calls",
                "realtime/voices",
                "live",
                "realtime",
            ].find((path) => target.pathname.endsWith(`/${path}`)) ?? "other";
    }

    stage(
        stage:
            | "read_request"
            | "prepare_request"
            | "connect_upstream"
            | "read_response",
    ): void {
        this.data.stage = stage;
    }

    sent(bytes: number): void {
        this.data.sentBytes += bytes;
    }
    received(bytes: number): void {
        this.data.firstByteMs ??= Math.round(performance.now() - this.started);
        this.data.receivedBytes += bytes;
    }

    headers(
        status: number,
        requestId?: string | null,
        reusedSocket?: boolean,
    ): void {
        if (this.ended) return;
        this.data.status = status;
        this.data.upstreamRequestId =
            requestId && /^[a-zA-Z0-9_-]{1,128}$/.test(requestId)
                ? requestId
                : null;
        this.data.reusedSocket = reusedSocket ?? null;
        this.data.stage = "read_response";
        this.emit("headers");
    }

    websocketClosed(code: number): void {
        this.data.closeCode = code;
        this.end(code === 1000 || code === 1001 ? "completed" : "failed");
    }

    end(phase: "completed" | "cancelled" | "failed", error?: unknown): void {
        if (this.ended) return;
        this.ended = true;
        const errors = phase === "failed" ? transportErrors(error) : [];
        this.emit(
            errors.length > 0 && errors.every((code) => code === "ABORT_ERR")
                ? "cancelled"
                : phase,
            errors,
        );
    }

    private emit(phase: string, errors: string[] = []): void {
        // stderr is carried by Runtime and projected by the host's bounded diagnostic collector.
        console.error(
            PROXY_DIAGNOSTIC_PREFIX +
                JSON.stringify({
                    ...this.data,
                    phase,
                    elapsedMs: Math.round(performance.now() - this.started),
                    errors,
                }),
        );
    }
}
