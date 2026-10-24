import {RequestError} from "@agentclientprotocol/sdk/unstable";
import type {ClientRequest, ServerNotification} from "./app-server";
import type {CodexAppServerClient} from "./CodexAppServerClient";

/** Non-standard capabilities remain ACP extensions on the existing agent connection. */
export const CODEX_NATIVE_METHODS = {
    "_codex/realtime/start": "thread/realtime/start",
    "_codex/realtime/appendAudio": "thread/realtime/appendAudio",
    "_codex/realtime/appendText": "thread/realtime/appendText",
    "_codex/realtime/appendSpeech": "thread/realtime/appendSpeech",
    "_codex/realtime/stop": "thread/realtime/stop",
    "_codex/realtime/listVoices": "thread/realtime/listVoices",
    "_codex/permissions/list": "permissionProfile/list",
    "_codex/bedrock/discover": "account/bedrock/discover",
    "_codex/bedrock/setup": "account/bedrock/setup",
    "_codex/bedrock/checkGovCloudRequirements": "account/bedrock/checkGovCloudRequirements",
} as const satisfies Record<string, ClientRequest["method"]>;

export type CodexNativeMethod = keyof typeof CODEX_NATIVE_METHODS;
type NativeParams<M extends CodexNativeMethod> = Extract<ClientRequest, {method: typeof CODEX_NATIVE_METHODS[M]}>["params"];
export type CodexNativeParams<M extends CodexNativeMethod> = NativeParams<M> extends {threadId: string}
    ? Omit<NativeParams<M>, "threadId"> & {sessionId: string}
    : NativeParams<M>;

export const CODEX_REALTIME_UPDATE = "_codex/realtime/update";
type RealtimeNotification = Extract<ServerNotification, {method: `thread/realtime/${string}`}>;
export type CodexRealtimeUpdate = RealtimeNotification extends infer N
    ? N extends {method: `thread/realtime/${infer Event}`; params: {threadId: string}}
        ? {sessionId: string; event: Event; data: Omit<N["params"], "threadId">}
        : never
    : never;

export function realtimeUpdate(notification: ServerNotification): CodexRealtimeUpdate | null {
    if (!notification.method.startsWith("thread/realtime/")) return null;
    const event = notification as RealtimeNotification;
    const {threadId, ...data} = event.params;
    return {sessionId: threadId, event: event.method.slice("thread/realtime/".length), data} as CodexRealtimeUpdate;
}

export async function requestCodexNative(
    client: CodexAppServerClient,
    method: CodexNativeMethod,
    params: Record<string, unknown>,
    prepareSession: (id: string, writable: boolean) => Promise<void>,
): Promise<unknown> {
    const target = CODEX_NATIVE_METHODS[method];
    if (target.startsWith("thread/realtime/") && target !== "thread/realtime/listVoices") {
        const {sessionId, threadId, ...data} = params;
        if (typeof sessionId !== "string" || sessionId.trim().length === 0 || threadId !== undefined) {
            throw RequestError.invalidParams(undefined, "Expected sessionId; threadId is owned by the ACP adapter");
        }
        // Stop must remain available for a thread that became read-only during a voice session.
        await prepareSession(sessionId, target !== "thread/realtime/stop");
        return client.connection.sendRequest(target, {...data, threadId: sessionId});
    }
    return client.connection.sendRequest(target, params);
}
