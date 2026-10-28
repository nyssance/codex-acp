/** Opaque identity for one local attachment; never persisted or sent to Runtime. */
export interface SessionGeneration {
    readonly sessionId: string;
}

/** Session lifetimes are independent of the shared Agent process lifetime. */
export class SessionGenerations {
    private readonly current = new Map<string, SessionGeneration>();

    capture(sessionId: string): SessionGeneration {
        let generation = this.current.get(sessionId);
        if (!generation) {
            generation = Object.freeze({ sessionId });
            this.current.set(sessionId, generation);
        }
        return generation;
    }

    isCurrent(generation: SessionGeneration): boolean {
        return this.current.get(generation.sessionId) === generation;
    }

    retire(sessionId: string): void {
        this.current.delete(sessionId);
    }

    clear(): void {
        this.current.clear();
    }
}
