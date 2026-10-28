import { describe, expect, test } from "bun:test";

import type * as acp from "@agentclientprotocol/sdk/experimental/v2/unstable";

import {
    configRevisionOf,
    ConfigStaleError,
    configStaleOf,
    promptConfigMeta,
    supportsConfigRevision,
} from "../config";
import { applyUpdate, createSession } from "../session";

const agent = (revisions: boolean): acp.InitializeResponse => ({
    protocolVersion: 2,
    info: { name: "alwith-cli", version: "2.9.77" },
    capabilities: revisions
        ? { _meta: { alwith: { configRevision: { version: 1 } } } }
        : {},
});

describe("config revision binding", () => {
    test("the session follows the revision the agent stamps on config updates and a prompt binds to it only when the agent can check", () => {
        let session = createSession("s", "/tmp");
        expect(session.configRevision).toBeNull();
        expect(promptConfigMeta(agent(true), session)).toEqual({});
        session = applyUpdate(session, {
            sessionUpdate: "config_option_update",
            configOptions: [],
            _meta: { alwith: { configRevision: 3 } },
        });
        expect(session.configRevision).toBe(3);
        expect(promptConfigMeta(agent(true), session)).toEqual({
            expectedConfigRevision: 3,
        });
        expect(promptConfigMeta(agent(false), session)).toEqual({});
        expect(supportsConfigRevision(agent(false))).toBe(false);
        expect(
            configRevisionOf({ _meta: { alwith: { configRevision: 7 } } }),
        ).toBe(7);
        expect(configRevisionOf({})).toBeNull();
        // An update without a revision (an agent that does not number them) leaves the known revision alone.
        session = applyUpdate(session, {
            sessionUpdate: "config_option_update",
            configOptions: [],
        });
        expect(session.configRevision).toBe(3);
    });

    test("a config/stale refusal is recognised by its data and nothing else", () => {
        const stale = { expected: 3, actual: 4, configOptions: [] };
        expect(
            configStaleOf({
                code: -32602,
                message: "config/stale",
                data: { alwith: { configStale: stale } },
            }),
        ).toEqual(stale);
        expect(
            configStaleOf({
                code: -32602,
                message: "Invalid params",
                data: { model: "x" },
            }),
        ).toBeNull();
        expect(configStaleOf(new Error("boom"))).toBeNull();
        expect(() =>
            configStaleOf({
                data: { alwith: { configStale: { expected: 1 } } },
            }),
        ).toThrow("malformed config/stale");
        expect(new ConfigStaleError(stale).message).toContain("revision 3 → 4");
    });
});
