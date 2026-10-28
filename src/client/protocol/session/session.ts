// State of one ACP v2 session: `session/update` frames go in, a renderable `Session` comes out.
// Pure functions: no transport, no process, no knowledge of any UI framework. Each update returns a new Session object,
// so the render layer can use reference equality to decide whether to redraw.
import type * as acp from "@agentclientprotocol/sdk/experimental/v2/unstable";
import { IdleStateUpdate } from "@agentclientprotocol/sdk/experimental/v2/unstable";

import { isText } from "./blocks";
import { configRevisionOf } from "./config";

export type SessionState = "idle" | "running" | "requires_action";

type ItemBase = {
    id: string;
    /** Wall-clock arrival, used for turn durations. */
    at: number;
    /** Arrived through history replay rather than live streaming. */
    replayed: boolean;
    /**
     * Each engine's dialect, kept as-is for the app to read. Later frames patch it the way ACP v2 specifies for every
     * entity's `_meta`: omitted leaves it unchanged, `null` clears it, and an object patches it by top-level key (an omitted
     * key is unchanged, a key set to `null` is removed, any other value replaces that key's stored value whole, without merging
     * nested objects). Agents therefore send each top-level key complete; see `patchMeta`.
     */
    _meta: Record<string, unknown> | null;
};
export type MessageItem = ItemBase & {
    kind: "user" | "assistant" | "thought";
    content: acp.ContentBlock[];
    /**
     * Reconciliation between a locally pre-displayed user message and what the agent reports back. The protocol requires the agent to report user messages at their
     * position in history (`user_message` + messageId). When the local one is already there,
     * we claim it precisely by the messageId in each prompt receipt: `pending` awaits the report, `adopted` is claimed and later frames with the same id
     * only take `_meta`. The agent's own messages are always null. See `addPrompt`.
     */
    echo: "pending" | "acknowledged" | "adopted" | null;
};
export type ToolItem = ItemBase & {
    kind: "tool";
    name: string | null;
    title: string | null;
    toolKind: acp.ToolKind | null;
    status: acp.ToolCallStatus | null;
    content: acp.ToolCallContent[];
    locations: acp.ToolCallLocation[];
    rawInput: unknown;
    rawOutput: unknown;
    /** When it entered a terminal state (completed / failed / interrupted); null while still running. */
    endedAt: number | null;
};
/**
 * An "outlives the turn" tool that is still pending / in_progress after the session has no live process and its history is fully replayed:
 * its result will never come back. The protocol has no such state; we synthesize it ourselves: without it the UI spins forever
 * and the user thinks the task is still running. Derived only at load time; never written back to any persistence.
 */
export const INTERRUPTED = "interrupted";

export type PlanItem = ItemBase & { kind: "plan"; plan: acp.PlanUpdateContent };
export type CompactionItem = ItemBase & {
    kind: "compaction";
    status: acp.CompactionUpdate["status"];
    summary: acp.ContentBlock[];
    error: string | null;
};
export type Item = MessageItem | ToolItem | PlanItem | CompactionItem;

export type Terminal = {
    id: string;
    command: string | null;
    cwd: string | null;
    output: string;
    exitStatus: acp.TerminalExitStatus | null;
    /** Patched like `ItemBase._meta`; `terminal_output_chunk` metadata is chunk-scoped and only ever adds. */
    _meta: Record<string, unknown> | null;
};

/**
 * A failed or limited turn. Standard JSON-RPC error details and engine-specific metadata
 * remain separate so clients can present the error without interpreting an engine dialect.
 */
export type TurnError = {
    /** Standard failure/limit reason, a legacy implementation-specific `_error`, or `DISCONNECTED`, which this library synthesizes. */
    stopReason: string;
    error: acp.Error | null;
    /** The idle frame's `_meta`, as-is. */
    meta: Record<string, unknown> | null;
};

/**
 * The few judgments needed while folding that the protocol itself cannot answer. All supplied by the app, because the answers live in each engine's dialect.
 */
