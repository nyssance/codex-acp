import { describe, expect, it } from "bun:test";

import { SessionOperations } from "../session-operations";

function gate<T>(): {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (error: unknown) => void;
} {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

describe("one ordered operation lane per session", () => {
    it("merges adjacent opens of one fingerprint, runs different fingerprints in order and keeps the last A of A→B→A", async () => {
        const operations = new SessionOperations();
        const runs: string[] = [];
        const first = gate<string>();
        const a1 = operations.open("s", "A", () => {
            runs.push("A");
            return first.promise;
        });
        const a2 = operations.open("s", "A", () => {
            return Promise.try(() => {
                runs.push("A-again");
                return "unused";
            });
        });
        expect(a2).toBe(a1);
        const b = operations.open("s", "B", () => {
            return Promise.try(() => {
                runs.push("B");
                return "b";
            });
        });
        const a3 = operations.open("s", "A", () => {
            return Promise.try(() => {
                runs.push("A-last");
                return "a-last";
            });
        });
        expect(operations.pending("s")).toBe(2);
        first.resolve("a");
        expect(await a1).toBe("a");
        expect(await b).toBe("b");
        expect(await a3).toBe("a-last");
        expect(runs).toEqual(["A", "B", "A-last"]);
    });

    it("close while A restores and B is queued drops B; an open after the close runs once the close is done", async () => {
        const operations = new SessionOperations();
        const runs: string[] = [];
        const opening = gate<string>();
        const a = operations.open("s", "A", () => {
            runs.push("open A");
            return opening.promise;
        });
        const b = operations.open("s", "B", () => {
            return Promise.try(() => {
                runs.push("open B");
                return "b";
            });
        });
        const closing = gate<void>();
        const close = operations.close("s", () => {
            runs.push("close");
            return closing.promise;
        });
        await expect(b).rejects.toMatchObject({ name: "AbortError" });
        const reopened = operations.open("s", "A", () => {
            return Promise.try(() => {
                runs.push("open after close");
                return "again";
            });
        });
        expect(runs).toEqual(["open A"]);
        opening.resolve("a");
        expect(await a).toBe("a");
        await Promise.resolve();
        expect(runs).toEqual(["open A", "close"]);
        closing.resolve();
        await close;
        expect(await reopened).toBe("again");
        expect(runs).toEqual(["open A", "close", "open after close"]);
    });

    it("a failed operation does not block the lane", async () => {
        const operations = new SessionOperations();
        const failed = operations.open("s", "A", () => {
            return Promise.try(() => {
                throw new Error("boom");
            });
        });
        const next = operations.open("s", "B", () => Promise.resolve("ok"));
        await expect(failed).rejects.toThrow("boom");
        expect(await next).toBe("ok");
    });
});

it("cancels a running open, waits for its peer response, and does not block another session", async () => {
    const operations = new SessionOperations();
    const peer = gate<string>();
    let signal!: AbortSignal;
    const opening = operations.open("a", "same", (current) => {
        signal = current;
        return peer.promise;
    });
    let closed = false;
    const closing = operations.close("a", () => {
        closed = true;
        return Promise.resolve();
    });
    expect(signal.aborted).toBe(true);
    expect(closed).toBe(false);
    expect(
        await operations.open("b", "different", () =>
            Promise.resolve("independent"),
        ),
    ).toBe("independent");
    expect(closed).toBe(false);
    peer.resolve("accepted before cancellation");
    await opening;
    await closing;
    expect(closed).toBe(true);
});

it("a synchronous failure releases the lane", async () => {
    const operations = new SessionOperations();
    const failed = operations.open("a", "first", () => {
        throw new Error("synchronous failure");
    });
    const next = operations.open("a", "second", () => Promise.resolve("next"));
    await expect(failed).rejects.toThrow("synchronous failure");
    expect(await next).toBe("next");
});

it("never drops a queued deletion when a later close revokes opens", async () => {
    const operations = new SessionOperations();
    const peer = gate<void>();
    const events: string[] = [];
    const opening = operations.open("s", "A", () => peer.promise);
    const deleting = operations.delete("s", async () => {
        events.push("delete");
    });
    const closing = operations.close("s", async () => {
        events.push("close");
    });
    peer.resolve();
    await Promise.all([opening, deleting, closing]);
    expect(events).toEqual(["delete", "close"]);
    expect(operations.activeSessionCount).toBe(0);
});

it("retires idle lanes after success and failure", async () => {
    const operations = new SessionOperations();
    for (let index = 0; index < 100; index++) {
        await operations.open(String(index), "A", async () => index);
    }
    expect(operations.activeSessionCount).toBe(0);
    const error = { code: "peer_failed" };
    await expect(
        operations.open("failed", "A", () => Promise.reject(error)),
    ).rejects.toBe(error);
    expect(operations.activeSessionCount).toBe(0);
});

it("rejects overload without dropping accepted destructive operations", async () => {
    const operations = new SessionOperations({ maxPendingPerSession: 1 });
    const peer = gate<void>();
    const opening = operations.open("s", "A", () => peer.promise);
    let deleted = false;
    const deleting = operations.delete("s", async () => {
        deleted = true;
    });
    await expect(operations.close("s", async () => {})).rejects.toMatchObject({
        name: "LifecycleCapacityError",
    });
    expect(operations.pending("s")).toBe(1);
    peer.resolve();
    await Promise.all([opening, deleting]);
    expect(deleted).toBe(true);
});

it("a failed delete preserves the next explicit close without pretending deletion succeeded", async () => {
    const operations = new SessionOperations();
    const peer = gate<void>();
    const opening = operations.open("s", "A", () => peer.promise);
    const error = new Error("delete refused");
    const deleting = operations.delete("s", () => Promise.reject(error));
    const rejected = deleting.catch((failure) => failure);
    let closed = false;
    const closing = operations.close("s", async () => {
        closed = true;
    });
    peer.resolve();
    await Promise.all([opening, closing]);
    expect(await rejected).toBe(error);
    expect(closed).toBe(true);
    expect(operations.activeSessionCount).toBe(0);
});

it("an abort listener's reentrant reopen stays after the reserved close boundary", async () => {
    const operations = new SessionOperations();
    const peer = gate<void>();
    const events: string[] = [];
    let reopened!: Promise<void>;
    const opening = operations.open("s", "A", (signal) => {
        signal.addEventListener("abort", () => {
            reopened = operations.open("s", "B", async () => {
                events.push("reopened");
            });
        });
        return peer.promise;
    });
    const closing = operations.close("s", async () => {
        events.push("closed");
    });
    peer.resolve();
    await Promise.all([opening, closing, reopened]);
    expect(events).toEqual(["closed", "reopened"]);
});
