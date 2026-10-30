# Session state: `@nyssance/codex-acp-v2/client`

The state of one ACP v2 session. `session/update` frames go in, a renderable `Session` comes out.

Everyone building a WorkBuddy has to write this layer, and what they write has to come out identical: how a chunk merges into the previous message,
the upsert semantics of tool blocks (omitted fields are kept, an explicit null clears them), UTF-8 decoding of terminal output across chunks,
adding and removing plan entries, compaction progress, and which user message a turn's usage is attributed to. Mistakes here are visible to users: split bubbles,
tool status moving backwards, garbled boxes in the terminal.

Not in here: what a bubble looks like, the composer, tool renderers, themes. That is each WorkBuddy's own face.

```ts
import { createSession, SessionStore } from "@nyssance/codex-acp-v2/client";

const store = new SessionStore();
store.set(createSession(sessionId, cwd));

// Feed each session/update from the agent in and get back the session's new shape
port.onAcpNotification(({ method, params }) => {
    if (method !== "session/update") return;
    const next = store.accept(params.sessionId, params.update);
    render(next);
});
```

`Session` is immutable: every update returns a new object, so the rendering layer can decide whether to redraw with a plain reference-equality check.

## Two views, one state

`session.items` is the flat arrival order, which is what the protocol looks like. Apps that want to read it item by item can use it directly.

UIs are mostly laid out as question and answer, so the package also provides a grouped view:

```ts
for (const turn of store.turns(sessionId)) {
    render(turn.prompt); // the user message that started this turn; the first turn of the history may have none
    for (const entry of turn.entries) render(entry); // this turn's answer, thinking and tools
    showCost(turn.usage); // this turn's usage, delivered by the closing idle frame
}
```

The two views are pure derivations of the same state, and `turns()` does not modify `items`. Child tools dispatched by a subagent are folded into the parent tool's
`children` and do not appear again at the top level. This works across turns too, so a late result from a background subagent does not start a new entry.

Terminals are stored separately in `session.terminals` (output is a byte stream and must keep decoding across frames). A tool's terminal is found through the protocol's link:
the `{ type: "terminal", terminalId }` reference in its output, via `terminalOf(tool, session.terminals)`. Do not guess with
`terminals[tool.id]`; that only works because codex-acp-v2 happens to set the two ids equal.

Every turn carries `startedAt` / `endedAt` and every tool carries `at` / `endedAt`: the UI's "used for 12 seconds" and "thought for 3 seconds"
are these subtracted. A thinking block's end time is the arrival time of the item after it; it is not recorded separately.

## The message the user just sent goes on screen first

When sending, call `store.addPrompt(id, content)` to display the local message immediately, and keep the returned local ID.
A successful `session/prompt` only means the message has been inserted. After receiving the receipt, call
`store.acknowledgePrompt(sessionId, localId, response.messageId)` to claim it precisely. The echo and the receipt may arrive in either order,
and identical content or concurrent requests must not be resolved by guessing from the last message or the content. A local message that has not been inserted does not receive the answer being generated.

The connection layer uses `PromptTracker` to separate the insertion receipt from generation completion:

```ts
const prompts = new PromptTracker();
// Send live session/update to both prompts.accept(sessionId, update) and store.accept.
const completion = await prompts.run(
    sessionId,
    () => agent.request("session/prompt", { sessionId, prompt: content }),
    (response) =>
        store.acknowledgePrompt(sessionId, localId, response.messageId),
);
// The matching idle has been received by now; read stopReason, usage and the end-of-turn _meta from completion.
// On disconnect, abandoned connection or process replacement, call prompts.fail(error) to reject waits that have not completed.
```

`notice` is only a live reminder: it does not change the Session and does not enter chat history or replay. Before a replay, use
`beginReplay()` to clear the already-folded history, so that chunks arriving again with the same ID are not appended twice.

## The to-do ledger: requests the agent is waiting on you to answer

Permissions (`session/request_permission`) and questionnaires (`elicitation/create`) are requests the agent sends and waits for the app to answer.
The protocol requires several things that every implementation must do and whose mistakes users can see; `AgentRequests` does them all in one place: answers carry the original id; when the user hits Stop,
every unanswered permission of that session MUST be answered `cancelled` and every questionnaire `cancel` (if not, the request hangs forever in the agent and the Runtime,
and is replayed as a zombie dialog on the next attach); requests the agent withdraws itself (`$/cancel_request`) are answered -32800 and you are notified to take the dialog down;
`elicitation/complete` closes questionnaires that are still pending; unknown requests are answered -32601 instead of leaving the agent waiting; the batch the Runtime
hands over on attach is treated as just received; when you let go (hand over to another window, or the process is gone), none of them is answered.

```ts
const requests = new AgentRequests((id, result, error) =>
    agent.respond(id, result, error),
);
agent.onAgentRequest((request) => requests.receive(request));
agent.onNotification((method, params) =>
    requests.onNotification(method, params),
);
requests.onChange((pending) => render(pending)); // what dialog to show is up to you
requests.answerPermission(toolCallId, { outcome: "selected", optionId });
requests.cancelSession(sessionId); // Stop
```

