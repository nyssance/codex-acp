import {ContentBlock, SessionUpdate} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {type Item, textOf} from "./protocol";
import {wireObject} from "./wire";

export function latestAssistantReply(items: readonly Item[] | undefined): string | undefined {
    if (!items) return undefined;
    for (let index = items.length - 1; index >= 0; index--) {
        const item = items[index];
        if (item.kind !== "assistant") continue;
        const text = textOf(item.content).replaceAll(/\s+/g, " ").trim();
        if (text) return text;
    }
    return undefined;
}

const object = (value: unknown) => wireObject(value, "Invalid activity preview");

/** Read newest items without resuming, marking read, or creating another transcript. */
export async function readActivityReply(
    sessionId: string,
    request: (params: Record<string, unknown>) => Promise<unknown>,
    check: () => void,
): Promise<string | null> {
    const seen = new Set<string>();
    let cursor: string | null = null;
    do {
        check();
        const raw = await request({
            sessionId,
            mode: "browse",
            sortDirection: "desc",
            limit: 20,
            maxBytes: 16 * 1024 * 1024,
            ...(cursor === null ? {} : {cursor}),
        });
        check();
        const page = object(raw);
        if (
            page.sessionId !== sessionId ||
            page.consistency !== "live" ||
            page.revision !== null ||
            !Array.isArray(page.items) ||
            (page.nextCursor !== null && (typeof page.nextCursor !== "string" || !page.nextCursor || seen.has(page.nextCursor))) ||
            page.complete !== (page.nextCursor === null) ||
            (page.nextCursor !== null && page.items.length === 0)
        )
            throw new Error("Invalid activity preview pagination");
        for (const rawItem of page.items) {
            const item = object(rawItem);
            if (!Array.isArray(item.updates)) throw new Error("Invalid activity preview updates");
            for (const rawUpdate of item.updates.toReversed()) {
                const update = object(rawUpdate);
                if (!SessionUpdate.isAgentMessage(update as Parameters<typeof SessionUpdate.isAgentMessage>[0])) continue;
                if (!Array.isArray(update.content)) throw new Error("Invalid activity preview content");
                const content = update.content.flatMap((block: unknown) => {
                    const value = object(block);
                    if (!ContentBlock.isText(value as Parameters<typeof ContentBlock.isText>[0])) return [];
                    if (typeof value.text !== "string") throw new Error("Invalid activity preview content");
                    return [{type: "text" as const, text: value.text}];
                });
                const text = textOf(content).replaceAll(/\s+/g, " ").trim();
                if (text) return text;
            }
        }
        cursor = page.nextCursor;
        if (cursor !== null) seen.add(cursor);
    } while (cursor !== null);
    return null;
}