export type FoldPolicy = {
    /**
     * Whether this tool outlives the current turn.
     *
     * A tool that outlives the turn can only be closed by an out-of-band frame, so the turn ending must not seal it as completed: if sealed,
     * the terminal-state lock below never lets go again and the real result can never be shown. When the session has no live process, conversely, they must be reaped.
     *
     * The criterion is a dialect: alwith-cli looks at `_meta.alwith.runInBackground`, plus the tool name `Monitor`
     * (its start frame carries no marker; only the final out-of-band notification does). So the package does not guess; the app answers.
     *
     * Two corollaries the package handles itself, so the app need not worry:
     * - Sub-tools follow their parent (`parentOf`): steps dispatched by a background subagent live and die with it; not sealed at turn boundaries,
     *   and reaped together.
     * - For a tool that outlives the turn, status only trusts frames that **themselves also declare outliving the turn**. When alwith-cli throws a background command into the
     *   background it emits an unmarked completed within the turn, which only means "already thrown out"; the real terminal state is the marked one after the turn.
     *   Treating the former as terminal locks the task in the completed state and the real result never appears. The way to tell is to ask `outlivesTurn` separately
     *   with this frame's own `_meta`.
     */
    outlivesTurn?: (tool: ToolItem) => boolean;

    /**
     * Who dispatched this tool: a subagent emits its sub-steps as independent tool frames, and the UI must gather them into
     * that subagent for display. The protocol has no such field (v2's `ToolCallUpdate` has no parent/child),
     * alwith-cli puts it in `_meta.claudeCode.parentToolUseId`. Without it everything is flat.
     */
    parentOf?: (tool: ToolItem) => string | null;

    /**
     * Whether `tool_call_update.content` carries this frame's new output or all output so far.
     *
     * The protocol says only "content produced by the tool" for this field and does not settle replace vs. append; the neighboring `name`
     * fields do spell out patch semantics. The two engines really differ: alwith-cli sends only the newly produced segment each frame,
     * codex sends the full content. Guessing wrong is visible either way: treating increments as full leaves a long command with only its last line; treating full as increments doubles the output.
     *
     * Defaults to full, i.e. read with the replace semantics of the `name` fields. An engine that sends increments must declare so.
     * Note: the protocol also has `tool_call_content_chunk` dedicated to increments; that one is always append and is unaffected here.
     */
    toolContent?: "replace" | "append";
};

export type ApplyOptions = {
    /** Decoded terminal output text (the decoder must live across frames; see `SessionStore`). */
    text?: string;
    policy?: FoldPolicy;
};

export type Session = {
    id: string;
    cwd: string;
    title: string | null;
    state: SessionState;
    /** True once `session/new` or `session/resume` succeeded on the live connection. */
    attached: boolean;
    restoring: boolean;
    /**
     * Another Codex client holds the thread's writer lock; the transcript is shown from the
     * read path and nothing can be sent (Codex's own TUI does the same).
     */
    readOnly: boolean;
    error: TurnError | null;
    items: Item[];
    configOptions: acp.SessionConfigOption[];
    usage: acp.UsageUpdate | null;
    lastTurnUsage: acp.Usage | null;
    /** Token usage per turn, keyed by the turn's user message id (from the idle frame). */
    turnUsage: Record<string, acp.Usage>;
    /** When each turn closed (the idle frame arrived), likewise keyed by the id of the user message that started the turn. */
    turnEndedAt: Record<string, number>;
    /**
     * The latest timestamp stamped on this session. All timestamps (item arrival, tool terminal state, turn close) are strictly increasing: events
     * arriving in the same millisecond are ordered by it, so the render layer need not guess who came before or after closing. The few ms of drift do not affect durations.
     */
    clock: number;
    /** `stopReason` of the most recent idle frame; `cancelled` marks an interrupted turn. */
    lastStopReason: string | null;
    commands: acp.AvailableCommand[];
    terminals: Record<string, Terminal>;
    updatedAt: string | null;
    /** The session's own metadata from `session_info_update`, patched like `ItemBase._meta`. */
    _meta: Record<string, unknown> | null;
    /**
     * The record position this session has applied through: the largest `_meta.alwith.seq` any frame carried (an agent stamps
     * a message or tool result with the seq of its persisted record line), or the `cut` of the last replay. -1 until a frame
     * says. A resume asks for `after: appliedThrough`, so only what the record gained since is replayed.
     */
    appliedThrough: number;
    /**
     * The agent's config revision for this session (`_meta.alwith.configRevision` on `config_option_update` and on the
     * session responses): one more every time the options change. A prompt binds to it so a write that landed between
     * what the user saw and what they sent is refused by the agent instead of silently applying. null until the agent said.
     */
    configRevision: number | null;
};

