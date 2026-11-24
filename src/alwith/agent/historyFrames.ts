import {createHash} from "node:crypto";
import {historyError} from "./historyProtocol";
import type {SessionHistoryItemsResponse} from "./sessionHistory";

const FRAME_BYTES = 32 * 1024 * 1024;
// Independent of the request ID so a retried fragment uses the same byte offsets.
const PART_BYTES = 12 * 1024 * 1024;

/** Retry using the same native cursor. Only advance it once a whole item is available. */
export async function framedItems(
    limit: number,
    continuation: string | undefined,
    requestId: string | number | null,
    read: (limit: number) => Promise<SessionHistoryItemsResponse>,
) {
    const envelopeBytes = Buffer.byteLength(JSON.stringify({jsonrpc: "2.0", id: requestId, result: null})) - 4;
    const resultBytes = FRAME_BYTES - envelopeBytes;
    for (let count = continuation ? 1 : limit; ; count = Math.floor(count / 2)) {
        const page = await read(count);
        const json = JSON.stringify(page);
        if (!continuation && Buffer.byteLength(json) <= resultBytes) return page;
        if (page.items.length > 1 && count > 1) continue;
        if (page.items.length !== 1) throw historyError("history_invalid_page", "Invalid oversized history page", false);
        const item = Buffer.from(JSON.stringify(page.items[0]));
        const digest = createHash("sha256").update(item).digest("hex");
        const part = continuation ? Number(continuation.split(":")[1]) : 0;
        const offset = part * PART_BYTES;
        if ((continuation && continuation !== digest + ":" + part) || !Number.isSafeInteger(offset) || offset < 0 || offset >= item.length)
            throw historyError("history_changed", "History item changed during transfer; retry this page", true);
        const end = Math.min(offset + PART_BYTES, item.length);
        const result = {...page, items: [], fragment: item.subarray(offset, end).toString("base64"),
            fragmentDigest: digest, fragmentPart: part, nextFragment: end < item.length ? digest + ":" + (part + 1) : null};
        if (Buffer.byteLength(JSON.stringify(result)) > resultBytes)
            throw historyError("history_page_too_large", "History metadata exceeds the transport frame", false);
        return result;
    }
}
