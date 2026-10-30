import {
    RequestError,
    type SessionConfigOption,
} from "@agentclientprotocol/sdk/experimental/v2/unstable";

/** A version of the advertised options, scoped to the actual installed session object. */
export class ConfigRevisions {
    private readonly versions = new WeakMap<
        object,
        { fingerprint: string; revision: number }
    >();

    read(
        session: object,
        configOptions: SessionConfigOption[],
    ): { configRevision: number; configOptions: SessionConfigOption[] } {
        const fingerprint = JSON.stringify(configOptions);
        const previous = this.versions.get(session);
        const revision = previous
            ? previous.revision + Number(previous.fingerprint !== fingerprint)
            : 0;
        this.versions.set(session, { fingerprint, revision });
        return { configRevision: revision, configOptions };
    }

    assert(
        meta: Record<string, unknown> | null | undefined,
        snapshot: ReturnType<ConfigRevisions["read"]>,
    ): void {
        const alwith = meta?.["alwith"] as
            { expectedConfigRevision?: unknown } | undefined;
        const expected = alwith?.expectedConfigRevision;
        if (expected === undefined) return;
        if (
            typeof expected !== "number" ||
            !Number.isSafeInteger(expected) ||
            expected < 0
        ) {
            throw RequestError.invalidParams(
                undefined,
                "_meta.alwith.expectedConfigRevision must be a nonnegative integer",
            );
        }
        if (expected !== snapshot.configRevision)
            throw RequestError.invalidParams(
                {
                    alwith: {
                        configStale: {
                            expected,
                            actual: snapshot.configRevision,
                            configOptions: snapshot.configOptions,
                        },
                    },
                },
                "config/stale",
            );
    }
}
