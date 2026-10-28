import {expect, test} from "vitest";
import type {ThreadTurnsListParams, ThreadTurnsListResponse, Turn} from "../app-server/v2";
import {readSessionLineage} from "../alwith/sessionLineage";

function history(threads: Record<string, string[]>) {
    const requests: ThreadTurnsListParams[] = [];
    return {
        requests,
        async threadTurnsList(request: ThreadTurnsListParams): Promise<ThreadTurnsListResponse> {
            requests.push(request);
            expect(request.itemsView).toBe("summary");
            const turns = [...threads[request.threadId]!];
            if (request.sortDirection === "desc") turns.reverse();
            const offset = Number(request.cursor ?? 0);
            return {
                backwardsCursor: null,
                data: turns.slice(offset, offset + 2).map((id): Turn => ({
                    id, rootTurnId: null, items: [], itemsView: "summary", status: "completed",
                    error: null, startedAt: null, completedAt: null, durationMs: null,
                })),
                nextCursor: offset + 2 < turns.length ? String(offset + 2) : null,
            };
        },
    };
}

const fork = {id: "child", sessionId: "native-child", forkedFromId: "parent"};

test("restores the persisted boundary across pages after the parent and child diverge", async () => {
    const persisted = {
        parent: ["t1", "t2", "t3", "parent-later"],
        child: ["t1", "t2", "child-1", "child-2", "child-3"],
    };
    const client = history(persisted);
    expect(await readSessionLineage(client, fork)).toEqual({
        projectId: null, nativeSessionId: "native-child", forkedFromId: "parent", forkedAtTurnId: "t2",
    });
    // A fresh client has no in-memory fork request or replay state.
    expect(await readSessionLineage(history(persisted), fork)).toEqual(await readSessionLineage(client, fork));
    expect(client.requests.some(request => request.threadId === "child" && request.cursor !== null)).toBe(true);
});

test("nested forks use their immediate parent and preserve the selected older boundary", async () => {
    const client = history({parent: ["root-1", "root-2", "parent-1"], child: ["root-1", "own-1"]});
    expect((await readSessionLineage(client, fork)).forkedAtTurnId).toBe("root-1");
});

test("root sessions do not read history and empty forks expose a null boundary", async () => {
    const client = history({parent: ["p"], child: []});
    expect(await readSessionLineage(client, {...fork, forkedFromId: null})).toEqual({
        projectId: null, nativeSessionId: "native-child", forkedFromId: null,
    });
    expect(client.requests).toHaveLength(0);
    expect((await readSessionLineage(client, fork)).forkedAtTurnId).toBeNull();
});

test.each(["parent", "child"])("repeated %s cursors fail instead of hanging", async repeated => {
    const client = {
        async threadTurnsList(request: ThreadTurnsListParams): Promise<ThreadTurnsListResponse> {
            return {backwardsCursor: null, data: [], nextCursor: request.threadId === repeated ? "loop" : null};
        },
    };
    await expect(readSessionLineage(client, fork)).rejects.toThrow("repeated a pagination cursor");
});

test("history failures are not misreported as a fork with no inherited turns", async () => {
    await expect(readSessionLineage({threadTurnsList: async () => {
        throw new Error("History unavailable");
    }}, fork)).rejects.toThrow("History unavailable");
});
