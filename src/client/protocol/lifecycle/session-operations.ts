import { Effect, Exit } from "effect";

import { attempt, failure } from "./internal";

type Kind = "open" | "close" | "delete";
interface Operation {
    kind: Kind;
    fingerprint: string | null;
    controller: AbortController;
    run: (signal: AbortSignal) => Promise<unknown>;
    promise: Promise<unknown>;
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
}
interface Lane {
    running: Operation | null;
    queued: Operation[];
}

export class LifecycleCapacityError extends Error {
    constructor(
        readonly sessionId: string,
        readonly capacity: number,
    ) {
        super(
            `Session ${sessionId} already has ${capacity} queued lifecycle operations`,
        );
        this.name = "LifecycleCapacityError";
    }
}

/**
 * One finite worker per active session. Opens may share an adjacent equivalent
 * request; close and delete are never merged or discarded. Cancellation signals
 * intent, not completion: the worker retains ownership until the peer settles.
 * This coordinates one client; Runtime remains responsible for cross-client fencing.
 */
export class SessionOperations {
    private readonly lanes = new Map<string, Lane>();
    private readonly capacity: number;

    constructor(options: { maxPendingPerSession?: number } = {}) {
        this.capacity = options.maxPendingPerSession ?? 256;
        if (!Number.isSafeInteger(this.capacity) || this.capacity < 1)
            throw new RangeError(
                "maxPendingPerSession must be a positive safe integer",
            );
    }

    /** Includes retiring operations until their actual response and cleanup settle. */
    get activeSessionCount(): number {
        return this.lanes.size;
    }

    open<T>(
        sessionId: string,
        fingerprint: string,
        work: (signal: AbortSignal) => Promise<T>,
    ): Promise<T> {
        const lane = this.lanes.get(sessionId);
        const last = lane?.queued.at(-1) ?? lane?.running;
        if (
            last?.kind === "open" &&
            last.fingerprint === fingerprint &&
            !last.controller.signal.aborted
        )
            return last.promise as Promise<T>;
        return this.enqueue(sessionId, "open", fingerprint, work);
    }

    close<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
        return this.revoke(sessionId, "close", work);
    }

    delete<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
        return this.revoke(sessionId, "delete", work);
    }

    busy(sessionId: string): boolean {
        return this.lanes.has(sessionId);
    }
    pending(sessionId: string): number {
        return this.lanes.get(sessionId)?.queued.length ?? 0;
    }

    private revoke<T>(
        sessionId: string,
        kind: "close" | "delete",
        work: () => Promise<T>,
    ): Promise<T> {
        const lane = this.lanes.get(sessionId);
        if (lane) {
            const retained = lane.queued.filter(
                (operation) => operation.kind !== "open",
            );
            // Refuse before changing anything when the destructive backlog itself is full.
            if (retained.length >= this.capacity)
                return Promise.reject(
                    new LifecycleCapacityError(sessionId, this.capacity),
                );
            const revoked = lane.queued.filter(
                (operation) => operation.kind === "open",
            );
            const running = lane.running?.kind === "open" ? lane.running : null;
            lane.queued = retained;
            // Reserve the boundary before abort listeners can synchronously request a reopen.
            const result = this.enqueue(sessionId, kind, null, work);
            const reason = new DOMException(
                `Session ${kind} revoked the open`,
                "AbortError",
            );
            running?.controller.abort(reason);
            for (const operation of revoked) {
                operation.controller.abort(reason);
                operation.reject(reason);
            }
            return result;
        }
        return this.enqueue(sessionId, kind, null, work);
    }

    private enqueue<T>(
        sessionId: string,
        kind: Kind,
        fingerprint: string | null,
        work: (signal: AbortSignal) => Promise<T>,
    ): Promise<T> {
        let lane = this.lanes.get(sessionId);
        if (lane && lane.queued.length >= this.capacity)
            return Promise.reject(
                new LifecycleCapacityError(sessionId, this.capacity),
            );
        if (!lane) {
            lane = { running: null, queued: [] };
            this.lanes.set(sessionId, lane);
        }
        let resolve!: (value: unknown) => void;
        let reject!: (error: unknown) => void;
        const promise = new Promise<unknown>((yes, no) => {
            resolve = yes;
            reject = no;
        });
        lane.queued.push({
            kind,
            fingerprint,
            run: work,
            promise,
            resolve,
            reject,
            controller: new AbortController(),
        });
        if (lane.running === null) this.drain(sessionId, lane);
        return promise as Promise<T>;
    }

    private drain(sessionId: string, lane: Lane): void {
        const lanes = this.lanes;
        Effect.runFork(
            Effect.gen(function* () {
                while (lane.queued.length > 0) {
                    const operation = lane.queued.shift()!;
                    lane.running = operation;
                    // Do not interrupt this await: a late accepted open must finish before close.
                    const exit = yield* Effect.exit(
                        attempt(() =>
                            operation.run(operation.controller.signal),
                        ),
                    );
                    lane.running = null;
                    if (Exit.isSuccess(exit)) operation.resolve(exit.value);
                    else operation.reject(failure(exit.cause));
                }
                if (lanes.get(sessionId) === lane) lanes.delete(sessionId);
            }),
        );
    }
}
