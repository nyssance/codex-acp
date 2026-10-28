import { expect, test } from "bun:test";

import type { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2/unstable";

import { SessionBirths } from "../births";
import { SessionLifecycle } from "../session-lifecycle";
import { SubmissionLedger } from "../submissions";

const idle = {
    sessionUpdate: "state_update",
    state: "idle",
    stopReason: "end_turn",
} as const;
const echo = (id: string, replay?: string): SessionUpdate => ({
    sessionUpdate: "user_message",
    messageId: id,
    content: [],
    ...(replay ? { _meta: { replay: { id: replay } } } : {}),
});

test("acceptance, insertion and completion remain separate evidence", async () => {
    const core = new SessionLifecycle();
    const submission = core.submissions.submit("s", async () => ({
        messageId: "m",
    }));
    await submission.receipt;
    expect(core.submissions.snapshots()[0]).toMatchObject({
        receipt: "accepted",
        echoed: false,
        completion: "pending",
    });
    core.accept("s", idle);
    expect(core.submissions.snapshots()[0]?.completion).toBe("pending");
    core.accept("s", echo("m"));
    core.accept("s", idle);
    expect(await submission.completion).toEqual(idle);
    expect(core.submissions.snapshots()[0]).toMatchObject({
        receipt: "accepted",
        echoed: true,
        completion: "complete",
    });
});

test("transport uncertainty is retained; only explicit refusal is rejected", async () => {
    const ledger = new SubmissionLedger({ maxRecent: 1 });
    const failure = new Error("connection lost");
    const unknown = ledger.submit("s", () => Promise.reject(failure));
    await expect(unknown.receipt).rejects.toBe(failure);
    expect(ledger.snapshots()[0]).toMatchObject({
        receipt: "unknown",
        completion: "unknown",
    });
    const rejected = ledger.submit(
        "s",
        () => Promise.reject(failure),
        undefined,
        () => true,
    );
    await expect(rejected.receipt).rejects.toBe(failure);
    expect(ledger.snapshots()).toHaveLength(1);
    expect(ledger.snapshots()[0]).toMatchObject({
        receipt: "rejected",
        completion: "not-started",
    });
});

test("replay retirement isolates a sibling and late replay boundaries", async () => {
    const core = new SessionLifecycle();
    const response = Promise.withResolvers<{ messageId: string }>();
    const old = core.submissions.submit("s", () => response.promise);
    const oldFailure = old.receipt.catch((error) => error);
    const sibling = core.submissions.submit("other", async () => ({
        messageId: "other",
    }));
    const generation = core.beginReplay("s");
    expect(await oldFailure).toBeInstanceOf(Error);
    core.replays.started("s", "r1");
    core.beginReplay("s");
    core.replays.started("s", "r2");
    core.replays.ended("s", "r1");
    expect(core.isCurrent(generation)).toBe(false);
    expect(core.accept("s", echo("history", "r1"))).toBe(false);
    expect(core.accept("s", echo("history", "r2"))).toBe(true);
    core.retire("s");
    expect(core.replays.started("s", "r3")).toBe(false);
    response.resolve({ messageId: "old" });
    core.accept("other", echo("other"));
    core.accept("other", idle);
    await sibling.completion;
    expect(core.submissions.snapshots("s")[0]?.receipt).toBe("unknown");
});

test("historical frames cannot complete a new live submission", async () => {
    const ledger = new SubmissionLedger();
    const sent = ledger.submit("s", async () => ({ messageId: "m" }));
    await sent.receipt;
    ledger.accept("s", echo("m", "history"));
    ledger.accept("s", idle);
    expect(ledger.snapshots()[0]?.completion).toBe("pending");
    ledger.failSession("s", new Error("closed"));
    await expect(sent.completion).rejects.toThrow("closed");
});

test("creation buffering is ordered, bounded and cleared after failure", async () => {
    const births = new SessionBirths<number>(2);
    const response = Promise.withResolvers<{ sessionId: string }>();
    const seen: number[] = [];
    const created = births.run(
        () => response.promise,
        () => seen.push(0),
        (_, value) => seen.push(value),
    );
    births.buffer("s", 1);
    births.buffer("s", 2);
    expect(() => births.buffer("s", 3)).toThrow("capacity");
    response.resolve({ sessionId: "s" });
    await expect(created).rejects.toThrow("capacity");
    expect(seen).toEqual([]);
    expect(births.buffer("s", 4)).toBe(false);
});

test("retirement invalidates queued work before it can dispatch to a replacement", async () => {
    const core = new SessionLifecycle();
    const gate = Promise.withResolvers<void>();
    const running = core.admission.enqueue("s", () => gate.promise);
    let sent = false;
    const queued = core.admission.enqueue("s", async () => {
        sent = true;
    });
    const failure = queued.catch((error) => error);
    core.retire("s");
    const replacement = core.admission.enqueue(
        "s",
        async () => "new attachment",
    );
    gate.resolve();
    await running;
    expect(await failure).toMatchObject({ name: "AbortError" });
    expect(sent).toBe(false);
    expect(await replacement).toBe("new attachment");
});

test("a disconnected creation cannot settle into a replacement connection", async () => {
    const core = new SessionLifecycle();
    const response = Promise.withResolvers<{ sessionId: string }>();
    let settled = false;
    const old = core.births.run(
        () => response.promise,
        () => {
            settled = true;
        },
        () => {},
    );
    const result = old.catch((error) => error);
    core.clear();
    const events: number[] = [];
    const fresh = core.births.run(
        async () => ({ sessionId: "new" }),
        () => events.push(1),
        () => {},
    );
    response.resolve({ sessionId: "old" });
    expect(await result).toBeInstanceOf(Error);
    await fresh;
    expect(settled).toBe(false);
    expect(events).toEqual([1]);
});

test("closing during preparation cannot deadlock with a nested replay", async () => {
    const core = new SessionLifecycle();
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    let sent = false;
    const prompt = core.prompt(
        "s",
        async (checkpoint) => {
            entered.resolve();
            await gate.promise;
            checkpoint();
            await core.operations.open("s", "replay", async () => {});
        },
        async () => {
            sent = true;
        },
        (operation) => core.admission.enqueue("s", operation),
    );
    const outcome = prompt.catch((error) => error);
    await entered.promise;
    core.cancelPreparing("s");
    const closing = core.operations.close("s", () =>
        core.admission.enqueue("s", async () => {}),
    );
    gate.resolve();
    expect(await outcome).toMatchObject({ name: "AbortError" });
    await closing;
    expect(sent).toBe(false);
});
