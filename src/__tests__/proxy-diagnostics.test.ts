import { afterEach, expect, it, vi } from "vitest";
import {
    ProxyDiagnostics,
    PROXY_DIAGNOSTIC_PREFIX,
    transportErrors,
} from "../alwith/codex/proxyDiagnostics";

afterEach(() => vi.restoreAllMocks());

it("bounds cyclic error chains and retains codes without arbitrary exception data", () => {
    const error = Object.assign(new Error("private body and credentials"), {
        code: "ECONNRESET",
        cause: null as unknown,
    });
    error.cause = error;
    expect(transportErrors(error)).toEqual(["ECONNRESET"]);
    expect(
        transportErrors({
            code: "private-token",
            cause: { code: "ETIMEDOUT" },
        }),
    ).toEqual(["UNKNOWN", "ETIMEDOUT"]);
});

it("projects targets and upstream request IDs without URL paths, query strings or credentials", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const trace = new ProxyDiagnostics("http", "external");
    trace.target(
        new URL(
            "https://private-user:private-password@example.test/private-path/responses?secret=private-query",
        ),
    );
    trace.headers(200, "https://private-token@example.test");
    trace.end("cancelled");
    trace.end("failed", new Error("private error"));
    const lines = log.mock.calls.map((call) => String(call[0]));
    const events = lines.map((line) =>
        JSON.parse(line.slice(PROXY_DIAGNOSTIC_PREFIX.length)),
    );
    expect(events.map((event) => event.phase)).toEqual([
        "started",
        "headers",
        "cancelled",
    ]);
    expect(events[1]).toMatchObject({
        targetHost: "example.test",
        targetPort: 443,
        endpoint: "responses",
        upstreamRequestId: null,
    });
    expect(lines.join("\n")).not.toMatch(/private-/);
});

it("retains abnormal WebSocket close codes and ignores headers after termination", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const trace = new ProxyDiagnostics("websocket", "native");
    trace.websocketClosed(1006);
    trace.headers(101);
    const events = log.mock.calls.map((call) =>
        JSON.parse(String(call[0]).slice(PROXY_DIAGNOSTIC_PREFIX.length)),
    );
    expect(events.map((event) => event.phase)).toEqual(["started", "failed"]);
    expect(events[1]).toMatchObject({
        closeCode: 1006,
        runtime: "node-websocket",
    });
});