export function createSession(
    id: string,
    cwd: string,
    title: string | null = null,
): Session {
    return {
        id,
        cwd,
        title,
        state: "idle",
        attached: false,
        restoring: false,
        readOnly: false,
        error: null,
        items: [],
        configOptions: [],
        usage: null,
        lastTurnUsage: null,
        turnUsage: {},
        turnEndedAt: {},
        clock: 0,
        lastStopReason: null,
        commands: [],
        terminals: {},
        updatedAt: null,
        _meta: null,
        appliedThrough: -1,
        configRevision: null,
    };
}

/** The record seq a frame carries (`_meta.alwith.seq`), or null. */
export function recordSeqOf(update: acp.SessionUpdate): number | null {
    const alwith = (update as { _meta?: { alwith?: { seq?: unknown } } | null })
        ._meta?.alwith;
    return typeof alwith?.seq === "number" ? alwith.seq : null;
}

function meta(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

/**
 * ACP v2's `_meta` patch (see `ItemBase._meta`): `undefined` leaves `previous` unchanged, `null` clears it, an object
 * patches by top-level key (`null` removes the key, any other value replaces it whole). An empty result is `null`.
 */
export function patchMeta(
    previous: Record<string, unknown> | null,
    incoming: unknown,
): Record<string, unknown> | null {
    if (incoming === undefined) return previous;
    if (incoming === null) return null;
    const patch = meta(incoming);
    if (patch === null) return previous;
    const patched: Record<string, unknown> = { ...previous };
    for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete patched[key];
        else patched[key] = value;
    }
    return Object.keys(patched).length === 0 ? null : patched;
}

/** Chunk metadata is chunk-scoped: it can add to the entity's metadata but a chunk's `null` never clears it. */
function patchChunkMeta(
    previous: Record<string, unknown> | null,
    incoming: unknown,
): Record<string, unknown> | null {
    return incoming === null ? previous : patchMeta(previous, incoming);
}

/** The next timestamp: wall clock, but never equal to or before the previous one (see `Session.clock`). */
function nextStamp(session: Session): number {
    return Math.max(Date.now(), session.clock + 1);
}

/** Folds the largest timestamp among items into the clock (tool terminal timestamps are stamped inside patch, invisible to upsert). */
function bumpClock(session: Session): Session {
    let clock = session.clock;
    for (const item of session.items) {
        if (item.at > clock) clock = item.at;
        if (
            item.kind === "tool" &&
            item.endedAt !== null &&
            item.endedAt > clock
        )
            clock = item.endedAt;
    }
    return clock === session.clock ? session : { ...session, clock };
}

function replaceItem(items: Item[], index: number, item: Item): Item[] {
    const next = [...items];
    next[index] = item;
    return next;
}

function upsertItem<T extends Item>(
    session: Session,
    kind: T["kind"],
    id: string,
    create: (base: ItemBase) => T,
    patch: (item: T) => T,
): Session {
    const index = session.items.findIndex(
        (item) => item.kind === kind && item.id === id,
    );
    if (index === -1) {
        const at = nextStamp(session);
        const base: ItemBase = {
            id,
            at,
            replayed: session.restoring,
            _meta: null,
        };
        return {
            ...session,
            clock: at,
            items: [...session.items, patch(create(base))],
        };
    }
    return {
        ...session,
        items: replaceItem(
            session.items,
            index,
            patch(session.items[index] as T),
        ),
    };
}

/**
 * Agent chunks are streaming increments (per token), adjacent text merges into one block; user message chunks are whole-block replays
 * (alwith-cli emits one frame per persisted content block, one block per resource link), each on its own; merging them would glue two
 * `Resource link: …` lines into one and mangle the paths.
 */
function appendBlock(
    content: acp.ContentBlock[],
    block: acp.ContentBlock,
    streamed: boolean,
): acp.ContentBlock[] {
    const last = content.at(-1);
    if (streamed && isText(block) && last !== undefined && isText(last)) {
        return [
            ...content.slice(0, -1),
            { ...last, text: last.text + block.text },
        ];
    }
    return [...content, block];
}

/** Which message a chunk without messageId belongs to: the immediately preceding message of the same kind (not the locally pre-displayed one), otherwise a new one. */
function anonymousMessageId(
    session: Session,
    kind: MessageItem["kind"],
): string {
    const last = session.items.at(-1);
    return last?.kind === kind && last.echo === null
        ? last.id
        : crypto.randomUUID();
}

const MESSAGE_KINDS: Record<string, MessageItem["kind"]> = {
    user_message: "user",
    user_message_chunk: "user",
    agent_message: "assistant",
    agent_message_chunk: "assistant",
    agent_thought: "thought",
    agent_thought_chunk: "thought",
};

