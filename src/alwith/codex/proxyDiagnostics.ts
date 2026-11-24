import {randomBytes} from "node:crypto";

export const PROXY_DIAGNOSTIC_PREFIX = "[alwith-model-proxy] ";

const ERROR_CODES = new Set([
    "ERR_INVALID_ARG_TYPE",
    "ERR_HTTP_REQUEST_BODY_TOO_LARGE",
    "REQUEST_BODY_READ_FAILED",
    "REQUEST_BODY_DECOMPRESS_FAILED",
    "REQUEST_BODY_PARSE_FAILED",
    "REQUEST_BODY_REWRITE_FAILED",
    "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH",
    "ERR_STREAM_PREMATURE_CLOSE",
    "NATIVE_NETWORK_CONNECT_FAILED",
    "NATIVE_PROXY_RESOLUTION_FAILED",
    "NATIVE_NETWORK_AUTH_FAILED",
    "NATIVE_NETWORK_PROTOCOL_ERROR",
    "NATIVE_NETWORK_CANCELLED",
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "ENOTFOUND",
    "EAI_AGAIN",
    "EPIPE",
    "ECONNABORTED",
    "ABORT_ERR",
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
    for (let depth = 0; depth < 4 && error !== null && typeof error === "object" && !seen.has(error); depth++) {
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

/** Exception classes identify unclassified failures without exporting arbitrary messages. */
function errorNames(error: unknown): string[] {
    const names: string[] = [];
    const seen = new Set<unknown>();
    for (let depth = 0; depth < 4 && error !== null && typeof error === "object" && !seen.has(error); depth++) {
        seen.add(error);
        const value = error as {name?: unknown; cause?: unknown};
        names.push(typeof value.name === "string" && ["Error", "TypeError", "RangeError", "AbortError", "TimeoutError", "AggregateError"].includes(value.name) ? value.name : "Other");
        error = value.cause;
    }
    return names;
}

export class ProxyDiagnostics {
    private readonly started = performance.now();
    private ended = false;
    private readonly data = {
        version: 2,
        requestId: randomBytes(12).toString("hex"),
        transport: "http" as "http" | "websocket",
        destination: "native" as "native" | "external",
        runtime: "Bun" in globalThis ? "bun-fetch" : "node-http",
        stage: "resolve_target",
        targetHost: null as string | null,
        targetPort: null as number | null,
        endpoint: "other",
        status: null as number | null,
        /** The status sent to Codex when it differs from the upstream `status`. */
        forwardedStatus: null as number | null,
        closeCode: null as number | null,
        upstreamRequestId: null as string | null,
        requestBody: null as null | {
            declaredBytes: number | null;
            readBytes: number;
            /** The body's size after its content encoding is removed; null until that succeeded. */
            decodedBytes: number | null;
            encoding: string;
            complete: boolean;
            aborted: boolean;
        },
        sentBytes: 0,
        receivedBytes: 0,
        firstByteMs: null as number | null,
        reusedSocket: null as boolean | null,
        proxyEnv: ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"].filter(name =>
            Boolean(process.env[name]),
        ),
        noProxySet: Boolean(process.env["NO_PROXY"] || process.env["no_proxy"]),
    };

    constructor(transport: "http" | "websocket", destination: "native" | "external") {
        this.data.transport = transport;
        this.data.destination = destination;
        if (transport === "websocket") this.data.runtime = "node-websocket";
        this.emit("started");
    }

    get requestId(): string {
        return this.data.requestId;
    }

    nativeNetwork(): void {
        this.data.runtime = "rust-native";
    }

    target(target: URL): void {
        this.data.targetHost = target.hostname;
        this.data.targetPort = Number(target.port || (target.protocol === "https:" ? 443 : 80));
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
            ].find(path => target.pathname.endsWith(`/${path}`)) ?? "other";
    }

    stage(stage: "read_request" | "prepare_request" | "connect_native" | "connect_upstream" | "read_response"): void {
        this.data.stage = stage;
    }

    requestBody(declared: string | undefined, encoding: string | undefined): void {
        this.data.requestBody = {
            declaredBytes: declared !== undefined && /^\d+$/.test(declared) && Number.isSafeInteger(Number(declared)) ? Number(declared) : null,
            readBytes: 0,
            decodedBytes: null,
            encoding: ["identity", "zstd", "gzip", "deflate", "br"].includes(encoding ?? "identity") ? encoding ?? "identity" : "other",
            complete: false,
            aborted: false,
        };
    }

    requestRead(bytes: number): void {
        if (this.data.requestBody) this.data.requestBody.readBytes += bytes;
    }

    requestDecoded(bytes: number): void {
        if (this.data.requestBody) this.data.requestBody.decodedBytes = bytes;
    }

    requestEnded(complete: boolean, aborted: boolean): void {
        if (this.data.requestBody) Object.assign(this.data.requestBody, {complete, aborted});
    }

    sent(bytes: number): void {
        this.data.sentBytes += bytes;
    }
    received(bytes: number): void {
        this.data.firstByteMs ??= Math.round(performance.now() - this.started);
        this.data.receivedBytes += bytes;
    }

    headers(status: number, requestId?: string | null, reusedSocket?: boolean): void {
        if (this.ended) return;
        this.data.status = status;
        this.data.upstreamRequestId = requestId && /^[a-zA-Z0-9_-]{1,128}$/.test(requestId) ? requestId : null;
        this.data.reusedSocket = reusedSocket ?? null;
        this.data.stage = "read_response";
        this.emit("headers");
    }

    /** The upstream status was replaced by a standard one before it reached Codex. */
    forwarded(status: number): void {
        this.data.forwardedStatus = status;
    }

    websocketClosed(code: number): void {
        this.data.closeCode = code;
        this.end(code === 1000 || code === 1001 ? "completed" : "failed");
    }

    end(phase: "completed" | "cancelled" | "failed", error?: unknown): void {
        if (this.ended) return;
        this.ended = true;
        const errors = phase === "failed" ? transportErrors(error) : [];
        this.emit(errors.length > 0 && errors.every(code => code === "ABORT_ERR") ? "cancelled" : phase, errors, errorNames(error));
    }

    private emit(phase: string, errors: string[] = [], errorNames: string[] = []): void {
        // stderr is carried by Runtime and projected by the host's bounded diagnostic collector.
        console.error(
            PROXY_DIAGNOSTIC_PREFIX +
                JSON.stringify({
                    ...this.data,
                    phase,
                    elapsedMs: Math.round(performance.now() - this.started),
                    errors,
                    errorNames,
                }),
        );
    }
}
