import type {ThreadRealtimeStartParams} from "../app-server/v2/ThreadRealtimeStartParams";
import type * as acp from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {codexExtensionCapabilities} from "./codex-extensions";

export type RealtimeStart = Omit<ThreadRealtimeStartParams, "threadId">;
export type RealtimeEvent = {
    sessionId: string;
    event: string;
    data: Record<string, unknown>;
};

/** The existing ACP connection; this client never starts or owns an agent process. */
export interface CodexCapabilitiesConnection {
    request<T>(method: string, params: unknown): Promise<T>;
    onNotification(listener: (method: string, params: unknown) => void): () => void;
}

/** Shared by U and TV. All session routing is explicit and subscriptions belong to this connection. */
export class CodexCapabilitiesClient {
    generateImage(params: {prompt: string; images?: string[]}): Promise<{images: {mimeType: string; data: string}[]}> {
        return this.request("_codex/images/generate", params);
    }
    executeShell(sessionId: string, command: string): Promise<Record<string, never>> {
        return this.request("_codex/shell/execute", {sessionId, command});
    }
    private readonly realtimeListeners = new Map<string, Set<(event: RealtimeEvent) => void>>();
    private readonly unsubscribe: () => void;
    private closed = false;

    private readonly connection: CodexCapabilitiesConnection;

    constructor(connection: CodexCapabilitiesConnection) {
        this.connection = connection;
        this.unsubscribe = connection.onNotification((method, params) => {
            if (this.closed) return;
            if (method === "_codex/realtime/update") {
                const event = params as RealtimeEvent;
                const listeners = this.realtimeListeners.get(event.sessionId);
                if (listeners) for (const listener of listeners) listener(event);
            }
        });
    }

    private request<T>(method: string, params: unknown): Promise<T> {
        if (this.closed) return Promise.reject(new Error("Codex connection is closed"));
        return this.connection.request<T>(method, params);
    }

    startRealtime(sessionId: string, params: RealtimeStart): Promise<Record<string, never>> {
        return this.request("_codex/realtime/start", {...params, sessionId});
    }
    stopRealtime(sessionId: string): Promise<Record<string, never>> {
        return this.request("_codex/realtime/stop", {sessionId});
    }
    onRealtime(sessionId: string, listener: (event: RealtimeEvent) => void): () => void {
        let listeners = this.realtimeListeners.get(sessionId);
        if (!listeners) {
            listeners = new Set();
            this.realtimeListeners.set(sessionId, listeners);
        }
        listeners.add(listener);
        return () => {
            listeners.delete(listener);
            if (listeners.size === 0) this.realtimeListeners.delete(sessionId);
        };
    }
    dispose(): void {
        if (this.closed) return;
        this.closed = true;
        this.unsubscribe();
        for (const [sessionId, listeners] of this.realtimeListeners) {
            for (const listener of listeners) listener({sessionId, event: "disconnected", data: {}});
        }
        this.realtimeListeners.clear();
    }
}

/** Check the adapter contract before offering a native voice entry point. */
export function supportsCodexRealtime(initialized: acp.InitializeResponse | null): boolean {
    return codexExtensionCapabilities(initialized).realtime;
}
