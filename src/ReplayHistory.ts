import type {ThreadItemEntry, Turn} from "./app-server/v2";
import {turnErrorUpdate} from "./alwith/agent/turnErrors";

/** Adapter replay metadata; generated native protocol types remain unchanged. */
export type ReplayEntry = ThreadItemEntry & {replayMeta?: Record<string, unknown>};

function metadata(turn: Turn, openingUser: boolean): Record<string, unknown> {
    const duration = turn.durationMs ?? (turn.startedAt !== null && turn.completedAt !== null
        ? (turn.completedAt - turn.startedAt) * 1000 : null);
    return {
        historyReplay: true,
        turnId: turn.id,
        ...(turn.startedAt !== null ? {turnStartedAt: turn.startedAt * 1000} : {}),
        ...(turn.completedAt !== null ? {turnCompletedAt: turn.completedAt * 1000} : {}),
        ...(openingUser && turn.startedAt !== null ? {messageSentAt: turn.startedAt * 1000} : {}),
        ...(duration !== null ? {turnDurationMs: duration} : {}),
        ...(turn.status === "interrupted" ? {historyInterrupted: true} : {}),
    };
}

function failureEntry(turn: Turn): ReplayEntry[] {
    if (turn.status !== "failed" || turn.error === null) return [];
    const failure = turnErrorUpdate(turn.id, turn.error);
    const text = turn.error.additionalDetails
        ? `${turn.error.message}\n\n${turn.error.additionalDetails}` : turn.error.message;
    return [{
        turnId: turn.id, startedAtMs: null, completedAtMs: null,
        item: {type: "agentMessage", id: failure.messageId, text, phase: null, memoryCitation: null, delivery: null, questions: null},
        replayMeta: {...metadata(turn, false), ...(failure._meta?.["codex"] as Record<string, unknown>)},
    }];
}

export function replayEntriesOfTurn(turn: Turn): ReplayEntry[] {
    const openingUser = turn.items.find(item => item.type === "userMessage");
    return [
        ...turn.items.map(item => ({
            turnId: turn.id, item, startedAtMs: null, completedAtMs: null,
            replayMeta: metadata(turn, item === openingUser),
        })),
        ...failureEntry(turn),
    ];
}

async function* flatten<T>(pages: AsyncIterable<T[]>): AsyncGenerator<T> {
    for await (const page of pages) yield* page;
}

/** Join two chronological, snapshot-bounded streams without collecting the transcript. */
export async function* withReplayTurnMetadata(
    itemPages: AsyncIterable<ThreadItemEntry[]>,
    turnPages: AsyncIterable<Turn[]>,
): AsyncGenerator<ReplayEntry[]> {
    const items = flatten(itemPages);
    let next = await items.next();
    try {
        for await (const turn of flatten(turnPages)) {
            let openingUser = true;
            while (!next.done && next.value.turnId === turn.id) {
                const entry = next.value;
                const isOpeningUser = openingUser && entry.item.type === "userMessage";
                if (isOpeningUser) openingUser = false;
                yield [{...entry, replayMeta: metadata(turn, isOpeningUser)}];
                next = await items.next();
            }
            const failure = failureEntry(turn);
            if (failure.length > 0) yield failure;
        }
        if (!next.done) throw new Error(`History item has no matching turn metadata: ${next.value.turnId}`);
    } finally {
        await items.return(undefined);
    }
}
