import {expect, it} from "vitest";
import {createHash} from "node:crypto";
import {framedItems} from "../alwith/agent/historyFrames";
import type {SessionHistoryItemsResponse} from "../alwith/agent/sessionHistory";
import {AlwithExtensions} from "../alwith/Extensions";
import type {CodexAppServerClient} from "../CodexAppServerClient";
import {readFramedHistoryPage, readFramedItems} from "../client/framed-history";
import {prependHistory} from "../client/history-page";
import {textOf} from "../client/protocol";

const MiB = 1024 * 1024;
const requestId = 'history:"quoted"';
function fixture(contents: string[]) {
    const stored = contents.map((text, index) => ({
        turnId: "turn", startedAtMs: 1, completedAtMs: 2,
        item: {type: "agentMessage", id: "m" + index, text, memoryCitation: null},
    }));
    const frames: number[] = [];
    const source = {
        threadRead: async () => ({thread: {id: "s", name: "History", preview: "", cwd: "/work", status: {type: "idle"}, historyMode: "paginated"}}),
        threadTurnsList: async ({itemsView}: {itemsView: string}) => {
            expect(itemsView).toBe("summary");
            return {data: [{id: "turn", status: "completed", itemsView, items: [], error: null}], nextCursor: null};
        },
        threadItemsList: async ({cursor, limit}: {cursor: string | null; limit: number}) => {
            const first = cursor ? Number(cursor) : 0;
            const data = stored.toReversed().slice(first, first + limit);
            const next = first + data.length;
            return {data, nextCursor: next < stored.length ? String(next) : null};
        },
    } as unknown as CodexAppServerClient;
    const ext = new AlwithExtensions(() => source, async () => {}, () => false, async item =>
        item.type === "agentMessage" ? [{sessionUpdate: "agent_message", messageId: item.id, content: [{type: "text", text: item.text}]}] : []);
    async function request(method: string, params: Record<string, unknown>) {
        const result = await ext.request(method, params, undefined, requestId);
        const size = Buffer.byteLength(JSON.stringify({jsonrpc: "2.0", id: requestId, result}));
        expect(size).toBeLessThanOrEqual(32 * MiB);
        frames.push(size);
        return result;
    }
    return {request, stored, frames};
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

it.each([
    {framed: null},
    {fragment: null},
    {framed: null, fragment: null},
    {framed: true, fragment: null},
])("treats null framed-history options as absent: %j", async options => {
    const {request} = fixture(["answer"]);
    const params = {sessionId: "s", mode: "browse", sortDirection: "asc", _meta: null};
    const expected = await request("_codex/session_history_items", {
        ...params, ...(options.framed === true ? {framed: true} : {}),
    });
    expect(await request("_codex/session_history_items", {...params, ...options})).toEqual(expected);
});

it.each([false, 1, "", "invalid"])("still rejects malformed fragment continuations: %j", async fragment => {
    const {request} = fixture(["answer"]);
    await expect(request("_codex/session_history_items", {sessionId: "s", mode: "browse", framed: true, fragment}))
        .rejects.toMatchObject({code: -32602});
});

it.each([{sizes: [9, 9]}, {sizes: [17]}, {sizes: [34]}, {sizes: [17, 17]}])("preserves IDs and content across bounded frames for $sizes MiB", async ({sizes}) => {
    const texts = sizes.map((size, i) => String.fromCharCode(65 + i).repeat(size * MiB - 1) + "界");
    const {request} = fixture(texts);
    let page = await readFramedHistoryPage("s", "/work", null, request);
    let merged = page.session;
    while (page.cursor !== null) {
        const first = await readFramedHistoryPage("s", "/work", page.cursor, request);
        const retry = await readFramedHistoryPage("s", "/work", page.cursor, request);
        expect(retry.cursor).toBe(first.cursor);
        merged = prependHistory(merged, retry.session);
        page = retry;
    }
    expect(merged.items.map(item => item.id)).toEqual(texts.map((_, i) => "m" + i));
    expect(merged.items.flatMap(item => item.kind === "assistant" ? [hash(textOf(item.content))] : [])).toEqual(texts.map(hash));
});

it("rejects a changed fragment series instead of combining revisions", async () => {
    const {request, stored} = fixture(["x".repeat(34 * MiB)]);
    const read = readFramedItems(async params => {
        if (params.fragment) stored[0]!.item.text = "changed";
        return request("_codex/session_history_items", params);
    }, {sessionId: "s", mode: "browse", sortDirection: "desc", limit: 1});
    await expect(read).rejects.toMatchObject({data: {reason: "history_changed"}});
});

it("keeps a live message update when an older page for the same turn arrives", async () => {
    const texts = Array.from({length: 31}, (_, i) => "answer " + i);
    const {request} = fixture(texts);
    const newest = await readFramedHistoryPage("s", "/work", null, request);
    expect(newest.cursor).not.toBeNull();
    expect(newest.turnIds).toEqual([]);
    await expect(readFramedHistoryPage("other", "/work", newest.cursor, request)).rejects.toThrow("Invalid history window cursor");
    const older = readFramedHistoryPage("s", "/work", newest.cursor, request);
    const live = {...newest.session, items: newest.session.items.map(item => item.id === "m30" && item.kind === "assistant"
        ? {...item, content: [{type: "text" as const, text: "live update"}]} : item)};
    const last = await older;
    const merged = prependHistory(live, last.session);
    expect(last.cursor).toBeNull();
    expect(last.turnIds).toEqual(["turn"]);
    expect(merged.items.map(item => item.id)).toEqual(texts.map((_, i) => "m" + i));
    const tail = merged.items.at(-1)!;
    expect(tail.kind === "assistant" && textOf(tail.content)).toBe("live update");
});

it("preserves inline media and structured tool output when one item spans frames", async () => {
    const data = "QUJD".repeat(8 * MiB);
    const update = {sessionUpdate: "tool_call_update" as const, toolCallId: "tool", status: "completed" as const,
        rawOutput: {nested: [false, null, {key: "value"}]}, content: [
            {type: "content" as const, content: {type: "image" as const, mimeType: "image/png", data}},
        ]};
    const source: SessionHistoryItemsResponse = {sessionId: "s", cwd: "/work", title: null, createdAt: 0, updatedAt: 0,
        forkedFromId: null, running: false, revision: null, consistency: "live", nextCursor: null, complete: true,
        items: [{itemId: "i", turnId: "t", startedAtMs: null, completedAtMs: null, updates: [update], omissions: []}]};
    const page = await readFramedItems(params => framedItems(1, params.fragment as string | undefined,
        requestId, () => Promise.resolve(source)), {sessionId: "s"});
    const items = page.items as typeof source.items;
    expect(JSON.stringify(items) === JSON.stringify(source.items)).toBe(true);
});
