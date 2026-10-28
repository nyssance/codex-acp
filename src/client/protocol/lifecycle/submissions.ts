import type {
    PromptResponse,
    SessionUpdate,
    StateUpdate,
    UserMessage,
} from "@agentclientprotocol/sdk/experimental/v2/unstable";

export type PromptCompletion = Extract<StateUpdate, { state: "idle" }>;
type Insertion = { echoed: boolean; completion: PromptCompletion | null };
export interface SubmissionSnapshot {
    readonly id: number;
    readonly sessionId: string;
    readonly dispatched: boolean;
    readonly receipt: "pending" | "accepted" | "rejected" | "unknown";
    readonly messageId: string | null;
    readonly echoed: boolean;
    readonly completion: "pending" | "complete" | "unknown" | "not-started";
}
export interface Submission {
    readonly id: number;
    readonly receipt: Promise<PromptResponse>;
    readonly completion: Promise<PromptCompletion>;
}
type MutableSnapshot = {
    -readonly [K in keyof SubmissionSnapshot]: SubmissionSnapshot[K];
};
type Pending = {
    snapshot: MutableSnapshot;
    acceptReceipt: (response: PromptResponse) => void;
    rejectReceipt: (error: unknown) => void;
    messageId: string | null;
    resolve: (completion: PromptCompletion) => void;
    reject: (error: unknown) => void;
};
type SessionPrompts = {
    pending: Set<Pending>;
    insertions: Map<string, Insertion>;
};

/** Bounded, connection-local submission evidence; never a conversation store. */
export class SubmissionLedger {
    private readonly sessions = new Map<string, SessionPrompts>();
    private readonly maxPending: number;
    private readonly maxObserved: number;
    private nextId = 1;
    private readonly recent = new Map<number, SubmissionSnapshot>();
    private readonly maxRecent: number;

    constructor(
        options: {
            maxPendingPerSession?: number;
            maxObservedMessagesPerSession?: number;
            maxRecent?: number;
        } = {},
    ) {
        this.maxPending = options.maxPendingPerSession ?? 256;
        this.maxObserved = options.maxObservedMessagesPerSession ?? 4096;
        this.maxRecent = options.maxRecent ?? 256;
        for (const limit of [this.maxPending, this.maxObserved, this.maxRecent])
            if (!Number.isSafeInteger(limit) || limit < 1)
                throw new RangeError(
                    "Prompt tracking limits must be positive safe integers",
                );
    }

    snapshots(sessionId?: string): readonly SubmissionSnapshot[] {
        const active = [...this.sessions.values()].flatMap((session) =>
            [...session.pending].map((item) => item.snapshot),
        );
        return [...this.recent.values(), ...active]
            .filter(
                (item) =>
                    sessionId === undefined || item.sessionId === sessionId,
            )
            .toSorted((a, b) => a.id - b.id)
            .map((item) => Object.freeze({ ...item }));
    }

    submit(
        sessionId: string,
        send: () => Promise<PromptResponse>,
        acknowledge: (response: PromptResponse) => void = () => {},
        definitelyRejected: (error: unknown) => boolean = () => false,
    ): Submission {
        let session = this.sessions.get(sessionId);
        if (session === undefined) {
            session = { pending: new Set(), insertions: new Map() };
            this.sessions.set(sessionId, session);
        }
        if (session.pending.size >= this.maxPending)
            throw new Error(
                `Session ${sessionId} pending prompt capacity exceeded (${this.maxPending})`,
            );
        const current = session;
        const receipt = Promise.withResolvers<PromptResponse>();
        const completion = Promise.withResolvers<PromptCompletion>();
        // Consumers may wait for acceptance only or completion only; both outcomes remain observable.
        void receipt.promise.catch(() => {});
        void completion.promise.catch(() => {});
        const snapshot: MutableSnapshot = {
            id: this.nextId++,
            sessionId,
            dispatched: false,
            receipt: "pending",
            messageId: null,
            echoed: false,
            completion: "pending",
        };
        const pending: Pending = {
            snapshot,
            messageId: null,
            acceptReceipt: receipt.resolve,
            rejectReceipt: receipt.reject,
            resolve: completion.resolve,
            reject: completion.reject,
        };
        current.pending.add(pending);
        let sent: Promise<PromptResponse>;
        try {
            snapshot.dispatched = true;
            sent = send();
        } catch (error) {
            sent = Promise.reject(error);
        }
        void Promise.resolve(sent)
            .then((response) => {
                if (!current.pending.has(pending)) return;
                if (
                    typeof response.messageId !== "string" ||
                    response.messageId.length === 0
                )
                    throw new Error("session/prompt returned no messageId");
                snapshot.receipt = "accepted";
                snapshot.messageId = response.messageId;
                pending.messageId = response.messageId;
                acknowledge(response);
                if (!current.pending.has(pending)) return;
                let insertion = current.insertions.get(response.messageId);
                if (insertion === undefined) {
                    if (!this.reserveInsertion(sessionId, current)) return;
                    insertion = { echoed: false, completion: null };
                    current.insertions.set(response.messageId, insertion);
                }
                snapshot.echoed = insertion.echoed;
                pending.acceptReceipt(response);
                if (insertion.completion !== null)
                    this.complete(current, pending, insertion.completion);
                this.prune(sessionId, current);
            })
            .catch((error: unknown) => {
                if (!current.pending.has(pending)) return;
                if (snapshot.receipt === "pending")
                    snapshot.receipt =
                        !snapshot.dispatched || definitelyRejected(error)
                            ? "rejected"
                            : "unknown";
                snapshot.completion =
                    snapshot.receipt === "rejected" ? "not-started" : "unknown";
                pending.rejectReceipt(error);
                pending.reject(error);
                current.pending.delete(pending);
                this.remember(snapshot);
                this.prune(sessionId, current);
            });
        return {
            id: snapshot.id,
            receipt: receipt.promise,
            completion: completion.promise,
        };
    }

