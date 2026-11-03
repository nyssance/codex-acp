import { createReadStream } from "node:fs";
import { readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

import type { Thread } from "../../app-server/v2";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCES = new Set(["cli", "vscode", "exec", "appServer", "unknown"]);
const missing = (error: unknown): boolean =>
    (error as NodeJS.ErrnoException)?.code === "ENOENT";

/** Native listings omit empty forks and can omit persisted thread sources.
 * Read the existing rollout headers once for both, without writing an index.
 */
export async function nativeHistoryMetadata(
    codexHome: string,
    archived: boolean,
    cwd: string | null,
    read: (id: string) => Promise<Thread>,
): Promise<{ forks: Thread[]; sources: Map<string, string> }> {
    const root = path.join(
        codexHome,
        archived ? "archived_sessions" : "sessions",
    );
    const wantedCwd =
        cwd === null
            ? null
            : await realpath(cwd).catch((error) => {
                  if (missing(error)) return cwd;
                  throw error;
              });
    const result: Thread[] = [];
    const sources = new Map<string, string>();
    for await (const file of rolloutFiles(root)) {
        const meta = await nativeHeader(file);
        if (
            !meta ||
            typeof meta["id"] !== "string" ||
            !UUID.test(meta["id"]) ||
            typeof meta["source"] !== "string" ||
            !SOURCES.has(meta["source"]) ||
            (wantedCwd !== null &&
                meta["cwd"] !== wantedCwd &&
                meta["cwd"] !== cwd)
        )
            continue;
        if (
            typeof meta["thread_source"] === "string" &&
            meta["thread_source"].length > 0
        )
            sources.set(meta["id"], meta["thread_source"]);
        if (
            typeof meta["forked_from_id"] !== "string" ||
            !UUID.test(meta["forked_from_id"])
        )
            continue;
        // Ensure the file still belongs to this active/archive collection before surfacing it.
        const thread = await read(meta["id"]).catch(async (error) => {
            try {
                await realpath(file);
            } catch (statError) {
                if (missing(statError)) return null;
            }
            throw error;
        });
        if (thread && thread.forkedFromId !== null) {
            try {
                await realpath(file);
            } catch (error) {
                if (missing(error)) continue;
                throw error;
            }
            result.push(cwd === null ? thread : { ...thread, cwd });
        }
    }
    return { forks: result, sources };
}

async function* rolloutFiles(directory: string): AsyncGenerator<string> {
    let entries;
    try {
        entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
        if (missing(error)) return;
        throw error;
    }
    for (const entry of entries) {
        const file = path.join(directory, entry.name);
        // Do not follow symlinks out of Codex's native history directories.
        if (entry.isDirectory()) yield* rolloutFiles(file);
        else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name))
            yield file;
    }
}

async function firstLine(file: string): Promise<string | null> {
    const stream = createReadStream(file, { encoding: "utf8" });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
        for await (const line of lines) return line;
        return null;
    } catch (error) {
        if (missing(error)) return null;
        throw error;
    } finally {
        lines.close();
        stream.destroy();
    }
}

/** Resume responses can omit the source even when Codex saved it in the rollout. */
export async function nativeThreadSource(
    file: string,
    threadId: string,
): Promise<string | null> {
    const meta = await nativeHeader(file);
    return meta?.["id"] === threadId &&
        typeof meta["thread_source"] === "string" &&
        meta["thread_source"].length > 0
        ? meta["thread_source"]
        : null;
}

async function nativeHeader(
    file: string,
): Promise<Record<string, unknown> | null> {
    const line = await firstLine(file);
    if (line === null) return null;
    let value: unknown;
    try {
        value = JSON.parse(line);
    } catch {
        return null;
    }
    if (
        !value ||
        typeof value !== "object" ||
        !("type" in value) ||
        value.type !== "session_meta" ||
        !("payload" in value)
    )
        return null;
    const meta = value.payload;
    return meta !== null && typeof meta === "object" && !Array.isArray(meta)
        ? (meta as Record<string, unknown>)
        : null;
}
