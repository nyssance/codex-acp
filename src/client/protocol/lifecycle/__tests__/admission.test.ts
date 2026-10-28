import { describe, expect, it } from "bun:test";

import { SessionAdmission } from "../admission";

function gate() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

describe("session admission", () => {
    it("releases after dispatch while the receipt remains pending", async () => {
        const admission = new SessionAdmission();
        const receipt = gate();
        const dispatched = await admission.enqueue("s", async () => ({
            receipt: receipt.promise,
        }));
        expect(await admission.enqueue("s", async () => "next dispatch")).toBe(
            "next dispatch",
        );
        expect(admission.activeSessionCount).toBe(0);
        receipt.resolve();
        await dispatched.receipt;
    });

    it("preserves failure identity for dependent work and recovers for independent work", async () => {
        const admission = new SessionAdmission();
        const error = new Error("configuration rejected");
        const first = admission.enqueue("s", () => Promise.reject(error));
        let sent = false;
        const dependent = admission.enqueue(
            "s",
            async () => {
                sent = true;
            },
            false,
        );
        const recovery = admission.enqueue("s", async () => "recovered");
        await expect(first).rejects.toBe(error);
        await expect(dependent).rejects.toBe(error);
        expect(sent).toBe(false);
        expect(await recovery).toBe("recovered");
        expect(admission.activeSessionCount).toBe(0);
    });

    it("orders preparation per session without blocking another session", async () => {
        const admission = new SessionAdmission();
        const blocked = gate();
        const events: number[] = [];
        const first = admission.enqueue("a", () => blocked.promise);
        const second = admission.enqueue("a", async () => {
            events.push(2);
        });
        await admission.enqueue("b", async () => {
            events.push(1);
        });
        expect(events).toEqual([1]);
        blocked.resolve();
        await Promise.all([first, second]);
        expect(events).toEqual([1, 2]);
    });
});

it("publishes ownership before synchronous work can enqueue another dispatch", async () => {
    const admission = new SessionAdmission();
    const blocked = gate();
    const events: string[] = [];
    let second!: Promise<void>;
    const first = admission.enqueue("s", () => {
        second = admission.enqueue("s", async () => {
            events.push("second");
        });
        events.push("first");
        return blocked.promise;
    });
    expect(events).toEqual(["first"]);
    blocked.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(["first", "second"]);
    expect(admission.activeSessionCount).toBe(0);
});

it("rejects admission overload without dispatching the rejected work", async () => {
    const admission = new SessionAdmission({ maxPendingPerSession: 1 });
    const blocked = gate();
    const first = admission.enqueue("s", () => blocked.promise);
    let ran = false;
    await expect(
        admission.enqueue("s", async () => {
            ran = true;
        }),
    ).rejects.toThrow("capacity");
    blocked.resolve();
    await first;
    expect(ran).toBe(false);
    expect(admission.activeSessionCount).toBe(0);
});
