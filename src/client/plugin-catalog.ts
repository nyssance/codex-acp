import type {PluginListParams, PluginListResponse} from "../app-server/v2";
import {CATALOG_CHUNK_BYTES, MAX_CATALOG_BYTES, type CatalogPage} from "../catalog-protocol";

/** Reassemble exact JSON bytes, including UTF-8 characters split across transport chunks. */
export async function readPluginCatalog(
    request: (params: Record<string, unknown>) => Promise<CatalogPage>, query: PluginListParams,
): Promise<PluginListResponse> {
    const parts: string[] = [];
    const decoder = new TextDecoder("utf-8", {fatal: true});
    const cursors = new Set<string>();
    let cursor: string | null = null;
    let total: number | null = null;
    let received = 0;
    do {
        const page = await request(cursor === null ? {query} : {cursor});
        if (!page || page.encoding !== "base64-json" || typeof page.data !== "string" || page.data.length > 4 * Math.ceil(CATALOG_CHUNK_BYTES / 3) || (page.nextCursor !== null && typeof page.nextCursor !== "string") || !Number.isSafeInteger(page.totalBytes) || page.totalBytes <= 0 || page.totalBytes > MAX_CATALOG_BYTES || (total !== null && total !== page.totalBytes))
            throw new Error("Invalid catalog page length or encoding");
        total = page.totalBytes;
        const raw = atob(page.data);
        if (!raw.length || received + raw.length > total) throw new Error("Invalid catalog page length");
        const bytes = Uint8Array.from(raw, character => character.charCodeAt(0));
        received += bytes.length;
        parts.push(decoder.decode(bytes, {stream: page.nextCursor !== null}));
        cursor = page.nextCursor;
        if (cursor !== null) {
            if (!cursor || cursors.has(cursor)) throw new Error("Catalog cursor made no progress");
            cursors.add(cursor);
        }
    } while (cursor !== null);
    if (received !== total) throw new Error("Incomplete catalog byte length");
    const result: unknown = JSON.parse(parts.join(""));
    if (!result || typeof result !== "object" || !Array.isArray((result as PluginListResponse).marketplaces) || !Array.isArray((result as PluginListResponse).marketplaceLoadErrors) || !Array.isArray((result as PluginListResponse).featuredPluginIds))
        throw new Error("Invalid plugin catalog result");
    return result as PluginListResponse;
}