    async run(
        sessionId: string,
        send: () => Promise<PromptResponse>,
        acknowledge: (response: PromptResponse) => void,
    ): Promise<PromptCompletion> {
        return this.submit(sessionId, send, acknowledge).completion;
    }

    private complete(
        session: SessionPrompts,
        pending: Pending,
        completion: PromptCompletion,
    ): void {
        pending.snapshot.echoed = true;
        pending.snapshot.completion = "complete";
        session.pending.delete(pending);
        this.remember(pending.snapshot);
        pending.resolve(completion);
    }

    private remember(snapshot: MutableSnapshot): void {
        this.recent.set(snapshot.id, Object.freeze({ ...snapshot }));
        while (this.recent.size > this.maxRecent)
            this.recent.delete(this.recent.keys().next().value!);
    }

    accept(sessionId: string, update: SessionUpdate): void {
        // Historical replay is not evidence that a new submission entered a live turn.
        if (
            (update._meta as { replay?: { id?: unknown } } | undefined)?.replay
                ?.id !== undefined
        )
            return;
        const session = this.sessions.get(sessionId);
        if (session === undefined) return;
        if (
            update.sessionUpdate === "user_message" ||
            update.sessionUpdate === "user_message_chunk"
        ) {
            const { messageId } = update as UserMessage;
            const insertion = session.insertions.get(messageId);
            if (insertion) insertion.echoed = true;
            else if (this.reserveInsertion(sessionId, session))
                session.insertions.set(messageId, {
                    echoed: true,
                    completion: null,
                });
            for (const pending of session.pending)
                if (pending.messageId === messageId)
                    pending.snapshot.echoed = true;
        } else if (
            update.sessionUpdate === "state_update" &&
            update.state === "idle"
        ) {
            for (const insertion of session.insertions.values()) {
                if (insertion.echoed)
                    insertion.completion ??= update as PromptCompletion;
            }
            for (const pending of session.pending) {
                if (pending.messageId === null) continue;
                const insertion = session.insertions.get(pending.messageId)!;
                if (insertion.completion === null) continue;
                this.complete(session, pending, insertion.completion);
            }
            this.prune(sessionId, session);
        }
    }

    failSession(sessionId: string, error: Error): void {
        const session = this.sessions.get(sessionId);
        if (!session) return;
        this.sessions.delete(sessionId);
        for (const pending of session.pending) {
            if (pending.snapshot.receipt === "pending")
                pending.snapshot.receipt = pending.snapshot.dispatched
                    ? "unknown"
                    : "rejected";
            pending.snapshot.completion = pending.snapshot.dispatched
                ? "unknown"
                : "not-started";
            pending.rejectReceipt(error);
            pending.reject(error);
            this.remember(pending.snapshot);
        }
        session.pending.clear();
    }

    fail(error: Error): void {
        for (const sessionId of this.sessions.keys())
            this.failSession(sessionId, error);
    }

    private reserveInsertion(
        sessionId: string,
        session: SessionPrompts,
    ): boolean {
        if (session.insertions.size < this.maxObserved) return true;
        // Tracking failure cannot prove whether the remote submission was accepted.
        this.failSession(
            sessionId,
            new Error(
                `Session ${sessionId} prompt evidence capacity exceeded; completion is unknown`,
            ),
        );
        return false;
    }

    private prune(sessionId: string, session: SessionPrompts): void {
        if (this.sessions.get(sessionId) !== session) return;
        if (session.pending.size === 0) {
            this.sessions.delete(sessionId);
            return;
        }
        // Before responses arrive, retain IDs across idle so notification-first transports work.
        if ([...session.pending].some((pending) => pending.messageId === null))
            return;
        const pendingIds = new Set(
            [...session.pending].map((pending) => pending.messageId),
        );
        for (const id of session.insertions.keys())
            if (!pendingIds.has(id)) session.insertions.delete(id);
    }
}
