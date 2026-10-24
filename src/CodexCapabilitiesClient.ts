import type {ThreadRealtimeStartParams} from "./app-server/v2/ThreadRealtimeStartParams";
import type {ThreadRealtimeAppendAudioParams} from "./app-server/v2/ThreadRealtimeAppendAudioParams";
import type {ThreadRealtimeAppendTextParams} from "./app-server/v2/ThreadRealtimeAppendTextParams";
import type {ThreadRealtimeListVoicesResponse} from "./app-server/v2/ThreadRealtimeListVoicesResponse";
import type {BedrockDiscoverResponse} from "./app-server/v2/BedrockDiscoverResponse";
import type {BedrockSetupParams} from "./app-server/v2/BedrockSetupParams";
import type {BedrockCheckGovCloudRequirementsResponse} from "./app-server/v2/BedrockCheckGovCloudRequirementsResponse";
import type {PermissionProfileListResponse} from "./app-server/v2/PermissionProfileListResponse";
import type {HooksListEntry} from "./app-server/v2/HooksListEntry";
import type {GoalControlRequest, GoalSnapshot} from "./GoalExtension";

export type {GoalSnapshot} from "./GoalExtension";
export type {HooksListEntry} from "./app-server/v2/HooksListEntry";
export type {BedrockDiscoverResponse} from "./app-server/v2/BedrockDiscoverResponse";
export type {BedrockSetupParams} from "./app-server/v2/BedrockSetupParams";
export type {PermissionProfileSummary} from "./app-server/v2/PermissionProfileSummary";
export type RealtimeStart = Omit<ThreadRealtimeStartParams, "threadId">;
export type RealtimeAudio = ThreadRealtimeAppendAudioParams["audio"];
export type RealtimeTextRole = ThreadRealtimeAppendTextParams["role"];
export type RealtimeEvent = {sessionId: string; event: string; data: Record<string, unknown>};

/** The existing ACP connection; this client never starts or owns an agent process. */
export interface CodexCapabilitiesConnection {
    request<T>(method: string, params: unknown): Promise<T>;
    onNotification(listener: (method: string, params: unknown) => void): () => void;
}

/** Shared by U and TV. All session routing is explicit and subscriptions belong to this connection. */
export class CodexCapabilitiesClient {
    private readonly realtimeListeners = new Map<string, Set<(event: RealtimeEvent) => void>>();
    private readonly goalListeners = new Map<string, Set<(goal: GoalSnapshot | null) => void>>();
    private readonly goals = new Map<string, GoalSnapshot | null>();
    private readonly unsubscribe: () => void;
    private closed = false;

    constructor(private readonly connection: CodexCapabilitiesConnection) {
        this.unsubscribe = connection.onNotification((method, params) => {
            if (this.closed) return;
            if (method === "_codex/realtime/update") {
                const event = params as RealtimeEvent;
                const listeners = this.realtimeListeners.get(event.sessionId);
                if (listeners) for (const listener of listeners) listener(event);
            } else if (method === "session/update") {
                const {sessionId, update} = params as {sessionId: string; update: {sessionUpdate: string; _meta?: {codex?: {goal?: GoalSnapshot | null}}}};
                if (update.sessionUpdate !== "session_info_update") return;
                const codex = update._meta?.codex;
                if (codex === undefined || !("goal" in codex)) return;
                const goal = codex.goal!;
                this.goals.set(sessionId, goal);
                const listeners = this.goalListeners.get(sessionId);
                if (listeners) for (const listener of listeners) listener(goal);
            }
        });
    }

    private request<T>(method: string, params: unknown): Promise<T> {
        if (this.closed) return Promise.reject(new Error("Codex connection is closed"));
        return this.connection.request<T>(method, params);
    }

    goal(sessionId: string): GoalSnapshot | null | undefined {return this.goals.get(sessionId);}
    controlGoal(params: GoalControlRequest): Promise<Record<string, never>> {return this.request("_session/goal", params);}
    onGoal(sessionId: string, listener: (goal: GoalSnapshot | null) => void): () => void {
        let listeners = this.goalListeners.get(sessionId);
        if (!listeners) {listeners = new Set(); this.goalListeners.set(sessionId, listeners);}
        listeners.add(listener);
        return () => {listeners.delete(listener); if (listeners.size === 0) this.goalListeners.delete(sessionId);};
    }
    listHooks(cwd: string): Promise<HooksListEntry> {return this.request("_codex/hooks/list", {cwd});}
    trustHooks(cwd: string, hooks: Array<{key: string; currentHash: string}>): Promise<{trusted: boolean}> {
        return this.request("_codex/hooks/trust", {cwd, hooks});
    }
    listPermissions(cwd: string, cursor: string | null = null): Promise<PermissionProfileListResponse> {
        return this.request("_codex/permissions/list", {cwd, cursor});
    }
    discoverBedrock(): Promise<BedrockDiscoverResponse> {return this.request("_codex/bedrock/discover", {});}
    setupBedrock(params: BedrockSetupParams): Promise<Record<string, never>> {return this.request("_codex/bedrock/setup", params);}
    checkGovCloudRequirements(): Promise<BedrockCheckGovCloudRequirementsResponse> {
        return this.request("_codex/bedrock/checkGovCloudRequirements", {});
    }
    listVoices(): Promise<ThreadRealtimeListVoicesResponse> {return this.request("_codex/realtime/listVoices", {});}
    startRealtime(sessionId: string, params: RealtimeStart): Promise<Record<string, never>> {
        return this.request("_codex/realtime/start", {...params, sessionId});
    }
    appendAudio(sessionId: string, audio: RealtimeAudio): Promise<Record<string, never>> {
        return this.request("_codex/realtime/appendAudio", {sessionId, audio});
    }
    appendText(sessionId: string, text: string, role: RealtimeTextRole): Promise<Record<string, never>> {
        return this.request("_codex/realtime/appendText", {sessionId, text, role});
    }
    appendSpeech(sessionId: string, text: string): Promise<Record<string, never>> {
        return this.request("_codex/realtime/appendSpeech", {sessionId, text});
    }
    stopRealtime(sessionId: string): Promise<Record<string, never>> {return this.request("_codex/realtime/stop", {sessionId});}
    onRealtime(sessionId: string, listener: (event: RealtimeEvent) => void): () => void {
        let listeners = this.realtimeListeners.get(sessionId);
        if (!listeners) {listeners = new Set(); this.realtimeListeners.set(sessionId, listeners);}
        listeners.add(listener);
        return () => {listeners.delete(listener); if (listeners.size === 0) this.realtimeListeners.delete(sessionId);};
    }
    dispose(): void {
        if (this.closed) return;
        this.closed = true;
        this.unsubscribe();
        for (const [sessionId, listeners] of this.realtimeListeners) {
            for (const listener of listeners) listener({sessionId, event: "disconnected", data: {}});
        }
        this.realtimeListeners.clear();
        this.goalListeners.clear();
        this.goals.clear();
    }
}
