import { Effect } from "effect";

import { attempt, run } from "./internal";

/** Serializes preparation and dispatch, never the completion of an agent turn. */
export class SessionAdmission {
    private readonly tails = new Map<string, Promise<unknown>>();
    private readonly counts = new Map<string, number>();
    private readonly capacity: number;

    constructor(options: { maxPendingPerSession?: number } = {}) {
        this.capacity = options.maxPendingPerSession ?? 256;
        if (!Number.isSafeInteger(this.capacity) || this.capacity < 1)
            throw new RangeError(
                "maxPendingPerSession must be a positive safe integer",
            );
    }

    get activeSessionCount(): number {
        return this.tails.size;
    }
    pending(sessionId: string): Promise<unknown> | undefined {
        return this.tails.get(sessionId);
    }

    enqueue<A>(
        sessionId: string,
        work: () => Promise<A>,
        continueAfterFailure = true,
    ): Promise<A> {
        const count = this.counts.get(sessionId) ?? 0;
        if (count >= this.capacity)
            return Promise.reject(
                new Error(
                    `Session ${sessionId} admission capacity exceeded (${this.capacity})`,
                ),
            );
        const previous = this.tails.get(sessionId);
        const effect = Effect.gen(function* () {
            if (previous) {
                const wait = attempt(() => previous);
                yield* continueAfterFailure ? Effect.exit(wait) : wait;
            }
            return yield* attempt(work);
        });
        let resolve!: (value: A) => void;
        let reject!: (error: unknown) => void;
        const result = new Promise<A>((yes, no) => {
            resolve = yes;
            reject = no;
        });
        // Publish ownership before work starts, including synchronous/reentrant dispatch.
        this.tails.set(sessionId, result);
        this.counts.set(sessionId, count + 1);
        const release = () => {
            if (this.tails.get(sessionId) === result)
                this.tails.delete(sessionId);
            const remaining = this.counts.get(sessionId)! - 1;
            if (remaining === 0) this.counts.delete(sessionId);
            else this.counts.set(sessionId, remaining);
        };
        void result.then(release, release);
        void run(effect).then(resolve, reject);
        return result;
    }
}