/** See `FoldPolicy.toolContent`. Absent leaves it alone, an explicit null clears it, an array merges per the engine's declaration. */
function mergeToolContent(
    previous: acp.ToolCallContent[],
    incoming: acp.ToolCallContent[] | null | undefined,
    policy: FoldPolicy | undefined,
): acp.ToolCallContent[] {
    if (incoming === undefined) return previous;
    if (incoming === null) return [];
    if (policy?.toolContent !== "append") return incoming;
    return incoming.length === 0 ? previous : [...previous, ...incoming];
}

const RUNNING_STATUS = new Set(["pending", "in_progress"]);

function isRunning(tool: ToolItem): boolean {
    return tool.status !== null && RUNNING_STATUS.has(tool.status);
}

function isTerminal(status: string | null): boolean {
    return status !== null && !RUNNING_STATUS.has(status);
}

/**
 * Does this tool outlive the current turn: yes if it declares so itself, or if a parent (walking up `parentOf`) does:
 * steps dispatched by a background subagent live and die with it.
 */
function outlivesTurn(
    tool: ToolItem,
    session: Session,
    policy: FoldPolicy | undefined,
): boolean {
    const seen = new Set<string>();
    let current: ToolItem | undefined = tool;
    while (current !== undefined && !seen.has(current.id)) {
        if (policy?.outlivesTurn?.(current) === true) return true;
        seen.add(current.id);
        const parentId: string | null = policy?.parentOf?.(current) ?? null;
        current =
            parentId === null
                ? undefined
                : (session.items.find(
                      (item) => item.kind === "tool" && item.id === parentId,
                  ) as ToolItem | undefined);
    }
    return false;
}

function mapTools(
    session: Session,
    map: (tool: ToolItem) => ToolItem,
): Session {
    let changed = false;
    const items = session.items.map((item) => {
        if (item.kind !== "tool") return item;
        const next = map(item);
        if (next !== item) changed = true;
        return next;
    });
    return changed ? { ...session, items } : session;
}

/**
 * Turn close: tools still pending / in_progress are set to completed.
 *
 * The basis is fact, not guesswork: this turn has ended and no more frames belonging to it will come. The protocol does not guarantee every tool receives a
 * terminal frame (a cancelled one does not), and missing one leaves the UI spinning forever.
 *
 * Tools that outlive the turn are excluded: their real terminal state comes by an out-of-band frame, and sealing here would tell the user "this one finished",
 * and once status enters a terminal state, the `tool_call_update` lock below never lets go again.
 *
 * The old rule "a new tool appearing seals the previous one" did not carry over: it assumes the agent runs tools serially, and lies once tools run in parallel.
 */
function sealTurn(session: Session, policy: FoldPolicy | undefined): Session {
    const now = nextStamp(session);
    const sealed = mapTools(session, (tool) =>
        isRunning(tool) && !outlivesTurn(tool, session, policy)
            ? { ...tool, status: "completed", endedAt: now }
            : tool,
    );
    return sealed === session ? session : { ...sealed, clock: now };
}

/**
 * Reaps dangling "outlives the turn" tools, returning a new Session.
 *
 * **The only time to call it**: after loading a session with no live process and consuming the whole history. The criterion is a fact on the ground:
 * the real terminal state of those tools can only be pushed late by the process of that time, and with the process gone, the result will never come back through this session.
 *
 * Sessions attached to a live process must not be touched: they may still receive the real terminal frame.
 */
export function markInterrupted(
    session: Session,
    policy: FoldPolicy = {},
): Session {
    const now = nextStamp(session);
    const marked = mapTools(session, (tool) =>
        isRunning(tool) && outlivesTurn(tool, session, policy)
            ? { ...tool, status: INTERRUPTED, endedAt: now }
            : tool,
    );
    return marked === session ? session : { ...marked, clock: now };
}

/**
 * The message the user just sent, shown on screen first. In the protocol user messages are reported by the agent, but waiting for that report would make the user think it was not sent;
 * we first record a local `echo: "pending"`, precisely claimed by the prompt receipt (see `MessageItem.echo`).
 */
export function addPrompt(
    session: Session,
    content: acp.ContentBlock[],
    id: string = crypto.randomUUID(),
): Session {
    const at = nextStamp(session);
    const item: MessageItem = {
        id,
        at,
        replayed: false,
        _meta: null,
        kind: "user",
        content,
        echo: "pending",
    };
    return { ...session, clock: at, items: [...session.items, item] };
}

