import { describe, expect, it, vi } from "vitest";
import { CodexCapabilitiesClient } from "../../client/CodexCapabilitiesClient";

function connected() {
    let receive: (method: string, params: unknown) => void = () => {};
    const request = vi.fn().mockResolvedValue({});
    const unsubscribe = vi.fn();
    const client = new CodexCapabilitiesClient({
        request,
        onNotification: (listener) => {
            receive = listener;
            return unsubscribe;
        },
    });
    return {
        client,
        request,
        unsubscribe,
        receive: (method: string, params: unknown) => receive(method, params),
    };
}

describe("shared Codex capabilities client", () => {
    it("routes events by session id without using the selected chat", () => {
        const peer = connected();
        const a = vi.fn(),
            b = vi.fn();
        peer.client.onRealtime("a", a);
        peer.client.onRealtime("b", b);
        peer.receive("_codex/realtime/update", {
            sessionId: "b",
            event: "closed",
            data: { reason: null },
        });
        expect(a).not.toHaveBeenCalled();
        expect(b).toHaveBeenCalledOnce();
        peer.client.dispose();
    });
    it("disposes audio listeners on disconnect and rejects calls through the retired connection", async () => {
        const peer = connected();
        const listener = vi.fn();
        peer.client.onRealtime("a", listener);
        peer.client.dispose();
        peer.client.dispose();
        expect(peer.unsubscribe).toHaveBeenCalledOnce();
        expect(listener).toHaveBeenCalledExactlyOnceWith({
            sessionId: "a",
            event: "disconnected",
            data: {},
        });
        peer.receive("_codex/realtime/update", {
            sessionId: "a",
            event: "started",
            data: {},
        });
        expect(listener).toHaveBeenCalledOnce();
        await expect(
            peer.client.startRealtime("a", { outputModality: "audio" }),
        ).rejects.toThrow("closed");
        expect(peer.request).not.toHaveBeenCalled();
    });
    it("keeps goal clearing distinct from an unrelated session-info patch", () => {
        const peer = connected();
        const listener = vi.fn();
        peer.client.onGoal("a", listener);
        peer.receive("session/update", {
            sessionId: "a",
            update: { sessionUpdate: "session_info_update", title: "Name" },
        });
        expect(listener).not.toHaveBeenCalled();
        peer.receive("session/update", {
            sessionId: "a",
            update: {
                sessionUpdate: "session_info_update",
                _meta: { codex: { goal: null } },
            },
        });
        expect(listener).toHaveBeenCalledExactlyOnceWith(null);
        expect(peer.client.goal("a")).toBeNull();
        peer.client.dispose();
    });
    it("sends native features through ACP extension methods", async () => {
        const peer = connected();
        await peer.client.startRealtime("a", {
            outputModality: "audio",
            transport: { type: "websocket" },
        });
        expect(peer.request).toHaveBeenLastCalledWith("_codex/realtime/start", {
            sessionId: "a",
            outputModality: "audio",
            transport: { type: "websocket" },
        });
        await peer.client.controlGoal({ sessionId: "a", action: "pause" });
        expect(peer.request).toHaveBeenLastCalledWith("_session/goal", {
            sessionId: "a",
            action: "pause",
        });
        await peer.client.setupBedrock({
            type: "profile",
            profile: "work",
            region: "us-west-2",
        });
        expect(peer.request).toHaveBeenLastCalledWith("_codex/bedrock/setup", {
            type: "profile",
            profile: "work",
            region: "us-west-2",
        });
        peer.client.dispose();
    });
});
