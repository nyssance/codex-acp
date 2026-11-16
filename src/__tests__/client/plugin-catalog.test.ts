import {expect, it, vi} from "vitest";
import {CodexClient} from "../../client/CodexClient";

it.each([false, true])("keeps listPlugins compatible while selecting advertised paging (%s)", async paged => {
    const catalog = {marketplaces: [], marketplaceLoadErrors: [], featuredPluginIds: ["one"]};
    const text = JSON.stringify(catalog);
    const request = vi.fn(async () => paged ? {encoding: "base64-json", data: btoa(text), totalBytes: text.length, nextCursor: null} : catalog);
    const codex = new CodexClient(() => Promise.reject(new Error("not connected")), {agentId: "agent", launch: {engine: "codex"}});
    Object.assign(codex, {live: () => ({request})});
    (codex as unknown as {set(patch: Record<string, unknown>): void}).set({agent: {
        protocolVersion: 2, capabilities: {_meta: {codex: paged ? {pluginCatalogPages: {version: 1}} : {}}},
    }});
    await expect(codex.listPlugins({cwds: ["/work"]})).resolves.toEqual(catalog);
    expect(request).toHaveBeenCalledWith(paged ? "_codex/plugin_list_page" : "_codex/plugin_list", paged ? {query: {cwds: ["/work"]}} : {cwds: ["/work"]});
});
