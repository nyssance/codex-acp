import type { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2/unstable";

import { SessionAdmission } from "./admission";
import { SessionBirths } from "./births";
import { type SessionGeneration, SessionGenerations } from "./generations";
import { PromptAdmission } from "./prompt-admission";
import { ReplayCoordinator } from "./replays";
import { SessionOperations } from "./session-operations";
import { SubmissionLedger } from "./submissions";

/** One attachment registry and its work queues per client; the Agent registry owns processes. */
export class SessionLifecycle {
    readonly births: SessionBirths<SessionUpdate> =
        new SessionBirths<SessionUpdate>();
    readonly operations = new SessionOperations();
    readonly admission: SessionAdmission = new AttachmentAdmission(
        () => this.generations,
    );
    readonly replays = new ReplayCoordinator();
    readonly submissions = new SubmissionLedger();
    private readonly preparing = new Map<
        string,
        { gate: PromptAdmission; pending: number }
    >();
    private readonly generations = new SessionGenerations();

    cancelPreparing(sessionId: string): void {
        this.preparing.get(sessionId)?.gate.cancel();
    }

    async prompt<A>(
        sessionId: string,
        prepare: (checkpoint: () => void) => void | Promise<void>,
        send: () => Promise<A>,
        schedule?: (
            operation: () => Promise<{ response: Promise<A> }>,
        ) => Promise<{ response: Promise<A> }>,
    ): Promise<A> {
        let entry = this.preparing.get(sessionId);
        if (!entry) {
            entry = { gate: new PromptAdmission(), pending: 0 };
            this.preparing.set(sessionId, entry);
        }
        entry.pending++;
        try {
            return await entry.gate.run(prepare, send, schedule);
        } finally {
            entry.pending--;
            if (entry.pending === 0 && this.preparing.get(sessionId) === entry)
                this.preparing.delete(sessionId);
        }
    }

    capture(sessionId: string): SessionGeneration {
        return this.generations.capture(sessionId);
    }
    isCurrent(generation: SessionGeneration): boolean {
        return this.generations.isCurrent(generation);
    }
    beginReplay(sessionId: string): SessionGeneration {
        this.retireState(
            sessionId,
            new Error("Session resumed before turn completion"),
        );
        this.replays.begin(sessionId);
        return this.capture(sessionId);
    }
    accept(sessionId: string, update: SessionUpdate): boolean {
        if (!this.replays.accepts(sessionId, update)) return false;
        this.submissions.accept(sessionId, update);
        return true;
    }
    retire(
        sessionId: string,
        error = new Error("Session retired before turn completion"),
    ): void {
        this.cancelPreparing(sessionId);
        this.retireState(sessionId, error);
    }
    private retireState(sessionId: string, error: Error): void {
        this.generations.retire(sessionId);
        this.replays.retire(sessionId);
        this.submissions.failSession(sessionId, error);
    }
    clear(
        error = new Error("Agent connection retired before turn completion"),
    ): void {
        for (const entry of this.preparing.values()) entry.gate.close();
        this.preparing.clear();
        this.births.clear();
        this.generations.clear();
        this.replays.clear();
        this.submissions.fail(error);
        // In-flight operations retain ownership until their peer settles; clearing is not cancellation.
    }
}

/** A queued operation retains the attachment that admitted it, never the later selected chat. */
class AttachmentAdmission extends SessionAdmission {
    constructor(private readonly registry: () => SessionGenerations) {
        super();
    }
    override enqueue<A>(
        sessionId: string,
        work: () => Promise<A>,
        continueAfterFailure = true,
    ): Promise<A> {
        const generation = this.registry().capture(sessionId);
        return super.enqueue(
            sessionId,
            () => {
                if (!this.registry().isCurrent(generation))
                    return Promise.reject(
                        new DOMException(
                            "Queued work belongs to a retired session",
                            "AbortError",
                        ),
                    );
                return work();
            },
            continueAfterFailure,
        );
    }
}
