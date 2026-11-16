import {describe, expect, it, vi} from "vitest";
import {RequestError} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {ResponseError} from "vscode-jsonrpc";
import {AppServerConnectionLostError} from "../app-server-recovery/ConnectionLoss";
import {isConnectionDeathError} from "../app-server-recovery/AppServerRecovery";
import {boundedResponse} from "../alwith/responseBudget";
import {CatalogPages} from "../alwith/CatalogPages";
import {readPluginCatalog} from "../client/plugin-catalog";

describe("bounded catalog transport", () => {
    it("rejects an escaped oversized response per request and accepts the next response", async () => {
        await expect(boundedResponse("one", "_codex/plugin_list", async () => ({value: "\n".repeat(17 * 1024 * 1024)})))
            .rejects.toMatchObject({data: {reason: "catalog_response_too_large", method: "_codex/plugin_list", limitBytes: 33554432}});
        await expect(boundedResponse("two", "_codex/account_read", async () => ({ok: true}))).resolves.toEqual({ok: true});
    });

    it("preserves a multi-page catalog including a single large multibyte field", async () => {
        const catalog = {marketplaces: [{name: "test", path: null, interface: null, plugins: [{id: "one", description: "界😀\n".repeat(300000)}]}], marketplaceLoadErrors: [], featuredPluginIds: ["one"]};
        const pages = new CatalogPages();
        let upstreamReads = 0;
        let requests = 0;
        const result = await readPluginCatalog(async (params) => {
            requests++;
            const page = await pages.read(params, async () => { upstreamReads++; return catalog; });
            expect(Buffer.byteLength(JSON.stringify({jsonrpc: "2.0", id: "one", result: page}))).toBeLessThan(1024 * 1024);
            return page;
        }, {cwds: ["/work"]});
        expect(result).toEqual(catalog);
        expect(requests).toBeGreaterThan(1);
        expect(upstreamReads).toBe(1);
    });

    it("rejects invalid cursors and continuation query changes without a new upstream read", async () => {
        const pages = new CatalogPages();
        let reads = 0;
        const load = async () => { reads++; return {value: "x".repeat(1024 * 1024)}; };
        const first = await pages.read({}, load);
        await expect(pages.read({cursor: first.nextCursor, query: {forceRefetch: true}}, load)).rejects.toMatchObject({code: -32602});
        await expect(pages.read({cursor: "invalid"}, load)).rejects.toMatchObject({code: -32602});
        expect(reads).toBe(1);
    });

    it("does not accept incomplete or repeated pages as a complete catalog", async () => {
        const page = {encoding: "base64-json" as const, data: btoa("{}"), totalBytes: 3, nextCursor: null};
        await expect(readPluginCatalog(async () => page, {})).rejects.toThrow(/length/i);
        await expect(readPluginCatalog(async () => ({...page, totalBytes: 4, nextCursor: "same"}), {})).rejects.toThrow(/cursor/i);
    });
});

it("bounds concurrent catalog fetches before the upstream requests complete", async () => {
    const pages = new CatalogPages();
    const releases: Array<(value: unknown) => void> = [];
    const pending = Array.from({length: 4}, () => pages.read({}, () => new Promise(resolve => releases.push(resolve))));
    let rejected = false;
    try { await pages.read({}, async () => ({})); } catch (error) {
        expect(error).toMatchObject({data: {reason: "catalog_busy"}});
        rejected = true;
    } finally {
        for (const release of releases) release({value: "small"});
        await Promise.all(pending);
    }
    expect(rejected).toBe(true);
});

it("expires abandoned catalog cursors and permits a fresh traversal", async () => {
    vi.useFakeTimers();
    try {
        const pages = new CatalogPages();
        const load = async () => ({value: "x".repeat(1024 * 1024)});
        const first = await pages.read({}, load);
        await vi.advanceTimersByTimeAsync(60001);
        await expect(pages.read({cursor: first.nextCursor}, load)).rejects.toMatchObject({data: {reason: "catalog_snapshot_expired", retryable: true}});
        expect((await pages.read({}, load)).nextCursor).not.toBeNull();
    } finally { vi.useRealTimers(); }
});

it("includes the actual request ID and escaped multibyte content in the response budget", async () => {
    const overhead = Buffer.byteLength(JSON.stringify({jsonrpc: "2.0", id: 1, result: ""}));
    const value = "x".repeat(33554432 - overhead);
    await expect(boundedResponse(1, "_codex/plugin_list", async () => value)).resolves.toHaveLength(value.length);
    await expect(boundedResponse("longer-id", "_codex/plugin_list", async () => value)).rejects.toMatchObject({data: {reason: "catalog_response_too_large"}});
    await expect(boundedResponse(1, "_codex/plugin_list", async () => "界".repeat(12 * 1024 * 1024))).rejects.toMatchObject({data: {reason: "catalog_response_too_large"}});
});