## `_meta` accumulates across frames

Each engine spreads item-level facts across different frames: alwith-cli's background marker only arrives in the second frame, the message uuid is in the last frame, and the model is in the first frame.
Replacing frame by frame would wash out the facts that arrived first, so an item's `_meta` is merged layer by layer, with later keys overriding earlier ones. The package does not read
any field inside; it only keeps them.

## What the protocol cannot answer is answered by you

Some judgments the protocol gives no answer to, and the package does not guess; they are handed to `FoldPolicy`. There are currently three.

**Does this tool outlive the turn.**

When a turn ends, tools still in `pending` are set to `completed`: the turn is over and no more frames belonging to it will arrive,
and without sealing them the UI would spin forever. But background commands and long-lived monitors are the exception: their real final state is delivered by out-of-band frames, and sealing them would tell the user
"this one has finished", and once a status enters a final state it can never be changed back.

How to know a tool outlives the turn is a dialect of each engine. alwith-cli looks at `_meta.alwith.runInBackground`,
plus the tool name `Monitor`, whose start frame carries no marker at all; only the final out-of-band notification does.

This criterion has two corollaries that the package handles itself: child tools follow their parent (steps dispatched by a background subagent live and die with it; the turn boundary
does not seal them, and they are reaped together with it); for a tool that has declared it outlives the turn, its status only accepts frames that **also declare it**. When alwith-cli
sends a command to the background it emits an unmarked `completed` within the turn, which only means "it has been thrown out"; the real final state is the marked one after the turn.

**Who dispatched this tool.** A subagent emits its sub-steps as independent tool frames, and the UI has to fold them into that
subagent for display. ACP v2's `ToolCallUpdate` has no parent/child field; alwith-cli puts it in
`_meta.claudeCode.parentToolUseId`.

```ts
const store = new SessionStore({
    outlivesTurn: (tool) =>
        tool._meta?.alwith?.runInBackground === true || tool.name === "Monitor",
    parentOf: (tool) => tool._meta?.claudeCode?.parentToolUseId ?? null,
});
```

**Is tool output incremental or full.** For `tool_call_update.content` the protocol says only "the content produced by the tool",
and does not settle whether it replaces or appends. alwith-cli sends only the newly produced segment in each frame, while codex sends the full content. Read as full, an
`npm install` is left with only its last line; read as incremental, an engine that sends the full content has its output doubled. The default is full; engines that send increments declare it themselves.

It works without any of the three, except that tools are all flat, turn boundaries treat everything alike, and output is read as full.

## Acceptance

Desktop has replay recordings of 36 real sessions. The same ACP frames are fed to its current pipeline and to this package, and both sides are normalized to
"what was said, what was thought, which tools were called in this turn" and compared verbatim. All 36 pass; see
`alwith-desktop/src/features/chat/__tests__/session-package-parity.test.ts`.

The "incremental or full" point above was hit by this step, not thought up. It also revealed that Desktop's subagent
block has no content field and nests only one level; those two are information loss on its side, and the package keeps them and is truly recursive.

Afterwards Desktop really switched to this package: it first recorded the old pipeline's complete `ChatMessage[]` for the 36 replays as a baseline
(`__tests__/goldens`), and the new implementation's output must match it verbatim. The rules hit along the way are all above: `_meta` accumulation,
claiming of local prompts, inheriting outlive-the-turn along the parent-child chain, status accepting only declaring frames, and end times.

When loading a session that has **no live process**, call `store.markInterrupted(id)` after the history is consumed: those dangling tools,
whose results will never come back through this session, are set to `interrupted`. Sessions attached to a live process must not be touched at all.

## Vocabulary follows the protocol, dialects are left to the app

The data model uses ACP's own shapes (`acp.ContentBlock`, `acp.ToolCallStatus`, `acp.PlanUpdateContent`),
and does not invent another set of names. Failed turns retain `stopReason`, standard JSON-RPC `error` details, and the idle frame's `_meta` verbatim.
An absent stop reason remains unknown (`null`), rather than being recorded as a successful `end_turn`.
Message identity includes its type: user, assistant and thought messages may share an ID.

Compactions retain `summary`, `error` and `_meta` with patch semantics: omission keeps the previous value, explicit `null` clears it, and a supplied summary replaces it.
A summary chunk creates an in-progress compaction when its ID is first seen, then appends content in receive order without moving the entity or changing an existing status.

## Division of labor with `@alwith/api/runtime`

`runtime` handles **how to talk to the Runtime**: frames, connections, event dispatch, and `acpRequest` handing an ACP request
out. `session` handles **what an ACP session is**: folding frames into state, the two views, and the criteria the protocol cannot answer.
One is on the wire, the other sits above the wire. Two entry points of the same package, independent of each other.
