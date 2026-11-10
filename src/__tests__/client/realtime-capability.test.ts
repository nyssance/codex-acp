import type * as acp from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {expect, it} from "vitest";
import {supportsCodexRealtime} from "../../client/CodexCapabilitiesClient";
const info = {name: "codex-acp", version: "test"};
const initialized = (codex: unknown): acp.InitializeResponse => ({
    protocolVersion: 2,
    info,
    capabilities: {_meta: {codex}},
});
it("offers voice only for a supported initialized realtime contract", () => {
    expect(supportsCodexRealtime(null)).toBe(false);
    expect(supportsCodexRealtime({protocolVersion: 2, info, capabilities: {}})).toBe(false);
    expect(supportsCodexRealtime(initialized({realtime: true}))).toBe(false);
    expect(supportsCodexRealtime(initialized({realtime: {version: 2}}))).toBe(false);
    expect(supportsCodexRealtime(initialized({realtime: {version: 1}}))).toBe(true);
});
