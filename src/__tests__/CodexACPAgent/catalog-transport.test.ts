import {ResponseError} from "vscode-jsonrpc";
import {expect, it} from "vitest";
import {connectSession} from "./v2-prompt-harness";

it("rejects an oversized catalog over ACP while the same connection remains usable", async () => {
    const h = await connectSession(2, {codexResponses: {
        "plugin/list": async () => ({marketplaces: [], marketplaceLoadErrors: [], featuredPluginIds: [], extra: "x".repeat(33 * 1024 * 1024)}),
        "account/read": async () => ({account: null}),
    }});
    try {
        await expect(h.request("_codex/plugin_list", {})).rejects.toMatchObject({data: {reason: "catalog_response_too_large"}});
        await expect(h.request("_codex/account_read", {})).resolves.toEqual({account: null});
        const first = await h.request("_codex/plugin_list_page", {query: {}});
        expect(first).toMatchObject({encoding: "base64-json", totalBytes: expect.any(Number), nextCursor: expect.any(String)});
    } finally { h.connection.close(); }
});

for (const native of [false, true]) {
    it(`keeps ACP usable after an oversized ${native ? "native" : "ordinary"} error`, async () => {
        const h = await connectSession(2, {codexResponses: {
            "plugin/list": async () => {
                const message = "x".repeat(32 * 1024 * 1024);
                throw native ? new ResponseError(-32001, message) : new Error(message);
            },
            "account/read": async () => ({account: null}),
        }});
        try {
            await expect(h.request("_codex/plugin_list", {})).rejects.toMatchObject({data: {reason: "catalog_response_too_large"}});
            await expect(h.request("_codex/account_read", {})).resolves.toEqual({account: null});
        } finally { h.connection.close(); }
    });
}
