// Config revision binding (alwith-cli 2.9.77+, codex-acp-v2 0.7.20+): the agent numbers each session's config options,
// a prompt may carry the revision the user saw, and the agent refuses the prompt with `config/stale` when a write landed
// in between, handing the actual options back beside the refusal.
import type * as acp from "@agentclientprotocol/sdk/experimental/v2/unstable";

import type { Session } from "./session";

/** `_meta.alwith.configRevision` of a session response or a `config_option_update`, or null. */
export function configRevisionOf(
    carrier: { _meta?: unknown } | null | undefined,
): number | null {
    const alwith = (
        carrier?._meta as
            { alwith?: { configRevision?: unknown } } | null | undefined
    )?.alwith;
    return typeof alwith?.configRevision === "number"
        ? alwith.configRevision
        : null;
}

/** Whether the agent numbers config revisions and checks `expectedConfigRevision` on prompts. */
export function supportsConfigRevision(
    initialized: acp.InitializeResponse,
): boolean {
    const alwith = (
        initialized.capabilities?._meta as
            { alwith?: { configRevision?: unknown } } | undefined
    )?.alwith;
    return (
        typeof alwith?.configRevision === "object" &&
        alwith.configRevision !== null
    );
}

/** What a prompt's `_meta.alwith` carries to bind it to the config the user saw: nothing when the agent cannot check. */
export function promptConfigMeta(
    initialized: acp.InitializeResponse,
    session: Session,
): { expectedConfigRevision?: number } {
    return supportsConfigRevision(initialized) &&
        session.configRevision !== null
        ? { expectedConfigRevision: session.configRevision }
        : {};
}

export type ConfigStale = {
    expected: number;
    actual: number;
    configOptions: acp.SessionConfigOption[];
};

/** The agent refused a prompt because the config moved on (`error.data.alwith.configStale`), or null for any other error. */
export function configStaleOf(error: unknown): ConfigStale | null {
    const data = (error as { data?: unknown } | null)?.data;
    const stale = (
        data as { alwith?: { configStale?: unknown } } | null | undefined
    )?.alwith?.configStale;
    if (stale === undefined || stale === null) return null;
    const { expected, actual, configOptions } = stale as Partial<ConfigStale>;
    if (
        typeof expected !== "number" ||
        typeof actual !== "number" ||
        !Array.isArray(configOptions)
    )
        throw new Error(
            `malformed config/stale refusal: ${JSON.stringify(stale)}`,
        );
    return { expected, actual, configOptions };
}

/** The prompt was refused because the session's config moved on; `session` already holds the agent's actual options. */
export class ConfigStaleError extends Error {
    readonly stale: ConfigStale;
    constructor(stale: ConfigStale) {
        super(
            `The session's configuration changed (revision ${stale.expected} → ${stale.actual}) before this message was sent`,
        );
        this.name = "ConfigStaleError";
        this.stale = stale;
    }
}
