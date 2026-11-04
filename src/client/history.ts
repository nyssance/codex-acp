/** Read-only export over codex-acp-v2's versioned history extension, without session/resume. */
export interface HistoryRequest {
    sessionId: string;
    mode: "export";
    sortDirection: "asc";
    cursor?: string;
    limit: number;
    maxBytes: number;
}

type ArchiveContent =
    | { type: "text"; text: string }
    | ({ type: "image"; mimeType: string; data: string } & Record<
          string,
          unknown
      >);

const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;

function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Invalid history response");
    return value as Record<string, unknown>;
}

/** Dialogue-only JSONL, matching the legacy archive's user/assistant record contract. */
export async function exportConversation(
    sessionId: string,
    request: (params: HistoryRequest) => Promise<unknown>,
    check: () => void,
): Promise<string> {
    const lines: string[] = [];
    const cursors = new Set<string>();
    const items = new Set<string>();
    const encoder = new TextEncoder();
    let cursor: string | undefined;
    let revision: string | undefined;
    let bytes = 0;
    while (true) {
        check();
        const raw = await request({
            sessionId,
            mode: "export",
            sortDirection: "asc",
            cursor,
            limit: 50,
            maxBytes: 16 * 1024 * 1024,
        });
        check();
        const page = object(raw);
        if (
            page.sessionId !== sessionId ||
            page.consistency !== "optimistic" ||
            (page.running !== false && page.running !== null) ||
            typeof page.revision !== "string" ||
            !page.revision ||
            !Array.isArray(page.items) ||
            typeof page.createdAt !== "number" ||
            !Number.isFinite(page.createdAt) ||
            (page.nextCursor !== null &&
                (typeof page.nextCursor !== "string" || !page.nextCursor)) ||
            page.complete !== (page.nextCursor === null)
        )
            throw new Error("Invalid or incomplete history export");
        if (revision !== undefined && revision !== page.revision)
            throw new Error("History changed during export; retry when idle");
        revision = page.revision;
        if (page.nextCursor !== null && page.items.length === 0)
            throw new Error("History pagination made no progress");
        for (const rawItem of page.items) {
            const item = object(rawItem);
            if (
                typeof item.itemId !== "string" ||
                typeof item.turnId !== "string" ||
                !Array.isArray(item.updates)
            )
                throw new Error("Invalid history item");
            const identity = JSON.stringify([item.turnId, item.itemId]);
            if (items.has(identity))
                throw new Error("History returned a duplicate item");
            items.add(identity);
            const timestamp = item.startedAtMs ?? page.createdAt * 1000;
            if (typeof timestamp !== "number" || !Number.isFinite(timestamp))
                throw new Error("Invalid history timestamp");
            // History replays each message as a start followed by its chunks; an item's
            // messages are written in the order they started.
            const messages = new Map<
                string,
                { type: "user" | "assistant"; blocks: Record<string, unknown>[] }
            >();
            for (const rawUpdate of item.updates) {
                const update = object(rawUpdate);
                const type =
                    update.sessionUpdate === "user_message" ||
                    update.sessionUpdate === "user_message_chunk"
                        ? "user"
                        : update.sessionUpdate === "agent_message" ||
                            update.sessionUpdate === "agent_message_chunk"
                          ? "assistant"
                          : null;
                if (type === null) continue;
                if (typeof update.messageId !== "string")
                    throw new Error("Invalid history message");
                const blocks =
                    update.sessionUpdate === "user_message_chunk" ||
                    update.sessionUpdate === "agent_message_chunk"
                    ? [update.content]
                    : update.content;
                if (!Array.isArray(blocks))
                    throw new Error("Invalid history message");
                const message = messages.get(update.messageId);
                if (message === undefined)
                    messages.set(update.messageId, {
                        type,
                        blocks: blocks.map(object),
                    });
                else message.blocks.push(...blocks.map(object));
            }
            for (const [messageId, message] of messages) {
                const content: ArchiveContent[] = [];
                for (const block of message.blocks) {
                    if (block.type === "text" && typeof block.text === "string")
                        content.push({ type: "text", text: block.text });
                    else if (
                        block.type === "image" &&
                        typeof block.mimeType === "string" &&
                        /^image\/[a-zA-Z0-9.+-]+$/.test(block.mimeType) &&
                        typeof block.data === "string" &&
                        block.data.length > 0
                    )
                        content.push({
                            ...block,
                            type: "image",
                            mimeType: block.mimeType,
                            data: block.data,
                        });
                    else if (
                        block.type === "resource_link" &&
                        typeof block.uri === "string"
                    )
                        content.push({
                            type: "text",
                            text: `[${typeof block.name === "string" ? block.name : "Resource"}] ${block.uri}`,
                        });
                    else
                        throw new Error(
                            `Unsupported history message content (session ${sessionId}, item ${item.itemId}, type ${String(block.type)}); refusing a partial archive`,
                        );
                }
                if (!content.length) continue;
                const line = `${JSON.stringify({
                    type: message.type,
                    sessionId,
                    uuid: messageId,
                    turnId: item.turnId,
                    timestamp: new Date(timestamp).toISOString(),
                    message: { role: message.type, content },
                })}\n`;
                bytes += encoder.encode(line).length;
                if (bytes > MAX_ARCHIVE_BYTES)
                    throw new Error("会话归档超过 25 MiB，请缩小会话后重试");
                lines.push(line);
            }
        }
        cursor = page.nextCursor ?? undefined;
        if (cursor !== undefined) {
            if (cursors.has(cursor))
                throw new Error("History returned a repeated cursor");
            cursors.add(cursor);
        }
        if (cursor === undefined) break;
    }
    check();
    return lines.join("");
}
