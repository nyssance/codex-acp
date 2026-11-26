import {SessionUpdate} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import type * as acp from "@agentclientprotocol/sdk/experimental/v2/unstable";

import type {ThreadItemEntry, Turn} from "../../app-server/v2";
import type {AppServerClient} from "../codex/AppServerClient";
import {type HistoryOmission, type HistoryRenderer, projectHistoryItem} from "./historyProjection";
import {historyError, type HistoryPage, HistoryRead, type SessionHistoryItemsParams, type SessionHistoryParams} from "./historyProtocol";
import {turnErrorUpdate} from "./turnErrors";
import {beforeUserMessageCursorUpdate} from "../../SessionCursors";
export {
    parseSessionHistoryParams,
    parseSessionHistoryItemsParams,
    type SessionHistoryParams,
    type SessionHistoryItemsParams,
} from "./historyProtocol";

export interface SessionHistoryTurn {
    turnId: string;
    status: Turn["status"];
    error: Turn["error"];
    startedAt: number | null;
    completedAt: number | null;
    durationMs: number | null;
    itemsView: Turn["itemsView"];
    updates: acp.SessionUpdate[];
    omissions: HistoryOmission[];
}
export interface SessionHistoryResponse extends HistoryPage {
    turns: SessionHistoryTurn[];
}
export interface SessionHistoryItem {
    turnId: string;
    itemId: string;
    startedAtMs: number | null;
    completedAtMs: number | null;
    updates: acp.SessionUpdate[];
    omissions: HistoryOmission[];
}
export interface SessionHistoryItemsResponse extends HistoryPage {
    items: SessionHistoryItem[];
}

/**
 * The cursor before a turn, given the updates that its first item replays as: the one that a replay
 * announces after the first visible user message of the turn (docs/session-cursors.md).
 */
function turnCursor(turnId: string, opening: readonly acp.SessionUpdate[]): acp.SessionUpdate[] {
    const message = opening.findLast(update => SessionUpdate.isUserMessage(update));
    return message === undefined ? [] : [beforeUserMessageCursorUpdate(turnId, message.messageId) as acp.SessionUpdate];
}

export async function readSessionHistory(
    codex: AppServerClient,
    render: HistoryRenderer,
    params: SessionHistoryParams,
    signal: AbortSignal = new AbortController().signal,
): Promise<SessionHistoryResponse> {
    const view = params.itemsView ?? "summary";
    const read = new HistoryRead(codex, params, {endpoint: "turns", itemsView: view}, signal);
    const start = await read.start();
    return read.fitting(params.limit ?? 50, async limit => {
        const page = await read.call(() =>
            codex.threadTurnsList({
                threadId: params.sessionId,
                cursor: read.after,
                limit,
                sortDirection: read.direction,
                itemsView: view,
            }),
        );
        read.checkTurns(page.data);
        if (view === "full" && page.data.some(turn => turn.itemsView !== "full"))
            throw historyError("history_incomplete", "Codex did not return full history items; update Codex and retry", false, {}, -32603);
        const turns = await read.call(() =>
            Promise.all(
                page.data.map(async (turn, index) => {
                    // Nothing is before the first turn of the thread, so it has no cursor.
                    const first =
                        read.direction === "desc" ? page.nextCursor === null && index === page.data.length - 1 : read.after === null && index === 0;
                    const opening = turn.items[0];
                    const projections =
                        view === "full"
                            ? await Promise.all(
                                  turn.items.map(async item =>
                                      projectHistoryItem(render, item, start.thread.cwd, turn.id, turn.startedAt, signal),
                                  ),
                              )
                            : [];
                    return {
                        turnId: turn.id,
                        status: turn.status,
                        error: turn.error,
                        startedAt: turn.startedAt,
                        completedAt: turn.completedAt,
                        durationMs: turn.durationMs,
                        itemsView: view === "summary" ? ("summary" as const) : turn.itemsView,
                        updates: [
                            ...(projections[0]?.updates ?? []),
                            ...(first || opening?.type !== "userMessage"
                                ? []
                                : turnCursor(turn.id, projections[0]?.updates ?? (await render(opening, start.thread.cwd)))),
                            ...projections.slice(1).flatMap(p => p.updates),
                            ...(turn.status === "failed" && turn.error !== null ? [turnErrorUpdate(turn.id, turn.error)] : []),
                        ],
                        omissions: projections.flatMap(p => p.omissions),
                    };
                }),
            ),
        );
        const result = await read.finish(start, page.nextCursor, page.data.length);
        return {
            ...result,
            running: page.data.some(turn => turn.status === "inProgress") ? true : result.running,
            turns,
        };
    });
}

/** Legacy Codex stores implement thread/read with inline turns and have no native item cursor. */
function legacyItemPage(turns: readonly Turn[], read: HistoryRead, turnId: string | undefined, limit: number) {
    const entries: ThreadItemEntry[] = [];
    const descending = read.direction === "desc";
    let found = read.after === null;
    let last: string | null = null;
    for (const turn of descending ? turns.toReversed() : turns) {
        if (turnId !== undefined && turn.id !== turnId) continue;
        for (const item of descending ? turn.items.toReversed() : turn.items) {
            const key = JSON.stringify([turn.id, item.id]);
            if (!found) {
                found = key === read.after;
                continue;
            }
            if (entries.length === limit) return {data: entries, nextCursor: last};
            entries.push({turnId: turn.id, item, startedAtMs: item.startedAtMs ?? null, completedAtMs: item.completedAtMs ?? null});
            last = key;
        }
    }
    if (!found) throw historyError("history_invalid_cursor", "History item no longer exists", false);
    return {data: entries, nextCursor: null};
}

export async function itemPageReader(
    codex: AppServerClient,
    render: HistoryRenderer,
    params: SessionHistoryItemsParams,
    signal: AbortSignal = new AbortController().signal,
    framed = false,
) {
    const read = new HistoryRead(codex, params, {endpoint: "items", turnId: params.turnId ?? null}, signal);
    const start = await read.start();
    const legacy = framed && start.thread.historyMode === "legacy"
        ? (await read.call(() => codex.threadRead({threadId: params.sessionId, includeTurns: true}))).thread.turns : null;
    const pageAt = async (limit: number) => {
        const page = await read.call(() =>
            legacy ? Promise.resolve(legacyItemPage(legacy, read, params.turnId, limit)) : codex.threadItemsList({
                threadId: params.sessionId,
                turnId: params.turnId ?? null,
                cursor: read.after,
                limit,
                sortDirection: read.direction,
            }),
        );
        const items = await read.call(() =>
            Promise.all(
                page.data.map(async entry => ({
                    turnId: entry.turnId,
                    itemId: entry.item.id,
                    startedAtMs: entry.startedAtMs,
                    completedAtMs: entry.completedAtMs,
                    ...(await projectHistoryItem(render, entry.item, start.thread.cwd, entry.turnId, null, signal)),
                })),
            ),
        );
        const result = await read.finish(start, page.nextCursor, page.data.length);
        return {...result, items};
    };
    return {read, pageAt};
}

export async function readSessionHistoryItems(codex: AppServerClient, render: HistoryRenderer, params: SessionHistoryItemsParams, signal?: AbortSignal): Promise<SessionHistoryItemsResponse> {
    const {read, pageAt} = await itemPageReader(codex, render, params, signal);
    return read.fitting(params.limit ?? 50, pageAt);
}
