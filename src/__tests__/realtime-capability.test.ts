import { expect, it } from "vitest";
import { supportsCodexRealtime } from "../CodexCapabilitiesClient";
it("offers voice only for a supported initialized realtime contract", () => {
    expect(supportsCodexRealtime(null)).toBe(false);
    expect(supportsCodexRealtime({ capabilities: {} })).toBe(false);
    expect(
        supportsCodexRealtime({
            capabilities: { _meta: { codex: { realtime: true } } },
        }),
    ).toBe(false);
    expect(
        supportsCodexRealtime({
            capabilities: { _meta: { codex: { realtime: { version: 2 } } } },
        }),
    ).toBe(false);
    expect(
        supportsCodexRealtime({
            capabilities: { _meta: { codex: { realtime: { version: 1 } } } },
        }),
    ).toBe(true);
});
