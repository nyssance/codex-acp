import {projectHistoryTurns} from "./history-page";
import {wireObject} from "./wire";

type Request = (params: Record<string, unknown>) => Promise<unknown>;
const object = (value: unknown) => wireObject(value, "Invalid framed history response");

/** Reassemble a single oversized wire item before exposing the page or its continuation. */
export async function readFramedItems(request: Request, params: Record<string, unknown>) {
    const {maxBytes: _budget, ...query} = params;
    const pieces: string[] = [];
    const decoder = new TextDecoder("utf-8", {fatal: true});
    let digest: string | undefined;
    let fragment: string | undefined;
    for (let part = 0; ; part++) {
        const page = object(await request({...query, framed: true, ...(fragment ? {fragment} : {})}));
        if (page.sessionId !== query.sessionId) throw new Error("Invalid history session");
        if (part === 0 && !("fragment" in page)) return page;
        if (typeof page.fragment !== "string" || !page.fragment || page.fragmentPart !== part ||
            typeof page.fragmentDigest !== "string" || !/^[a-f0-9]{64}$/.test(page.fragmentDigest) ||
            (digest !== undefined && digest !== page.fragmentDigest) || !Array.isArray(page.items) || page.items.length)
            throw new Error("Invalid history fragment");
        digest = page.fragmentDigest;
        const bytes = Uint8Array.fromBase64(page.fragment);
        pieces.push(decoder.decode(bytes, {stream: page.nextFragment !== null}));
        if (page.nextFragment === null) return {...page, items: [object(JSON.parse(pieces.join("")))]};
        fragment = digest + ":" + (part + 1);
        if (page.nextFragment !== fragment) throw new Error("Invalid history continuation");
    }
}


type Window = {
    sessionId: string;
    turns: Record<string, unknown>[];
    nextTurnCursor: string | null;
    itemCursor: string | null;
    title: unknown;
};

function cursorOf(page: Record<string, unknown>, key: "items" | "turns", sessionId: string, previous: string | null) {
    const cursor = page.nextCursor;
    if (page.sessionId !== sessionId || page.consistency !== "live" || page.revision !== null ||
        !Array.isArray(page[key]) || page.complete !== (cursor === null) ||
        (cursor !== null && (typeof cursor !== "string" || !cursor || cursor === previous || !page[key].length)))
        throw new Error("Invalid history page");
    return cursor;
}

/** Turn cursors preserve empty turns. Item cursors let a long turn span UI pages. */
export async function readFramedHistoryPage(sessionId: string, cwd: string, cursor: string | null,
    request: (method: string, params: Record<string, unknown>) => Promise<unknown>) {
    const query = {sessionId, mode: "browse", sortDirection: "desc"};
    const window: Window = cursor === null ? {sessionId, turns: [], nextTurnCursor: null, itemCursor: null, title: null} : JSON.parse(cursor);
    if (window.sessionId !== sessionId || !Array.isArray(window.turns)) throw new Error("Invalid history window cursor");
    if (!window.turns.length) {
        const page = object(await request("_codex/session_history", {...query, itemsView: "summary", limit: 5,
            ...(window.nextTurnCursor ? {cursor: window.nextTurnCursor} : {})}));
        window.nextTurnCursor = cursorOf(page, "turns", sessionId, window.nextTurnCursor);
        window.turns = (page.turns as unknown[]).map(object);
        window.title = page.title;
    }
    const turns = [];
    const turnIds = [];
    while (window.turns.length) {
        const turn = window.turns[0]!;
        if (turn.itemsView !== "summary" || typeof turn.turnId !== "string" || !Array.isArray(turn.updates))
            throw new Error("Invalid history turn metadata");
        const previous = window.itemCursor;
        const page = await readFramedItems(p => request("_codex/session_history_items", p), {
            ...query, turnId: turn.turnId, limit: 30, ...(previous ? {cursor: previous} : {}),
        });
        window.itemCursor = cursorOf(page, "items", sessionId, previous);
        const itemIds = new Set<string>();
        const updates = (page.items as unknown[]).toReversed().flatMap(raw => {
            const item = object(raw);
            if (item.turnId !== turn.turnId || typeof item.itemId !== "string" || itemIds.has(item.itemId) || !Array.isArray(item.updates))
                throw new Error("Invalid history item");
            itemIds.add(item.itemId);
            return item.updates;
        });
        turns.push({...turn, itemsView: "full", updates: previous ? updates : [...updates, ...turn.updates]});
        if (window.itemCursor) break;
        turnIds.push(turn.turnId);
        window.turns.shift();
    }
    return {session: projectHistoryTurns(sessionId, cwd, window.title, turns.reverse()), turnIds,
        cursor: window.turns.length || window.nextTurnCursor ? JSON.stringify(window) : null};
}