/** Match a local optimistic message using its own prompt response, never arrival order. */
export function acknowledgePrompt(
    session: Session,
    localId: string,
    messageId: string,
): Session {
    const local = session.items.find(
        (item) => item.kind === "user" && item.id === localId,
    );
    if (local?.kind !== "user" || local.echo !== "pending") {
        throw new Error(`Unknown pending prompt ${localId}`);
    }
    const remote = session.items.find(
        (item) =>
            item.kind === "user" && item.id === messageId && item !== local,
    );
    if (
        remote !== undefined &&
        (remote.kind !== "user" || remote.echo !== null)
    ) {
        throw new Error(
            `Message ${messageId} already belongs to another prompt`,
        );
    }
    const adopted: MessageItem = {
        ...local,
        id: messageId,
        echo: remote === undefined ? "acknowledged" : "adopted",
        _meta: patchMeta(
            local._meta,
            remote === undefined ? undefined : remote._meta,
        ),
    };
    const items =
        remote === undefined
            ? session.items.map((item) => (item === local ? adopted : item))
            : session.items
                  .filter((item) => item !== local)
                  .map((item) => (item === remote ? adopted : item));
    const turnUsage = { ...session.turnUsage };
    const turnEndedAt = { ...session.turnEndedAt };
    if (localId !== messageId) {
        if (localId in turnUsage) {
            turnUsage[messageId] = turnUsage[localId]!;
            delete turnUsage[localId];
        }
        if (localId in turnEndedAt) {
            turnEndedAt[messageId] = turnEndedAt[localId]!;
            delete turnEndedAt[localId];
        }
    }
    return { ...session, items, turnUsage, turnEndedAt };
}

/**
 * This tool's terminal: found by the protocol's link, the `{ type: "terminal", terminalId }` reference in the tool's output.
 * Do not look up `terminals[tool.id]`: that only works because codex-acp-v2 happens to set terminalId to the toolCallId; on another engine
 * the output would silently vanish.
 */
export function terminalOf(
    tool: ToolItem,
    terminals: Session["terminals"],
): Terminal | null {
    for (const entry of tool.content) {
        if (entry.type !== "terminal") continue;
        const terminal =
            terminals[(entry as { terminalId: string }).terminalId];
        if (terminal) return terminal;
    }
    return null;
}

/** Consumes one `session/update` frame. Terminal output has already been decoded by `SessionStore`. */
export function applyUpdate(
    session: Session,
    update: acp.SessionUpdate,
    options: ApplyOptions = {},
): Session {
    const folded = fold(session, update, options);
    const seq = recordSeqOf(update);
    const advanced =
        seq !== null && seq > folded.appliedThrough
            ? { ...folded, appliedThrough: seq }
            : folded;
    const terminated = instanceTerminationOf(update);
    return terminated === null
        ? advanced
        : markTerminated(advanced, terminated);
}

/** A writer instance of the record ended (`session_info_update` with `_meta.alwith.instanceTerminated`). */
export type InstanceTermination = { instanceId: string; finalSeq: number };

function instanceTerminationOf(
    update: acp.SessionUpdate,
): InstanceTermination | null {
    if (update.sessionUpdate !== "session_info_update") return null;
    const alwith = (
        update as {
            _meta?: { alwith?: { instanceTerminated?: unknown } } | null;
        }
    )._meta?.alwith;
    const terminated = alwith?.instanceTerminated as
        Partial<InstanceTermination> | undefined;
    if (terminated === undefined) return null;
    if (
        typeof terminated.instanceId !== "string" ||
        typeof terminated.finalSeq !== "number"
    )
        throw new Error(
            `malformed instanceTerminated: ${JSON.stringify(terminated)}`,
        );
    return { instanceId: terminated.instanceId, finalSeq: terminated.finalSeq };
}

/** The record seq an item was persisted at (`_meta.alwith.seq`), or null when its line never carried one. */
function itemSeq(item: Item): number | null {
    const seq = (item._meta as { alwith?: { seq?: unknown } } | null)?.alwith
        ?.seq;
    return typeof seq === "number" ? seq : null;
}

/**
 * The agent's writer instance that produced everything up to `finalSeq` is confirmed gone: a tool it left running and a turn
 * it never closed will not get their terminal frames from it. Those become `interrupted`; what a successor wrote after
 * `finalSeq` is untouched. This is the only judgment that may call a turn interrupted without the agent saying so, and it
 * rests on the record, not on a timer or on the client's view of the connection.
 */
