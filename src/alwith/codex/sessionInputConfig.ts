import type {AppServerClient} from "./AppServerClient";
import type {ThreadAttachment, ThreadAttachmentAddResponse, ThreadAttachmentListResponse} from "../../app-server/v2";

type InputJson = null | string | number | boolean | InputJson[] | {[key: string]: InputJson};
export type SessionInputConfig = {mode: string; config: {[key: string]: InputJson}};
export type SessionInputConfigSnapshot = {sessionId: string; revision: number; inputConfig: SessionInputConfig | null};
const attachmentType = "alwith.session-input.v2";

function inputJson(value: unknown, depth = 0): InputJson {
    if (depth > 32) throw new Error("Session input config is too deeply nested");
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (Array.isArray(value)) return value.map(item => inputJson(item, depth + 1));
    if (value && typeof value === "object" && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null))
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, inputJson((value as Record<string, unknown>)[key], depth + 1)]));
    throw new Error("Session input config must contain only JSON values");
}

/** Storage validates the envelope, never a mode's business settings or tool policy. */
export function parseInputConfig(value: unknown): SessionInputConfig {
    if (!value || typeof value !== "object" || !("mode" in value) || typeof value.mode !== "string"
        || !value.mode.trim() || value.mode.length > 128 || /\p{Cc}/u.test(value.mode)
        || !("config" in value) || !value.config || typeof value.config !== "object" || Array.isArray(value.config))
        throw new Error("Expected session input configuration with mode and config");
    const config = inputJson(value.config) as SessionInputConfig["config"];
    const result = {mode: value.mode, config};
    if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 64 * 1024)
        throw new Error("Session input config exceeds 64 KiB");
    return result;
}

function snapshot(sessionId: string, attachment: ThreadAttachment): SessionInputConfigSnapshot {
    const revision = Number(attachment.identityKey);
    if (!Number.isSafeInteger(revision) || revision < 1 || String(revision) !== attachment.identityKey)
        throw new Error("Invalid persisted session input revision");
    return {sessionId, revision, inputConfig: parseInputConfig(attachment.payload)};
}

export async function readSessionInputConfig(client: AppServerClient, sessionId: string): Promise<SessionInputConfigSnapshot> {
    let latest: SessionInputConfigSnapshot = {sessionId, revision: 0, inputConfig: null};
    let cursor: string | null = null;
    do {
        let page: ThreadAttachmentListResponse;
        try {
            page = await client.request("thread/attachment/list", {threadId: sessionId, limit: 100, cursor});
        } catch (error) {
            if (!(error instanceof Error) || !("code" in error) || error.code !== -32602 || !/thread not found/i.test(error.message)) throw error;
            // A loaded draft has no persistent attachment owner until its first message is accepted.
            await client.threadRead({threadId: sessionId, includeTurns: false});
            return latest;
        }
        for (const item of page.data) {
            if (item.attachmentType !== attachmentType) continue;
            const next = snapshot(sessionId, item);
            if (next.revision > latest.revision) latest = next;
        }
        cursor = page.nextCursor;
    } while (cursor !== null);
    return latest;
}

/** Immutable revision keys make concurrent writes safe without removing the last saved configuration. */
export async function writeSessionInputConfig(client: AppServerClient, sessionId: string, value: unknown): Promise<SessionInputConfigSnapshot> {
    const inputConfig = parseInputConfig(value);
    for (let attempt = 0; attempt < 8; attempt++) {
        const current = await readSessionInputConfig(client, sessionId);
        if (JSON.stringify(current.inputConfig) === JSON.stringify(inputConfig)) return current;
        const revision = current.revision + 1;
        if (!Number.isSafeInteger(revision)) throw new Error("Session input revision exhausted");
        const result: ThreadAttachmentAddResponse = await client.request("thread/attachment/add", {
            threadId: sessionId, attachmentType, identityKey: String(revision), payload: inputConfig,
        });
        const saved = snapshot(sessionId, result.attachment);
        if (JSON.stringify(saved.inputConfig) === JSON.stringify(inputConfig))
            return await readSessionInputConfig(client, sessionId);
        // An existing identity means another writer committed first; no failed write is replayed.
    }
    throw new Error("Session input configuration changed concurrently; retry your selection");
}
