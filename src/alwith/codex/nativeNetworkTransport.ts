interface Endpoint {
    version: 1;
    host: "127.0.0.1";
    port: number;
    token: string;
}
/** Local HTTP messages hand network ownership to the native host, including WebSocket upgrades. */
export class NativeNetworkTransport {
    private constructor(private readonly endpoint: Endpoint) {}
    static fromEnvironment(): NativeNetworkTransport | null {
        const raw = process.env["CODEX_ACP_NATIVE_NETWORK_ENDPOINT"];
        if (raw === undefined) return null;
        const value: unknown = JSON.parse(raw);
        if (!value || typeof value !== "object")
            throw new Error("Invalid native network endpoint");
        const v = value as Record<string, unknown>;
        if (
            v["version"] !== 1 ||
            v["host"] !== "127.0.0.1" ||
            !Number.isInteger(v["port"]) ||
            Number(v["port"]) < 1 ||
            Number(v["port"]) > 65535 ||
            typeof v["token"] !== "string" ||
            !/^[a-f0-9]{64}$/.test(v["token"])
        )
            throw new Error("Invalid native network endpoint");
        return new NativeNetworkTransport(value as Endpoint);
    }
    route(
        target: URL,
        websocket = false,
        requestId?: string,
    ): { url: URL; headers: Record<string, string> } {
        return {
            url: new URL(
                `http://127.0.0.1:${this.endpoint.port}/v1/${websocket ? "websocket" : "http"}`,
            ),
            headers: {
                "x-alwith-native-token": this.endpoint.token,
                "x-alwith-native-target": target.href,
                ...(requestId
                    ? { "x-alwith-native-request-id": requestId }
                    : {}),
            },
        };
    }
}

export function nativeNetworkError(value: unknown): Error | null {
    const codes = [
        "NATIVE_NETWORK_CONNECT_FAILED",
        "NATIVE_PROXY_RESOLUTION_FAILED",
        "NATIVE_NETWORK_AUTH_FAILED",
        "NATIVE_NETWORK_PROTOCOL_ERROR",
        "NATIVE_NETWORK_CANCELLED",
        "ETIMEDOUT",
    ];
    return typeof value === "string" && codes.includes(value)
        ? Object.assign(new Error("Native network request failed"), {
              code: value,
          })
        : null;
}
