import type { ReasoningEffort } from "../../app-server/ReasoningEffort";
import type { CollabAgentState, Thread, ThreadItem } from "../../app-server/v2";

type CollabItem = Extract<ThreadItem, { type: "collabAgentToolCall" }>;

/** Who a collaboration call addressed, read from the receiving thread itself. */
export interface AgentIdentity {
    nickname: string | null;
    role: string | null;
    model: string | null;
    reasoningEffort: ReasoningEffort | null;
}

export type CollabAgent = AgentIdentity & {
    threadId: string;
    state: CollabAgentState | null;
};

/**
 * Collaboration items name receivers only by thread id; their nickname, role and model live on the
 * receiving thread. A spawned agent keeps those for life, so identities are cached by thread id.
 */
export class AgentDirectory {
    private readonly identities = new Map<string, AgentIdentity>();

    constructor(private readonly read: (threadId: string) => Promise<Thread>) {}

    async load(items: Iterable<ThreadItem>): Promise<void> {
        const missing = new Set<string>();
        for (const item of items) {
            if (item.type !== "collabAgentToolCall") continue;
            for (const threadId of receivers(item))
                if (!this.identities.has(threadId)) missing.add(threadId);
        }
        await Promise.all(
            [...missing].map(async (threadId) => {
                this.identities.set(
                    threadId,
                    identityOf(await this.read(threadId)),
                );
            }),
        );
    }

    agents(item: CollabItem): CollabAgent[] {
        return receivers(item).map((threadId) => {
            const identity = this.identities.get(threadId);
            if (!identity)
                throw new Error(
                    `Collaborating agent ${threadId} was not loaded`,
                );
            return {
                threadId,
                ...identity,
                state: item.agentsStates[threadId] ?? null,
            };
        });
    }
}

/** Receivers named by the call or reported in its agent states, in a stable order. */
function receivers(item: CollabItem): string[] {
    return [
        ...new Set([
            ...item.receiverThreadIds,
            ...Object.keys(item.agentsStates),
        ]),
    ].toSorted();
}

function identityOf(thread: Thread): AgentIdentity {
    const spawn =
        typeof thread.source === "object" &&
        "subAgent" in thread.source &&
        typeof thread.source.subAgent === "object" &&
        "thread_spawn" in thread.source.subAgent
            ? thread.source.subAgent.thread_spawn
            : null;
    const nickname =
        nonBlank(thread.agentNickname) ?? nonBlank(spawn?.agent_nickname);
    const role = nonBlank(thread.agentRole) ?? nonBlank(spawn?.agent_role);
    return {
        nickname: nickname?.startsWith("@")
            ? nickname.slice(1)
            : (nickname ?? null),
        // Codex assigns "default" to agents spawned without a role.
        role: role === "default" ? null : (role ?? null),
        model: nonBlank(thread.model) ?? null,
        reasoningEffort: thread.reasoningEffort,
    };
}

function nonBlank(value: string | null | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed || undefined;
}
