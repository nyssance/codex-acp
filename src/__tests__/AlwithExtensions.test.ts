import {describe, expect, it, vi} from "vitest";
import type {CodexAppServerClient, CodexConnectionEvent} from "../CodexAppServerClient";
import {AlwithExtensions, objectParams} from "../alwith/Extensions";

function peer() {
    const listeners = new Set<(event: CodexConnectionEvent) => void>();
    const lost = new Set<() => void>();
    const sendRequest = vi.fn().mockResolvedValue({data: []});
    const client = {
        connection: {sendRequest},
        connectionLoss: {onLost: (fn: () => void) => {lost.add(fn); return () => lost.delete(fn);}},
        onClientTransportEvent: (fn: (event: CodexConnectionEvent) => void) => {
            listeners.add(fn); return () => listeners.delete(fn);
        },
        getCodexHome: () => "/codex-home",
    } as unknown as CodexAppServerClient;
    return {client, sendRequest, listeners, lost};
}

describe("ALwith extensions on the upstream connection", () => {
    it("forwards catalog requests to the existing app-server", async () => {
        const upstream = peer();
        const notify = vi.fn().mockResolvedValue(undefined);
        const extensions = new AlwithExtensions(() => upstream.client, notify, () => false);
        await extensions.request("_codex/skills_list", {cwds: ["/work"]});
        expect(upstream.sendRequest).toHaveBeenCalledWith("skills/list", {cwds: ["/work"]});
        await extensions.request("_codex/account_read", {});
        expect(upstream.sendRequest).toHaveBeenLastCalledWith("account/read", {refreshToken: false});
        expect(notify).not.toHaveBeenCalled();
    });

    it("rejects aborted requests before contacting Codex", async () => {
        const upstream = peer();
        const extensions = new AlwithExtensions(() => upstream.client, vi.fn(), () => false);
        await expect(extensions.request("_codex/skills_list", {}, AbortSignal.abort())).rejects.toThrow();
        expect(upstream.sendRequest).not.toHaveBeenCalled();
    });

    it("preserves the history_busy error contract during an accepted prompt", async () => {
        const upstream = peer();
        const extensions = new AlwithExtensions(() => upstream.client, vi.fn(), () => true);
        await expect(extensions.request("_codex/session_history", {sessionId: "one", mode: "export"}))
            .rejects.toMatchObject({data: {reason: "history_busy", retryable: true}});
        expect(upstream.sendRequest).not.toHaveBeenCalled();
    });

    it("does not report a plugin write as success when configuration overrides it", async () => {
        const upstream = peer();
        upstream.sendRequest.mockResolvedValue({status: "okOverridden"});
        const notify = vi.fn();
        const extensions = new AlwithExtensions(() => upstream.client, notify, () => false);
        await expect(extensions.request("_codex/plugin_set_enabled", {pluginId: "plug", enabled: true}))
            .rejects.toThrow("overridden");
        expect(notify).not.toHaveBeenCalled();
    });

    it("rebinds notifications once and removes listeners from the dead process", async () => {
        const first = peer();
        const second = peer();
        let current = first.client;
        const notify = vi.fn().mockResolvedValue(undefined);
        const extensions = new AlwithExtensions(() => current, notify, () => false);
        extensions.observe();
        extensions.observe();
        expect(first.listeners.size).toBe(1);
        current = second.client;
        extensions.observe();
        expect(first.listeners.size).toBe(0);
        expect(first.lost.size).toBe(0);
        const event = {eventType: "notification", method: "skills/changed", params: {}} as CodexConnectionEvent;
        for (const listener of second.listeners) listener(event);
        expect(notify).toHaveBeenCalledExactlyOnceWith("_codex/skills_changed", {});
        for (const listener of second.lost) listener();
        expect(second.listeners.size).toBe(0);
    });

    it("rejects non-object extension payloads", () => {
        for (const value of [null, [], 42, "invalid"]) expect(() => objectParams(value)).toThrow();
        expect(objectParams(undefined)).toEqual({});
    });
});
