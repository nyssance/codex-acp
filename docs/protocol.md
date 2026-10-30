# Live chat metadata additions

These ACP v2 additions preserve the existing client exports and request methods.

- Accepted live user-message echoes carry `_meta.codex.turnId` after native insertion. Steering messages use the same native turn ID as the work they amend; receiving a message does not complete that turn.
- Native assistant-item start emits an `agent_message` upsert with its native ID, initial text and phase, reserving its transcript position before text arrives. Every subsequent text delta carries the same `_meta.codex.phase`, so completion does not reclassify commentary as a final answer or vice versa.
- Native assistant-item completion emits a full `agent_message` upsert, preserving the native message ID, phase, delivery and async questions. `_meta.codex.messageCompleted` is `true`; `messageCompletedAt` is included when the native event supplies its timestamp. This is item completion, not turn completion.
- Runtime `state_update` remains authoritative for whether the session is working or idle. Prompt responses acknowledge acceptance only.
- Live native turn completion upserts its last assistant message with `turnStartedAt`, `turnCompletedAt`, `turnDurationMs` and, when a final answer began, `workDurationMs`. Native timestamps win; notification arrival times cover older native versions without them. These transient measurements are discarded when the turn ends. Terminal exit sends the full aggregate output snapshot so streamed chunks cannot be lost.

Running ACP v2 prompts use native turn steering and return an acceptance receipt without waiting for the foreground turn to finish. Native user-message insertion supplies the original turn identity; commands retain their separate turn lifecycle.

### Import settings control plane

The standalone `/import` API is also reachable through the existing initialized
agent connection. `_codex/import/detect` and `_codex/import/history` forward
Codex's detection and persisted history. `_codex/import/run` takes
`{ operationId, request }` and returns the matching completion, not acceptance.
`_codex/import/progress` includes the caller's `operationId` and Codex's progress.
Disconnect rejects the wait; reconnecting clients must inspect history before
retrying. These operations do not create or attach a conversation.

## User shell commands

`_codex/shell/execute` accepts `{ sessionId, command, timeoutMs? }` and forwards to
Codex `thread/shellCommand` on the existing connection after preparing the writable
session. The adapter owns the `sessionId` to `threadId` translation. Initialization
advertises `_meta.codex.shellCommand.version: 1`.

The response acknowledges acceptance. Execution, output, interruption, completion
and replay use the existing session updates and native thread history. The command
runs in the thread directory through its configured shell, with Codex's user-shell
semantics (full access, independent of the agent sandbox). Clients must offer an
explicit shell input mode rather than treating ordinary prompts as commands.

User-initiated command tool calls carry `_meta.codex.commandSource: "userShell"`
on their initial and completed updates, including history replay. Clients can
render these commands with their output visible instead of grouping them into
model work disclosures. Other command sources keep their existing presentation.

When a restored thread's approval policy, reviewer, or sandbox differs from the
built-in presets, its mode is `custom` ("Custom permissions"). Both mode lists
and config options include this current value. Sending `_meta.codex.mode: "custom"`
on resume or fork preserves the thread's permissions without applying overrides.
Selecting the current `custom` mode is a no-op; choosing a preset explicitly
replaces it. Custom settings retain the complete sandbox policy for later turns.
