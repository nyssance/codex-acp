import * as acp from "@agentclientprotocol/sdk/experimental/v2/unstable";
import type { CodexAppServerClient } from "../../CodexAppServerClient";
import { nativeHistoryMetadata } from "./forkIndex";
import { sessionTitle } from "./historyTitle";
const run = <T>(operation: () => Promise<T>): Promise<T> => operation();
/**
 * `session/list` and the full `_codex/session_list`, with the ACP `archived` filter. Codex lists
 * archived and other threads separately; `include` reads the other threads, then the archive, and
 * its cursor names which of the two the next page comes from.
 */
export async function readSessionList(
    client: CodexAppServerClient,
    params: acp.ListSessionsRequest,
    all: boolean,
): Promise<acp.ListSessionsResponse> {
    if (
        (params.cwd !== undefined &&
            params.cwd !== null &&
            typeof params.cwd !== "string") ||
        (params.cursor !== undefined &&
            params.cursor !== null &&
            typeof params.cursor !== "string")
    ) {
        throw acp.RequestError.invalidParams(
            undefined,
            "Expected string cwd and cursor",
        );
    }
    const filter = params.archived ?? "exclude";
    if (filter !== "exclude" && filter !== "only" && filter !== "include")
        throw acp.RequestError.invalidParams(
            undefined,
            "Expected archived to be exclude, include or only",
        );
    const cwd = params.cwd?.trim() || null;
    const cursor = params.cursor ?? null;
    if (filter !== "include")
        return readListPage(client, cwd, cursor, all, filter === "only");
    if (all) {
        const current = await readListPage(client, cwd, null, true, false);
        const archived = await readListPage(client, cwd, null, true, true);
        return { sessions: [...current.sessions, ...archived.sessions] };
    }
    const position = cursor === null ? { archived: false, cursor: null } : decodeIncludeCursor(cursor);
    const page = await readListPage(client, cwd, position.cursor, false, position.archived);
    const next =
        page.nextCursor != null
            ? { archived: position.archived, cursor: page.nextCursor }
            : position.archived
              ? null
              : { archived: true, cursor: null };
    return {
        sessions: page.sessions,
        nextCursor:
            next === null
                ? null
                : Buffer.from(JSON.stringify(next)).toString("base64url"),
    };
}

function decodeIncludeCursor(raw: string): {
    archived: boolean;
    cursor: string | null;
} {
    let value: unknown;
    try {
        value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    } catch {
        throw acp.RequestError.invalidParams(undefined, "Invalid session list cursor");
    }
    const position = value as { archived?: unknown; cursor?: unknown } | null;
    if (
        typeof position?.archived !== "boolean" ||
        (position.cursor !== null && typeof position.cursor !== "string")
    )
        throw acp.RequestError.invalidParams(undefined, "Invalid session list cursor");
    return { archived: position.archived, cursor: position.cursor };
}

async function readListPage(
    client: CodexAppServerClient,
    cwd: string | null,
    cursor: string | null,
    all: boolean,
    archived: boolean,
): Promise<acp.ListSessionsResponse> {
    const list = (cursor: string | null) =>
        run(() =>
            client.threadList({
                cursor,
                ...(all ? { limit: 100 } : {}),
                ...(cwd ? { cwd } : {}),
                sourceKinds: ["cli", "vscode", "exec", "appServer", "unknown"],
                // Omitting this lets Codex hide threads created through another gateway.
                modelProviders: [],
                // Codex lists non-archived threads by default; the archive is a separate page.
                ...(archived ? { archived: true } : {}),
            }),
        );
    const response = await list(cursor);
    if (all) {
        const threads = new Map(
            response.data.map((thread) => [thread.id, thread]),
        );
        const cursors = new Set<string>();
        while (response.nextCursor !== null) {
            const pageCursor = response.nextCursor;
            if (cursors.has(pageCursor))
                throw acp.RequestError.internalError(
                    undefined,
                    "Codex thread list repeated a cursor",
                );
            cursors.add(pageCursor);
            const page = await list(pageCursor);
            for (const thread of page.data) threads.set(thread.id, thread);
            response.nextCursor = page.nextCursor;
        }
        response.data = [...threads.values()];
    }
    const home = client.getCodexHome();
    if (home === null)
        throw acp.RequestError.internalError(
            undefined,
            "Codex home is unavailable after initialize",
        );
    const { forks, sources } = await run(() =>
        nativeHistoryMetadata(
            home,
            archived,
            cwd,
            async (id) =>
                (await client.threadRead({ threadId: id, includeTurns: false }))
                    .thread,
        ),
    );
    const byId = new Map(forks.map((thread) => [thread.id, thread]));
    // Native list rows can lose forkedFromId after unload; thread/read retains the rollout lineage.
    response.data = response.data.map(
        (thread) => byId.get(thread.id) ?? thread,
    );
    if (cursor === null) {
        const missing = new Map(byId);
        for (const thread of response.data) missing.delete(thread.id);
        // thread/read may hydrate a non-empty preview while the native list index still
        // excludes it. Check actual pages, not the hydrated preview; avoid duplicate rows.
        let next = response.nextCursor;
        const cursors = new Set<string>();
        while (missing.size > 0 && next !== null) {
            if (cursors.has(next))
                throw acp.RequestError.internalError(
                    undefined,
                    "Codex thread list repeated a cursor",
                );
            cursors.add(next);
            const page = await list(next);
            for (const thread of page.data) missing.delete(thread.id);
            next = page.nextCursor;
        }
        response.data.push(...missing.values());
    }
    const sessions: acp.SessionInfo[] = [];
    // Full listings can need many title repairs; bound their history reads.
    const batchSize = all ? 8 : response.data.length;
    for (let offset = 0; offset < response.data.length; offset += batchSize) {
        sessions.push(
            ...(await Promise.all(
                response.data
                    .slice(offset, offset + batchSize)
                    .map(async (thread) => ({
                        sessionId: thread.id,
                        cwd: thread.cwd,
                        title: await sessionTitle(client, thread),
                        updatedAt: new Date(
                            thread.updatedAt * 1000,
                        ).toISOString(),
                        archived,
                        _meta: {
                            codex: {
                                projectId: thread.projectId ?? null,
                                ...((thread.threadSource ??
                                    sources.get(thread.id)) != null
                                    ? {
                                          threadSource:
                                              thread.threadSource ??
                                              sources.get(thread.id)!,
                                      }
                                    : {}),
                                nativeSessionId: thread.sessionId,
                                forkedFromId: thread.forkedFromId,
                            },
                        },
                    })),
            )),
        );
    }
    return all ? { sessions } : { sessions, nextCursor: response.nextCursor };
}
