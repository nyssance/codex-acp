// Replay by record position (alwith-cli 2.9.75+): an agent that declares `capabilities._meta.alwith.replay.cursor` takes
// `replayFrom: { type: "_alwith/seq", after }` and answers with the replay's identity and the record's cut; every frame of
// that replay carries `_meta.replay.id`, so a client can tell a late frame of a superseded replay from the one it is waiting for.
import type * as acp from "@agentclientprotocol/sdk/experimental/v2/unstable";

import type { Session } from "./session";

export const SEQ_CURSOR = "_alwith/seq";

/** Where a resume replays from: the start, or after a record position. Assignable to `ResumeSessionRequest["replayFrom"]`. */
export type ReplayCursor =
    { type: "start" } | { type: typeof SEQ_CURSOR; after: number };

/** What the agent answers on `session/resume` (`_meta.alwith.replay`) when it replayed. */
export type ReplayReceipt = { replayId: string; after: number; cut: number };

/** Whether the agent replays from a record position. */
export function supportsSeqCursor(
    initialized: acp.InitializeResponse,
): boolean {
    const alwith = (
        initialized.capabilities?._meta as
            { alwith?: { replay?: { cursor?: unknown } } } | undefined
    )?.alwith;
    return alwith?.replay?.cursor === SEQ_CURSOR;
}

/**
 * The cursor to resume this session with: from where it has the record (`after: appliedThrough`) when the agent can and
 * the session holds anything, otherwise from the start. A session that holds nothing has nothing to continue from.
 */
export function replayCursorFor(
    initialized: acp.InitializeResponse,
    session: Session,
): ReplayCursor {
    return supportsSeqCursor(initialized) &&
        session.items.length > 0 &&
        session.appliedThrough >= 0
        ? { type: SEQ_CURSOR, after: session.appliedThrough }
        : { type: "start" };
}

/** The replay receipt of a resume response, or null when the agent did not replay. */
export function replayReceiptOf(
    response: acp.ResumeSessionResponse,
): ReplayReceipt | null {
    const replay = (
        response._meta as { alwith?: { replay?: unknown } } | null | undefined
    )?.alwith?.replay;
    if (replay === undefined || replay === null) return null;
    const { replayId, after, cut } = replay as Partial<ReplayReceipt>;
    if (
        typeof replayId !== "string" ||
        typeof after !== "number" ||
        typeof cut !== "number"
    )
        throw new Error(
            `session/resume answered a malformed replay receipt: ${JSON.stringify(replay)}`,
        );
    return { replayId, after, cut };
}

/** The replay a frame belongs to (`_meta.replay.id`), or null for a live frame. */
export function replayIdOf(update: acp.SessionUpdate): string | null {
    const replay = (update as { _meta?: { replay?: { id?: unknown } } | null })
        ._meta?.replay;
    return typeof replay?.id === "string" ? replay.id : null;
}
