import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import {
    nativeHistoryMetadata,
    nativeThreadSource,
} from "../alwith/agent/forkIndex";
import { readSessionLineage } from "../alwith/sessionLineage";

const id = "01900000-0000-7000-8000-000000000001";
const archivedId = "01900000-0000-7000-8000-000000000002";

test("listing and resume recover saved sources without reading transcripts or creating an index", async () => {
    const home = await mkdtemp(join(tmpdir(), "native-source-"));
    try {
        await mkdir(join(home, "sessions"));
        await mkdir(join(home, "archived_sessions"));
        const file = join(home, "sessions", "rollout-images.jsonl");
        const header = (id: string) =>
            JSON.stringify({
                type: "session_meta",
                payload: {
                    id,
                    source: "vscode",
                    cwd: "/workspace",
                    thread_source: "alwith-images",
                },
            });
        await writeFile(
            file,
            header(id) + "\nthis transcript must not be parsed\n",
        );
        await writeFile(
            join(home, "archived_sessions", "rollout-images.jsonl"),
            header(archivedId) + "\n",
        );
        const read = vi.fn(async () => {
            throw new Error(
                "Source-only discovery must not attach or read a thread",
            );
        });
        const active = await nativeHistoryMetadata(home, false, null, read);
        expect(active.sources).toEqual(new Map([[id, "alwith-images"]]));
        expect(active.forks).toEqual([]);
        expect(read).not.toHaveBeenCalled();
        expect(
            (await nativeHistoryMetadata(home, true, null, read)).sources,
        ).toEqual(new Map([[archivedId, "alwith-images"]]));
        const lineage = await readSessionLineage(
            { threadTurnsList: vi.fn() },
            {
                id,
                sessionId: id,
                forkedFromId: null,
                threadSource: null,
                path: file,
            },
        );
        expect(lineage.threadSource).toBe("alwith-images");
        expect(await nativeThreadSource(file, archivedId)).toBeNull();
        await writeFile(file, "{partial");
        expect(await nativeThreadSource(file, id)).toBeNull();
        await rm(file);
        expect(await nativeThreadSource(file, id)).toBeNull();
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});
