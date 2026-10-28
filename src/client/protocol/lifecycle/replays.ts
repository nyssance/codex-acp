import type { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2/unstable";

import { replayIdOf } from "../session/replay";

/** Only a locally requested replay can admit historical frames into a session. */
export class ReplayCoordinator {
    private readonly active = new Map<string, string | null>();

    begin(sessionId: string): void {
        this.active.set(sessionId, null);
    }
    started(sessionId: string, replayId: string): boolean {
        if (!this.active.has(sessionId)) return false;
        this.active.set(sessionId, replayId);
        return true;
    }
    ended(sessionId: string, replayId: string): void {
        if (this.active.get(sessionId) === replayId)
            this.active.delete(sessionId);
    }
    accepts(sessionId: string, update: SessionUpdate): boolean {
        const replayId = replayIdOf(update);
        return replayId === null || this.active.get(sessionId) === replayId;
    }
    retire(sessionId: string): void {
        this.active.delete(sessionId);
    }
    clear(): void {
        this.active.clear();
    }
}
