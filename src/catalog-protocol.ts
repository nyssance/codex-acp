/** Byte budgets include JSON-RPC framing; catalog chunks leave room for the envelope. */
export const MAX_ACP_RESPONSE_BYTES = 32 * 1024 * 1024;
export const PLUGIN_CATALOG_PAGE_METHOD = "_codex/plugin_list_page";
export const CATALOG_CHUNK_BYTES = 512 * 1024;
export const MAX_CATALOG_BYTES = 128 * 1024 * 1024;

export type CatalogPage = {
    encoding: "base64-json";
    data: string;
    totalBytes: number;
    nextCursor: string | null;
};
