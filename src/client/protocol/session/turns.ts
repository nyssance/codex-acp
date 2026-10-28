// Groups a session into turns: one turn = one user message plus everything the agent produced for it.
//
// `session.items` is a flat list in arrival order, which is what the protocol looks like; apps that want to read it item by item can use it directly.
// But UIs are almost always laid out as question-and-answer: a user bubble, followed by that turn's reply, thinking, and tools.
// Every WorkBuddy needs this grouping and there is really only one way to do it, so it lives in the package instead of being rewritten each time.
import type * as acp from "@agentclientprotocol/sdk/experimental/v2/unstable";

import type {
    CompactionItem,
    FoldPolicy,
    Item,
    MessageItem,
    PlanItem,
    Session,
    ToolItem,
} from "./session";

/** A tool, plus the sub-tools it dispatched. */
export type ToolNode = ToolItem & { children: ToolNode[] };

/** One thing the agent produced within a turn. Tools have already found their parents; sub-tools sit in the parent tool's `children`. */
export type TurnEntry = MessageItem | ToolNode | PlanItem | CompactionItem;

export type Turn = {
    /**
     * The user message that started this turn. Null in two cases: the history begins with the agent speaking,
     * or the turn was initiated by the agent itself.
     */
    prompt: MessageItem | null;
    /** What the agent produced this turn, in arrival order. */
    entries: TurnEntry[];
    /** This turn's usage, delivered by the closing idle frame. */
    usage: acp.Usage | null;
    /** When this turn started: the user message arrived, or with no user message, the first output arrived. Null for an empty turn. */
    startedAt: number | null;
    /** When this turn closed (the idle frame arrived); null if not yet closed, or if the turn has no user message to key it on. */
    endedAt: number | null;
};

function isTool(item: Item): item is ToolItem {
    return item.kind === "tool";
}

function isPrompt(item: Item): item is MessageItem {
    return item.kind === "user";
}

/**
 * Groups by turn, and lets tools find their parents along the way.
 *
 * Who dispatched a tool has no protocol field to ask: alwith-cli puts it in `_meta.claudeCode.parentToolUseId`.
 * So like "outlives the turn", the criterion is supplied by `FoldPolicy`; without it everything is flat.
 *
 * A sub-tool whose parent cannot be found is treated as top-level: the parent may be in already-trimmed history, and making it vanish is worse than misplacing it.
 */
export function turns(session: Session, policy: FoldPolicy = {}): Turn[] {
    const nodes = new Map<string, ToolNode>();
    for (const item of session.items) {
        if (isTool(item)) nodes.set(item.id, { ...item, children: [] });
    }

    const nested = new Set<string>();
    for (const item of session.items) {
        if (!isTool(item)) continue;
        const parentId = policy.parentOf?.(item) ?? null;
        if (parentId === null || parentId === item.id) continue;
        const parent = nodes.get(parentId);
        if (parent === undefined) continue;
        parent.children.push(nodes.get(item.id)!);
        nested.add(item.id);
    }

    const entryOf = (item: Item): TurnEntry =>
        isTool(item) ? nodes.get(item.id)! : item;

    const result: Turn[] = [];
    let current: Turn | null = null;
    const optimistic = (item: Item) =>
        item.kind === "user" &&
        (item.echo === "pending" || item.echo === "acknowledged");
    // Optimistic messages cannot reassign streamed output from an already inserted prompt.
    const ordered = [
        ...session.items.filter((item) => !optimistic(item)),
        ...session.items.filter(optimistic),
    ];
    for (const item of ordered) {
        if (isPrompt(item)) {
            current = {
                prompt: item,
                entries: [],
                usage: session.turnUsage[item.id] ?? null,
                startedAt: item.at,
                endedAt: session.turnEndedAt[item.id] ?? null,
            };
            result.push(current);
            continue;
        }
        if (isTool(item) && nested.has(item.id)) continue;
        if (current === null) {
            current = {
                prompt: null,
                entries: [],
                usage: null,
                startedAt: item.at,
                endedAt: null,
            };
            result.push(current);
        }
        current.entries.push(entryOf(item));
    }
    return result;
}
