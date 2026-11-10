import * as acp from "@agentclientprotocol/sdk/experimental/v2/unstable";
import type {Thread} from "../../app-server/v2";
import type {CodexAppServerClient} from "../../CodexAppServerClient";
import type {SessionIndexArchivedFilter} from "../../SessionIndex";
import {sessionTitle} from "./historyTitle";

/** `clientCapabilities._meta.alwith`: the ALwith client extensions, declared like AIR's. */
export const ALWITH_META_KEY = "alwith";
export const ALWITH_CAPABILITIES_KEY = "capabilities";
/** The upstream session index served to a client that is not AIR, with the standard ACP list rows. */
export const ALWITH_SESSION_INDEX_KEY = "sessionIndex";
/** Upstream's predicted follow-up prompt (`_meta.promptSuggestions` on session info updates) for a client that is not AIR. */
export const ALWITH_PROMPT_SUGGESTIONS_KEY = "promptSuggestions";

export function clientSupportsAlwithCapability(capabilities: {_meta?: unknown} | null | undefined, capability: string): boolean {
    const meta = capabilities?._meta;
    const alwith = typeof meta === "object" && meta !== null ? (meta as Record<string, unknown>)[ALWITH_META_KEY] : undefined;
    const supported =
        typeof alwith === "object" && alwith !== null ? (alwith as Record<string, unknown>)[ALWITH_CAPABILITIES_KEY] : undefined;
    return Array.isArray(supported) && supported.includes(capability);
}

/** The ACP v2 `archived` list filter as the session index's; absent means the index's default. */
export function standardArchivedFilter(params: {archived?: unknown}): SessionIndexArchivedFilter | undefined {
    switch (params.archived) {
        case undefined:
        case null:
            return undefined;
        case "exclude":
            return "unarchived";
        case "only":
            return "archived";
        case "include":
            return "all";
        default:
            throw acp.RequestError.invalidParams({archived: params.archived}, "Expected archived to be exclude, include or only");
    }
}

/**
 * The standard ACP row of an index entry: the AIR fields become the top-level `archived` and
 * `_meta.codex` lineage the ALwith client reads. The title is repaired where the native preview
 * starts with a prompt envelope, see `sessionTitle`.
 */
export async function standardSessionRow(
    client: Pick<CodexAppServerClient, "threadTurnsList">,
    thread: Thread,
    archived: boolean,
    row: acp.SessionInfo,
): Promise<acp.SessionInfo> {
    const {_meta: _air, ...fields} = row;
    return {
        ...fields,
        title: await sessionTitle(client, thread),
        archived,
        _meta: {
            codex: {
                projectId: thread.projectId ?? null,
                nativeSessionId: thread.sessionId,
                forkedFromId: thread.forkedFromId,
            },
        },
    };
}