it("reports only field byte counts for a catalog larger than the transport budget", async () => {
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
        await new CatalogPages().read({}, async () => ({marketplaces: ["private".repeat(5 * 1024 * 1024)], marketplaceLoadErrors: [], featuredPluginIds: []}));
        expect(diagnostic).toHaveBeenCalledTimes(1);
        const line = String(diagnostic.mock.calls[0]?.[0]);
        expect(line.length).toBeLessThan(1024);
        expect(line).not.toContain("private");
        const value = JSON.parse(line.slice("[alwith-catalog-size] ".length));
        expect(value.fieldBytes.marketplaces).toBeGreaterThan(33554432);
        expect(value.limitBytes).toBe(33554432);
    } finally { diagnostic.mockRestore(); }
});

for (const createError of [
    (message: string) => new Error(message),
    (message: string) => new ResponseError(-32001, message),
]) {
    it("budgets the SDK error envelope at the transport boundary", async () => {
        const overhead = Buffer.byteLength(JSON.stringify({jsonrpc: "2.0", id: 1, ...RequestError.internalError({details: ""}).toResult()}));
        const message = "x".repeat(33554432 - overhead + 1);
        let reason: unknown;
        try { await boundedResponse(1, "_codex/plugin_list", async () => { throw createError(message); }); }
        catch (error) { reason = (error as RequestError).data; }
        expect(reason).toMatchObject({reason: "catalog_response_too_large", bytes: 33554433});
        await expect(boundedResponse(2, "_codex/account_read", async () => ({account: null}))).resolves.toEqual({account: null});
    });
}

it.each([
    new AppServerConnectionLostError("plugin/list"),
    new ResponseError(-32097, "Pending response rejected since connection got disposed"),
])("preserves original connection errors for recovery", async error => {
    expect(isConnectionDeathError(error)).toBe(true);
    await expect(boundedResponse(1, "_codex/plugin_list", async () => { throw error; })).rejects.toBe(error);
});

it("preserves original validation and cancellation errors below the budget", async () => {
    const invalid = {name: "ZodError", issues: [], format: () => ({invalid: true})};
    await expect(boundedResponse(1, "_codex/plugin_list", async () => { throw invalid; })).rejects.toBe(invalid);
    const controller = new AbortController();
    controller.abort("cancelled by caller");
    const error = new DOMException("aborted", "AbortError");
    await expect(boundedResponse(2, "_codex/plugin_list", async () => { throw error; }, controller.signal)).rejects.toBe(error);
});

it("reports temporary snapshot memory pressure as retryable and recovers after release", async () => {
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
        const pages = new CatalogPages();
        const load = async () => ({value: "x".repeat(34 * 1024 * 1024)});
        let first = await pages.read({}, load);
        await pages.read({}, load);
        await pages.read({}, load);
        await expect(pages.read({}, load)).rejects.toMatchObject({data: {reason: "catalog_busy", retryable: true}});
        while (first.nextCursor) first = await pages.read({cursor: first.nextCursor}, load);
        expect((await pages.read({}, load)).nextCursor).not.toBeNull();
    } finally { diagnostic.mockRestore(); }
});

it("keeps a progressing traversal alive beyond one minute", async () => {
    vi.useFakeTimers();
    try {
        const pages = new CatalogPages();
        let page = await pages.read({}, async () => ({value: "x".repeat(9 * 1024 * 1024)}));
        while (page.nextCursor) {
            await vi.advanceTimersByTimeAsync(5000);
            page = await pages.read({cursor: page.nextCursor}, async () => { throw new Error("Unexpected reload"); });
        }
        expect(page.nextCursor).toBeNull();
    } finally { vi.useRealTimers(); }
});

it("bounds the absolute lifetime even when a traversal is active", async () => {
    vi.useFakeTimers();
    try {
        const pages = new CatalogPages();
        let page = await pages.read({}, async () => ({value: "x".repeat(9 * 1024 * 1024)}));
        for (let i = 0; i < 9; i++) {
            await vi.advanceTimersByTimeAsync(30000);
            page = await pages.read({cursor: page.nextCursor}, async () => ({}));
        }
        await vi.advanceTimersByTimeAsync(30000);
        await expect(pages.read({cursor: page.nextCursor}, async () => ({}))).rejects.toMatchObject({data: {reason: "catalog_snapshot_expired"}});
    } finally { vi.useRealTimers(); }
});