export function markTerminated(
    session: Session,
    termination: InstanceTermination,
): Session {
    const now = nextStamp(session);
    const before = (item: Item): boolean => {
        const seq = itemSeq(item);
        return seq === null ? item.replayed : seq <= termination.finalSeq;
    };
    const reaped = mapTools(session, (tool) =>
        isRunning(tool) && before(tool)
            ? { ...tool, status: INTERRUPTED, endedAt: now }
            : tool,
    );
    const lastUser = [...reaped.items]
        .toReversed()
        .find((item) => item.kind === "user");
    const openTurn =
        lastUser !== undefined &&
        !(lastUser.id in reaped.turnEndedAt) &&
        before(lastUser);
    const changed = reaped !== session || openTurn;
    if (!changed) return session;
    return {
        ...reaped,
        clock: now,
        ...(openTurn
            ? {
                  state: "idle" as const,
                  lastStopReason: INTERRUPTED,
                  turnEndedAt: { ...reaped.turnEndedAt, [lastUser.id]: now },
                  error: {
                      stopReason: INTERRUPTED,
                      error: null,
                      meta: { alwith: { instanceTerminated: termination } },
                  },
              }
            : {}),
    };
}

function fold(
    session: Session,
    update: acp.SessionUpdate,
    options: ApplyOptions,
): Session {
    const decodedTerminalText = options.text;
    const messageKind = MESSAGE_KINDS[update.sessionUpdate];
    if (messageKind) {
        const frame = update as acp.UserMessage &
            acp.ContentChunk & { sessionUpdate: string };
        const isChunk = update.sessionUpdate.endsWith("_chunk");
        // The protocol requires every chunk to carry a messageId (chunks of one message share one, a new one means a new message). For those without,
        // fall back to adjacency: if the immediately preceding one is a message of the same kind, merge into it, otherwise start a new one; upserting by id would stuff the whole turn's
        // text into the first message, with everything after it landing before the tools. Recordings from before v2 look like this, and sloppy engines may too.
        const messageId =
            typeof frame.messageId === "string" && frame.messageId.length > 0
                ? frame.messageId
                : anonymousMessageId(session, messageKind);
        if (messageKind === "user") {
            const acknowledged = session.items.find(
                (item) =>
                    item.kind === "user" &&
                    item.id === messageId &&
                    item.echo === "acknowledged",
            );
            if (acknowledged?.kind === "user") {
                return {
                    ...session,
                    items: [
                        ...session.items.filter(
                            (item) => item !== acknowledged,
                        ),
                        {
                            ...acknowledged,
                            echo: "adopted",
                            _meta: isChunk
                                ? patchChunkMeta(
                                      acknowledged._meta,
                                      frame._meta,
                                  )
                                : patchMeta(acknowledged._meta, frame._meta),
                        },
                    ],
                };
            }
        }
        return upsertItem<MessageItem>(
            session,
            messageKind,
            messageId,
            (base) => ({ ...base, kind: messageKind, content: [], echo: null }),
            (item) =>
                item.echo === "adopted"
                    ? {
                          ...item,
                          _meta: isChunk
                              ? patchChunkMeta(item._meta, frame._meta)
                              : patchMeta(item._meta, frame._meta),
                      }
                    : {
                          ...item,
                          content: isChunk
                              ? appendBlock(
                                    item.content,
                                    frame.content,
                                    messageKind !== "user",
                                )
                              : frame.content === undefined
                                ? item.content
                                : frame.content === null
                                  ? []
                                  : [...frame.content],
                          _meta: isChunk
                              ? patchChunkMeta(item._meta, frame._meta)
                              : patchMeta(item._meta, frame._meta),
                      },
        );
    }
    switch (update.sessionUpdate) {
        case "state_update": {
            const frame = update as acp.StateUpdate & {
                sessionUpdate: "state_update";
            };
            if (frame.state === "running")
                return {
                    ...session,
                    state: "running",
                    error: null,
                    lastStopReason: null,
                };
            if (frame.state === "requires_action")
                return { ...session, state: "requires_action" };
            if (frame.state === "idle") {
                const idle = frame as acp.IdleStateUpdate;
                const stopReason = idle.stopReason ?? null;
                const failed =
                    stopReason === "error" ||
                    stopReason === "_error" ||
                    stopReason === "refusal" ||
                    stopReason === "max_tokens" ||
                    stopReason === "max_turn_requests";
                const usage = idle.usage ?? null;
                const turnUser = session.items.findLast(
                    (item) => item.kind === "user" && item.echo !== "pending",
                );
                const sealed = sealTurn(session, options.policy);
                const endedAt = nextStamp(sealed);
                return {
                    ...sealed,
                    clock: endedAt,
                    state: "idle",
                    lastTurnUsage: usage ?? session.lastTurnUsage,
                    turnUsage:
                        usage === null || turnUser === undefined
                            ? session.turnUsage
                            : { ...session.turnUsage, [turnUser.id]: usage },
                    // Record the close time only the first time: if the agent's own idle arrives after the user's Stop, the turn ended at the moment the user stopped
                    turnEndedAt:
                        turnUser === undefined ||
                        turnUser.id in session.turnEndedAt
                            ? session.turnEndedAt
                            : {
                                  ...session.turnEndedAt,
                                  [turnUser.id]: endedAt,
                              },
                    lastStopReason: stopReason,
                    error: failed
                        ? {
                              stopReason,
                              error: IdleStateUpdate.isError(idle)
                                  ? (idle.error ?? null)
                                  : null,
                              meta: meta(idle._meta),
                          }
                        : null,
                };
            }
            return session;
        }
        case "tool_call_update": {
            const frame = update as acp.ToolCallUpdate;
            const updated = upsertItem<ToolItem>(
                session,
                "tool",
                frame.toolCallId,
                (base) => ({
                    ...base,
                    kind: "tool",
                    name: null,
                    title: null,
                    toolKind: null,
                    status: null,
                    content: [],
                    locations: [],
                    rawInput: undefined,
                    rawOutput: undefined,
                    endedAt: null,
                }),
                (item) => {
                    // Omitted fields keep their value; an explicit null clears.
                    const patched: ToolItem = {
                        ...item,
                        name: frame.name === undefined ? item.name : frame.name,
                        title:
                            frame.title === undefined
                                ? item.title
                                : frame.title,
                        toolKind:
                            frame.kind === undefined
                                ? item.toolKind
                                : frame.kind,
                        content: mergeToolContent(
                            item.content,
                            frame.content,
                            options.policy,
                        ),
                        locations:
                            frame.locations === undefined
                                ? item.locations
                                : (frame.locations ?? []),
                        rawInput:
                            frame.rawInput === undefined
                                ? item.rawInput
                                : frame.rawInput,
                        rawOutput:
                            frame.rawOutput === undefined
                                ? item.rawOutput
                                : frame.rawOutput,
                        _meta: patchMeta(item._meta, frame._meta),
                    };
                    if (frame.status === undefined || frame.status === null)
                        return patched;
                    // A tool that declared itself outliving the turn takes its status only from a frame that also declared it (see FoldPolicy.outlivesTurn).
                    // Only its own declaration counts: steps dispatched by a background subagent are sealed and reaped along with it, and their own status frames are accepted as usual.
                    if (
                        options.policy?.outlivesTurn?.(patched) === true &&
                        !options.policy.outlivesTurn({
                            ...patched,
                            _meta: meta(frame._meta),
                        })
                    )
                        return patched;
                    const endedAt = isTerminal(frame.status)
                        ? (patched.endedAt ?? nextStamp(session))
                        : null;
                    return { ...patched, status: frame.status, endedAt };
                },
            );
            // The moment a tool enters a terminal state must also enter the clock, so later items cannot share its instant
            return updated.items === session.items
                ? updated
                : bumpClock(updated);
        }
        case "tool_call_content_chunk": {
            const frame = update as acp.ToolCallContentChunk;
            return upsertItem<ToolItem>(
                session,
                "tool",
                frame.toolCallId,
                (base) => ({
                    ...base,
                    kind: "tool",
                    name: null,
                    title: null,
                    toolKind: null,
                    status: null,
                    content: [],
                    locations: [],
                    rawInput: undefined,
                    rawOutput: undefined,
                    endedAt: null,
                }),
                (item) => ({
                    ...item,
                    content: [...item.content, frame.content],
                }),
            );
        }
        case "terminal_update": {
            const frame = update as acp.TerminalUpdate;
            const current = session.terminals[frame.terminalId] ?? {
                id: frame.terminalId,
                command: null,
                cwd: null,
                output: "",
                exitStatus: null,
                _meta: null,
            };
            return {
                ...session,
                terminals: {
                    ...session.terminals,
                    [frame.terminalId]: {
                        ...current,
                        command:
                            frame.command === undefined
                                ? current.command
                                : frame.command,
                        cwd: frame.cwd === undefined ? current.cwd : frame.cwd,
                        output: decodedTerminalText ?? current.output,
                        exitStatus:
                            frame.exitStatus === undefined
                                ? current.exitStatus
                                : frame.exitStatus,
                        _meta: patchMeta(current._meta, frame._meta),
                    },
                },
            };
        }
        case "terminal_output_chunk": {
            const frame = update as acp.TerminalOutputChunk;
            const current = session.terminals[frame.terminalId] ?? {
                id: frame.terminalId,
                command: null,
                cwd: null,
                output: "",
                exitStatus: null,
                _meta: null,
            };
            return {
                ...session,
                terminals: {
                    ...session.terminals,
                    [frame.terminalId]: {
                        ...current,
                        output: current.output + (decodedTerminalText ?? ""),
                        _meta: patchChunkMeta(current._meta, frame._meta),
                    },
                },
            };
        }
        case "plan_update": {
            const frame = update as acp.PlanUpdate;
            return upsertItem<PlanItem>(
                session,
                "plan",
                frame.plan.planId,
                (base) => ({ ...base, kind: "plan", plan: frame.plan }),
                (item) => ({
                    ...item,
                    plan: frame.plan,
                    _meta: patchMeta(item._meta, frame._meta),
                }),
            );
        }
        case "plan_removed": {
            const frame = update as acp.PlanRemoved;
            return {
                ...session,
                items: session.items.filter(
                    (item) =>
                        !(item.kind === "plan" && item.id === frame.planId),
                ),
            };
        }
        case "compaction_update": {
            const frame = update as acp.CompactionUpdate;
            return upsertItem<CompactionItem>(
                session,
                "compaction",
                frame.compactionId,
                (base) => ({
                    ...base,
                    kind: "compaction",
                    status: frame.status,
                    summary: [],
                    error: null,
                }),
                (item) => ({
                    ...item,
                    status: frame.status,
                    summary:
                        frame.summary === undefined
                            ? item.summary
                            : frame.summary === null
                              ? []
                              : [...frame.summary],
                    error: frame.error === undefined ? item.error : frame.error,
                    _meta: patchMeta(item._meta, frame._meta),
                }),
            );
        }
        case "compaction_summary_chunk": {
            const frame = update as acp.CompactionSummaryChunk;
            return upsertItem<CompactionItem>(
                session,
                "compaction",
                frame.compactionId,
                (base) => ({
                    ...base,
                    kind: "compaction",
                    status: "in_progress",
                    summary: [],
                    error: null,
                }),
                (item) => ({
                    ...item,
                    summary: [...item.summary, frame.content],
                    _meta: patchChunkMeta(item._meta, frame._meta),
                }),
            );
        }
        case "config_option_update": {
            const revision = configRevisionOf(update as { _meta?: unknown });
            return {
                ...session,
                configOptions: (update as acp.ConfigOptionUpdate).configOptions,
                configRevision: revision ?? session.configRevision,
            };
        }
        case "session_info_update": {
            const frame = update as acp.SessionInfoUpdate;
            return {
                ...session,
                title: frame.title === undefined ? session.title : frame.title,
                updatedAt:
                    frame.updatedAt === undefined
                        ? session.updatedAt
                        : frame.updatedAt,
                _meta: patchMeta(session._meta, frame._meta),
            };
        }
        case "usage_update":
            return { ...session, usage: update as acp.UsageUpdate };
        case "available_commands_update":
            return {
                ...session,
                commands: (update as acp.AvailableCommandsUpdate)
                    .availableCommands,
            };
        default:
            return session;
    }
}

/** `TurnError.stopReason` when the connection to the agent was lost while a turn was running; the protocol has no reason for it. */
export const DISCONNECTED = "disconnected";

/**
 * The connection to the agent is gone. A turn that was running there may still be running, but its outcome can no longer reach this
 * session, so it stops showing as running and the turn records why. A later `session/resume` replaces this with what the agent recorded.
 */
export function markDisconnected(session: Session): Session {
    return {
        ...session,
        attached: false,
        restoring: false,
        readOnly: false,
        state: "idle",
        error:
            session.state === "running"
                ? { stopReason: DISCONNECTED, error: null, meta: null }
                : session.error,
    };
}
