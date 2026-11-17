import {describe, expect, it, vi} from "vitest";
import {CodexCapabilitiesClient} from "../../client/CodexCapabilitiesClient";

function connected() {
    let receive: (method: string, params: unknown) => void = () => {};
    const request = vi.fn().mockResolvedValue({});
    const unsubscribe = vi.fn();
    const client = new CodexCapabilitiesClient({
        request,
        onNotification: listener => {
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
            data: {reason: null},
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
        await expect(peer.client.startRealtime("a", {outputModality: "audio"})).rejects.toThrow("closed");
        expect(peer.request).not.toHaveBeenCalled();
    });
    it("sends native features through ACP extension methods", async () => {
        const peer = connected();
        await peer.client.startRealtime("a", {
            outputModality: "audio",
            transport: {type: "websocket"},
        });
        expect(peer.request).toHaveBeenLastCalledWith("_codex/realtime/start", {
            sessionId: "a",
            outputModality: "audio",
            transport: {type: "websocket"},
        });
        peer.client.dispose();
    });
});
