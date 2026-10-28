# Live chat metadata additions

These ACP v2 additions preserve the existing client exports and request methods.

- Accepted live user-message echoes carry `_meta.codex.turnId` after native insertion. Steering messages use the same native turn ID as the work they amend; receiving a message does not complete that turn.
- Native assistant-item start emits an `agent_message` upsert with its native ID, initial text and phase, reserving its transcript position before text arrives. Every subsequent text delta carries the same `_meta.codex.phase`, so completion does not reclassify commentary as a final answer or vice versa.
- Native assistant-item completion emits a full `agent_message` upsert, preserving the native message ID, phase, delivery and async questions. `_meta.codex.messageCompleted` is `true`; `messageCompletedAt` is included when the native event supplies its timestamp. This is item completion, not turn completion.
- Runtime `state_update` remains authoritative for whether the session is working or idle. Prompt responses acknowledge acceptance only.
- Live native turn completion upserts its last assistant message with `turnStartedAt`, `turnCompletedAt`, `turnDurationMs` and, when a final answer began, `workDurationMs`. Native timestamps win; notification arrival times cover older native versions without them. These transient measurements are discarded when the turn ends. Terminal exit sends the full aggregate output snapshot so streamed chunks cannot be lost.

Running ACP v2 prompts use native turn steering and return an acceptance receipt without waiting for the foreground turn to finish. Native user-message insertion supplies the original turn identity; commands retain their separate turn lifecycle.
