import {throwIfRequestCancelled, withRequestCancellation} from "../RequestCancellation";
import {catalogFieldBytes} from "./responseBudget";
import {randomUUID} from "node:crypto";
import {RequestError} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {CATALOG_CHUNK_BYTES, MAX_CATALOG_BYTES, MAX_ACP_RESPONSE_BYTES, type CatalogPage} from "../catalog-protocol";

type Snapshot = {bytes: Buffer; expires: number; deadline: number; timer: ReturnType<typeof setTimeout> | null};
const CATALOG_LOAD_TIMEOUT_MS = 60000;
const SNAPSHOT_IDLE_MS = 60000;
const SNAPSHOT_MAX_LIFETIME_MS = 5 * 60000;
const MAX_SNAPSHOTS = 4;

/** Connection-local immutable snapshots; chunks also handle a single oversized plugin field. */
export class CatalogPages {
    private readonly snapshots = new Map<string, Snapshot>();
    private pending = 0;

    async read(params: Record<string, unknown>, load: (query: Record<string, unknown>) => Promise<unknown>, signal?: AbortSignal): Promise<CatalogPage> {
        throwIfRequestCancelled(signal);
        for (const [id, snapshot] of this.snapshots) if (snapshot.expires <= Date.now()) this.release(id);
        let id: string;
        let snapshot: Snapshot;
        let offset = 0;
        if (params.cursor != null) {
            if (params.query != null || typeof params.cursor !== "string") throw RequestError.invalidParams(undefined, "A continuation accepts only its cursor");
            const match = /^([a-f0-9-]{36}):(\d+)$/.exec(params.cursor);
            if (!match) throw RequestError.invalidParams(undefined, "Invalid catalog cursor");
            id = match[1]!;
            offset = Number(match[2]);
            const found = this.snapshots.get(id);
            if (!found) throw RequestError.invalidRequest({reason: "catalog_snapshot_expired", retryable: true}, "Catalog snapshot expired; restart the catalog read");
            snapshot = found;
            if (!Number.isSafeInteger(offset) || offset <= 0 || offset >= snapshot.bytes.length || offset % CATALOG_CHUNK_BYTES !== 0)
                throw RequestError.invalidParams(undefined, "Invalid catalog cursor offset");
        } else {
            if (params.query != null && (typeof params.query !== "object" || Array.isArray(params.query))) throw RequestError.invalidParams(undefined, "Catalog query must be an object");
            if (this.snapshots.size + this.pending >= MAX_SNAPSHOTS) throw RequestError.invalidRequest({reason: "catalog_busy", retryable: true}, "Too many catalog reads are in progress");
            this.pending++;
            const operation = (async () => load((params.query ?? {}) as Record<string, unknown>))();
            let timer: ReturnType<typeof setTimeout> | undefined;
            let result: unknown;
            try {
                const deadline = new Promise<never>((_, reject) => {
                    timer = setTimeout(() => reject(RequestError.invalidRequest(
                        {reason: "catalog_load_timeout", retryable: true}, "Catalog loading timed out; retry after the upstream read finishes",
                    )), CATALOG_LOAD_TIMEOUT_MS);
                    timer.unref();
                });
                result = await withRequestCancellation(Promise.race([operation, deadline]), signal);
                throwIfRequestCancelled(signal);
            } finally {
                clearTimeout(timer);
                // Codex cannot cancel plugin/list. Keep real upstream work bounded even after its caller leaves.
                // Register cleanup after the wait so successful reads reserve their slot until the snapshot is stored.
                void operation.then(() => { this.pending--; }, () => { this.pending--; });
            }
            const bytes = Buffer.from(JSON.stringify(result));
            if (bytes.length > MAX_ACP_RESPONSE_BYTES) console.error("[alwith-catalog-size] " + JSON.stringify({
                version: 1, method: "_codex/plugin_list_page", bytes: bytes.length, limitBytes: MAX_ACP_RESPONSE_BYTES,
                fieldBytes: catalogFieldBytes(result, bytes.length),
            }));
            if (bytes.length > MAX_CATALOG_BYTES) throw RequestError.invalidRequest({reason: "catalog_response_too_large", bytes: bytes.length, limitBytes: MAX_CATALOG_BYTES, retryable: false}, "Catalog exceeds the snapshot memory budget");
            for (const [key, entry] of this.snapshots) if (entry.expires <= Date.now()) this.release(key);
            const retained = [...this.snapshots.values()].reduce((sum, entry) => sum + entry.bytes.length, 0);
            if (bytes.length + retained > MAX_CATALOG_BYTES) throw RequestError.invalidRequest({reason: "catalog_busy", retryable: true}, "Catalog snapshot memory is temporarily full");
            id = randomUUID();
            snapshot = {bytes, expires: Date.now() + SNAPSHOT_IDLE_MS, deadline: Date.now() + SNAPSHOT_MAX_LIFETIME_MS, timer: null};
            this.snapshots.set(id, snapshot);
        }
        const end = Math.min(offset + CATALOG_CHUNK_BYTES, snapshot.bytes.length);
        const nextCursor = end < snapshot.bytes.length ? `${id}:${end}` : null;
        const page: CatalogPage = {encoding: "base64-json", data: snapshot.bytes.subarray(offset, end).toString("base64"), totalBytes: snapshot.bytes.length, nextCursor};
        if (nextCursor === null) this.release(id);
        else {
            if (snapshot.timer !== null) clearTimeout(snapshot.timer);
            snapshot.expires = Math.min(Date.now() + SNAPSHOT_IDLE_MS, snapshot.deadline);
            snapshot.timer = setTimeout(() => this.release(id), Math.max(0, snapshot.expires - Date.now()));
            snapshot.timer.unref();
        }
        return page;
    }

    private release(id: string): void {
        const snapshot = this.snapshots.get(id);
        if (snapshot?.timer != null) clearTimeout(snapshot.timer);
        this.snapshots.delete(id);
    }
}
