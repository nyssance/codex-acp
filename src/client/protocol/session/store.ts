// Every open session, plus the streaming UTF-8 decoders that terminal output needs.
//
// Terminal blocks are stored separately (not in `items`): their output arrives as a byte stream, a multi-byte character may span two chunks,
// and the same `TextDecoder` must keep decoding it. This is the one piece of state a pure reducer cannot hold.
import type * as acp from "@agentclientprotocol/sdk/experimental/v2/unstable";

import type { ReplayReceipt } from "./replay";
import {
    acknowledgePrompt,
    addPrompt,
    applyUpdate,
    createSession,
    patchMeta,
    type FoldPolicy,
    markInterrupted,
    type Session,
} from "./session";
import { type Turn, turns } from "./turns";

function decodeBase64(data: string): Uint8Array {
    return Uint8Array.from(atob(data), (character) => character.charCodeAt(0));
}

export class SessionStore {
    readonly sessions = new Map<string, Session>();
    private readonly decoders = new Map<string, TextDecoder>();

    /** The judgments the protocol cannot answer at fold time; see `FoldPolicy`. */
    private readonly policy: FoldPolicy;

    constructor(policy: FoldPolicy = {}) {
        this.policy = policy;
    }

    get(id: string): Session {
        const session = this.sessions.get(id);
        if (!session) throw new Error(`Unknown session ${id}`);
        return session;
    }

    set(session: Session): void {
        this.sessions.set(session.id, session);
    }

    children(id: string): Session[] {
        return [...this.sessions.values()].filter(
            (session) => session.subagent?.parentId === id,
        );
    }

    delete(id: string): void {
        this.sessions.delete(id);
        for (const key of this.decoders.keys())
            if (key.startsWith(`[${JSON.stringify(id)},`))
                this.decoders.delete(key);
        this.childStates.delete(id);
    }

    private readonly childStates = new Map<string, string>();

    announce(parentId: string, frame: acp.SubagentUpdate): Session {
        const parent = this.get(parentId);
        const existing = this.sessions.get(frame.sessionId);
        if (existing && existing.subagent?.parentId !== parentId)
            throw new Error(
                `Subagent ${frame.sessionId} already belongs to another session`,
            );
        let child = existing ?? {
            ...createSession(frame.sessionId, parent.cwd),
            state: "unknown" as const,
        };
        child = {
            ...child,
            attached: true,
            title: frame.title === undefined ? child.title : frame.title,
            subagent: {
                parentId,
                description:
                    frame.description === undefined
                        ? (child.subagent?.description ?? null)
                        : frame.description,
                capabilities:
                    frame.capabilities === undefined
                        ? (child.subagent?.capabilities ?? null)
                        : frame.capabilities,
                _meta: patchMeta(child.subagent?._meta ?? null, frame._meta),
            },
        };
        this.set(child);
        if (frame.state === null) {
            this.childStates.delete(child.id);
            child = { ...child, state: "unknown" };
            this.set(child);
        } else if (frame.state !== undefined) {
            child = this.accept(child.id, {
                ...frame.state,
                sessionUpdate: "state_update",
            });
        }
        return child;
    }

    /**
     * A replay is about to stream in. From `"start"` the session is emptied first; from a record position (`after`) what is
     * held stays and the replayed frames extend it, so a session that lost its connection catches up without being rebuilt.
     */
    beginReplay(id: string, from: "start" | number = "start"): void {
        const session = this.get(id);
        if (from === "start") {
            this.sessions.set(id, {
                ...session,
                items: [],
                terminals: {},
                turnUsage: {},
                turnEndedAt: {},
                clock: 0,
                restoring: true,
                error: null,
                appliedThrough: -1,
            });
            for (const key of this.decoders.keys())
                if (key.startsWith(`[${JSON.stringify(id)},`))
                    this.decoders.delete(key);
            return;
        }
        this.sessions.set(id, { ...session, restoring: true, error: null });
    }

    /** The resume answered: the session is live again and has the record through the replay's `cut` (when the agent said). */
    endReplay(id: string, receipt: ReplayReceipt | null): void {
        const session = this.get(id);
        this.sessions.set(id, {
            ...session,
            attached: true,
            restoring: false,
            appliedThrough:
                receipt === null
                    ? session.appliedThrough
                    : Math.max(session.appliedThrough, receipt.cut),
        });
    }

    accept(id: string, update: acp.SessionUpdate): Session {
        const session = this.get(id);
        if (session.subagent && update.sessionUpdate === "state_update") {
            // The protocol mirrors the same state on both parent and child channels.
            const { sessionUpdate: _kind, ...state } = update;
            const signature = JSON.stringify(state, (_key, value: unknown) =>
                value !== null &&
                typeof value === "object" &&
                !Array.isArray(value)
                    ? Object.fromEntries(
                          Object.entries(value).toSorted(([a], [b]) =>
                              a.localeCompare(b),
                          ),
                      )
                    : value,
            );
            if (this.childStates.get(id) === signature) return session;
            this.childStates.set(id, signature);
        }
        let decoded: string | undefined;
        if (update.sessionUpdate === "terminal_update") {
            const frame = update as acp.TerminalUpdate;
            if (frame.output) {
                const decoder = new TextDecoder();
                this.decoders.set(
                    JSON.stringify([id, frame.terminalId]),
                    decoder,
                );
                decoded = decoder.decode(decodeBase64(frame.output.data), {
                    stream: true,
                });
            }
        } else if (update.sessionUpdate === "terminal_output_chunk") {
            const frame = update as acp.TerminalOutputChunk;
            const key = JSON.stringify([id, frame.terminalId]);
            let decoder = this.decoders.get(key);
            if (!decoder) {
                decoder = new TextDecoder();
                this.decoders.set(key, decoder);
            }
            decoded = decoder.decode(decodeBase64(frame.data), {
                stream: true,
            });
        }
        const next = applyUpdate(session, update, {
            ...(decoded === undefined ? {} : { text: decoded }),
            policy: this.policy,
        });
        this.sessions.set(id, next);
        return next;
    }

    /** Shows the message the user just sent on screen first; see `addPrompt`. Returns its local id (replaced by the agent's once its report arrives). */
    addPrompt(id: string, content: acp.ContentBlock[]): string {
        const promptId = crypto.randomUUID();
        this.sessions.set(id, addPrompt(this.get(id), content, promptId));
        return promptId;
    }

    acknowledgePrompt(id: string, localId: string, messageId: string): void {
        this.sessions.set(
            id,
            acknowledgePrompt(this.get(id), localId, messageId),
        );
    }

    /** Groups this session by turn, using the store's own criteria. */
    turns(id: string): Turn[] {
        return turns(this.get(id), this.policy);
    }

    /**
     * Reaps the dangling "outlives the turn" tools in this session. Call only after loading a session with **no live process** and consuming its history;
     * never call it for a session attached to a live process. Returns whether anything changed.
     */
    markInterrupted(id: string): boolean {
        const session = this.get(id);
        const next = markInterrupted(session, this.policy);
        if (next === session) return false;
        this.sessions.set(id, next);
        return true;
    }
}
