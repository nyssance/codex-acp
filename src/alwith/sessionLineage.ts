import type {CodexAppServerClient} from "../CodexAppServerClient";
import type {Thread, Turn} from "../app-server/v2";
import type {SessionMetadata} from "../SessionMetadata";

/** Native forks retain turn IDs, so provenance survives adapter and Codex restarts. */
export async function readSessionLineage(
    client: Pick<CodexAppServerClient, "threadTurnsList">,
    thread: Pick<Thread, "id" | "sessionId" | "forkedFromId"> & { projectId?: string | null },
): Promise<NonNullable<SessionMetadata["lineage"]>> {
    const lineage = {projectId: thread.projectId ?? null, nativeSessionId: thread.sessionId, forkedFromId: thread.forkedFromId};
    if (thread.forkedFromId == null) return lineage;

    async function* pages(threadId: string, sortDirection: "asc" | "desc"): AsyncGenerator<Turn[]> {
        let cursor: string | null = null;
        const seen = new Set<string>();
        do {
            const page = await client.threadTurnsList({threadId, cursor, limit: 100, sortDirection, itemsView: "summary"});
            yield page.data;
            cursor = page.nextCursor;
            if (cursor !== null) {
                if (seen.has(cursor)) throw new Error("Codex fork history repeated a pagination cursor");
                seen.add(cursor);
            }
        } while (cursor !== null);
    }

    const parentTurns = new Set<string>();
    for await (const turns of pages(thread.forkedFromId, "asc")) {
        for (const turn of turns) parentTurns.add(turn.id);
    }
    // The latest shared turn is the boundary, even after either branch continues.
    for await (const turns of pages(thread.id, "desc")) {
        for (const turn of turns) {
            if (parentTurns.has(turn.id)) return {...lineage, forkedAtTurnId: turn.id};
        }
    }
    return {...lineage, forkedAtTurnId: null};
}
