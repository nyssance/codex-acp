# ACP application client

The adapter owns ACP client state and protocol handling. Runtime transports remain in @alwith/api.

| Entry | Contents |
| --- | --- |
| `@alwith/api/runtime` | The `RuntimeClient` interface and frame protocol types, `WebSocketRuntimeClient` (`alwith-runtime --listen ws://`), and errors |
| `@nyssance/codex-acp-v2/client` | `Agents` / `Agent` (start, attach, swap engine, exit) and `AgentRequests` (the to-do ledger for permissions and questionnaires) |
| `@nyssance/codex-acp-v2/client` | Folds `session/update` frames into one renderable session: `applyUpdate`, `SessionStore`, `turns`. See [session-state.md](session-state.md) for the criteria |
| `@alwith/api/tauri` | `TauriRuntimeClient`: the host's Rust relays the stdio child process through Tauri events |
| `@alwith/api/node` | `ProcessRuntimeClient`: spawns `alwith-runtime --listen stdio://` itself |

All three transports extend `FrameRuntimeClient`; extend it to build your own transport.

```ts
import { WebSocketRuntimeClient } from "@alwith/api/runtime"

const port = new WebSocketRuntimeClient(url, token)
await port.start("codex", { engine: "codex", cwd })
const { sessionId } = await port.sessionNew("codex", cwd)
const { stopReason } = await port.prompt("codex", sessionId, [{ type: "text", text: "Hello" }])
```

## The agents you hold: `Agents`

Starting processes, attaching, swapping engines and exiting are something every WorkBuddy must handle, and getting them wrong causes incidents: starting a second process with the same name,
re-attaching to an old process that is still exiting during an engine swap, or a prompt's `await` hanging forever after the process crashes. `Agents` encapsulates all of this, and what you get is an `Agent`:

```ts
import { Agents } from "@nyssance/codex-acp-v2/client"

const agents = new Agents(port, { info: { name: "my-workbuddy", version: "1.0" } })
// Attach if one is alive (process, context and unanswered requests are all still there), otherwise start one
const attached = await agents.attach(sessionId)
const agent = attached?.agent ?? (await agents.start("chat-1", launch))
attached?.info.pendingAgentRequests   // Requests the agent was still waiting on at attach time; hand them to the AgentRequests ledger
agent.onNotification((method, params) => …)
await agent.request("session/prompt", { sessionId, prompt })   // Fails immediately when the process exits, never hangs
await agents.replace("chat-1", otherLaunch)                     // Swap engine = stop → wait for exit → start
agents.onExit(agent => …)                                       // The process is gone, in sync with the Runtime's exit event
```

A panel that only observes and does not claim should not attach: `attach` means claiming, and once you claim a session you are the one who should answer its permissions. Use the read-only
`agentForSession(sessionId)` to get the agentId, then filter the broadcast `onAcpNotification` / `onAcpAgentRequest` by it.

`Agents` only requires the port to have the `AgentPort` methods (a subset of `RuntimeClient`), so an application's own host port (such as a Tauri relay) works too.

Standard `Agent.request` and `Agent.notify` calls use the official ACP SDK method maps:
parameters and results are inferred from the method literal. Do not provide a response
schema generic for standard methods. Custom `_` methods can supply their own response
and parameter types, as in the SDK. The Runtime still owns transport routing; this does
not create a second SDK connection. The SDK's `cancellationSignal` requests cooperative cancellation: the original
request remains pending until the agent replies or the transport fails. Even a
pre-aborted signal sends the request before `$/cancel_request`, matching the SDK.


The protocol reference is [PROTOCOL.md](../../PROTOCOL.md) at the repo root; this package is its application side.

## Rust SDK

Since 0.1.4, `rust/` inside the package is a Cargo crate that can be embedded in a consumer's workspace, containing the protocol types, the Runtime client and process helpers. Install this package with Bun first, then configure a `path` relative to Cargo.toml:

```toml
[dependencies]
alwith-api = { path = "../node_modules/@alwith/api/rust", features = ["client"] }
```

The example above applies to `src-tauri/Cargo.toml`. A root-level Cargo.toml uses `node_modules/@alwith/api/rust`. Use `default-features = false` if you only need the types. This crate is compiled on the consumer side and does not depend on an upstream Git checkout.

## License and redistribution

See [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md).
ALwith-owned code is proprietary, not open source. You may build, customize, host,
charge for and distribute your own WorkBuddy applications under the included
license, without per-application registration. This does not grant hosted-service
access or rights to separately distributed Rust libraries or Runtime binaries.
The npm artifact includes compiled/minified JS, declarations, necessary assets,
and the Rust SDK source under `rust/`. It does not include the private TS/TSX
implementation or source maps. Minification is not encryption.

### Session lifecycle coordination

`@alwith/api/lifecycle` exports `SessionOperations` and `SessionAdmission`.
Both expose Promise APIs; Effect is an implementation dependency, not a UI requirement.
They keep transient coordination state only. The Runtime owns agent processes and
cross-client ownership; the agent owns the conversation record.

`SessionOperations` orders open, close and delete for an explicit session ID.
Adjacent opens with the same fingerprint share their result. A close or delete
signals cancellation to a running open and rejects queued opens, then waits for
the actual running operation to settle. Already accepted closes and deletes stay
ordered and are never coalesced. An explicit later open runs after those boundaries.
An operation failure rejects that caller and does not prevent subsequent explicit
operations. Idle lanes and their finite workers are released.

`SessionAdmission` orders configuration and prompt preparation. Return a receipt
Promise inside an object from the dispatch callback (`{ receipt }`), then await
that receipt outside admission. This releases admission after dispatch rather than
waiting for a receipt or a whole turn. Use `continueAfterFailure: false` (the third
argument to `enqueue`) when work depends on a preceding configuration change.
Cancellation and permission responses do not enter this queue.

Each coordinator accepts `maxPendingPerSession` (default 256) as an explicit
operational ceiling. Overflow rejects the new operation; it never drops accepted
mutations. Tune this ceiling to the application's measured workload. Closing an
operation is not evidence of remote cancellation, and a missing receipt is not
evidence that a prompt was refused. Callers must fence late receipts against the
original binding and local insertion before changing session state.


`SessionGenerations` provides opaque local attachment identities. Capture at dispatch,
check before applying asynchronous results, and retire on close, stop or replay.
Clear on Agent replacement or disconnect. This works even when a session ID and
its retained transcript survive a stop; it is not a wire-level fencing token.

`PromptTracker` distinguishes acceptance from insertion and completion. A receipt
identifies the submission; only its matching user-message echo followed by an idle
boundary proves completion. Echo and completion may precede the receipt. An idle
for a preceding turn cannot finish an accepted but not yet echoed submission.
Call `failSession` when retiring one session, or `fail` when retiring its connection.
Trackers default to 256 pending submissions and 4096 observed message IDs per
session. Pending overflow refuses dispatch; evidence overflow fails the affected
session's completion tracking with an explicit unknown outcome. Neither claims
remote cancellation or retries a potentially accepted submission.


## Coordinated session lifetime

Applications use one `SessionLifecycle` per connection owner. It composes the
Effect-backed operation/admission queues with attachment generations, cancellable
prompt preparation, bounded creation buffering, replay admission, and a submission
ledger. `beginReplay` retires previous submission evidence without cancelling the
preparation that intentionally requested that replay. Close/cancel intent calls
`cancelPreparing` before entering a destructive-operation lane; successful closure
calls `retire`. Disconnect calls `clear`. Work already sent remains owned until the
peer settles; these methods never claim remote cancellation.

`SubmissionLedger.submit` returns separate receipt and completion promises. Its
bounded snapshots contain only submission identity and evidence: pending, accepted,
explicitly rejected or unknown; a matching live echo; and completion. A transport
failure remains unknown unless a caller supplies evidence of definite refusal.
Historical replay is excluded from live completion evidence. Completed/retired
snapshots are retained in a bounded diagnostic ring, not persisted as conversations.
`PromptTracker` is the compatibility export of this same implementation.

`ReplayCoordinator` admits frames only after a locally requested replay has started;
a late end marker cannot clear another replay and a closed attachment cannot be
revived by a late start marker. `SessionBirths` orders pre-response creation frames,
rejects overflow rather than returning partial success, and fences old creation
responses on disconnect. The `Agents` registry remains the sole process-binding
registry; its Effect scopes release connection subscriptions. Session retirement
never stops a sibling session's shared Agent process.

## Observing Runtime run states

`observeRunStates(port, apply)` subscribes before requesting the initial snapshot.
The callback receives `(sessions, "event" | "snapshot")`; a snapshot that arrives
after a newer event is discarded. Await the returned `ready` promise to observe
setup failures and call `dispose()` when the connection owner is replaced or
unmounted. Disposal also handles a subscription that finishes registering late.
The helper only manages observation; Runtime still owns status and read acknowledgement.

## Projects and conversations without a project

`CodexClient.newSession()` asks the adapter for its remote `~/Documents/ALwith` directory, then sends ACP `session/new` with `_meta.codex.projectId: null`. Passing a directory registers or reuses a native Codex project; passing `options.meta.codex.projectId` selects an existing ID. Codex owns IDs and persistence. Registration errors abort creation.

`_codex/project_context` returns the adapter host's home, Codex chat directory, ALwith chat directory and all project pages. `createChatDirectory: true` creates the ALwith directory. `refreshProjectContext()` exposes this data and retains the last valid catalog on a read failure. A new connection clears context from the previous host.

Project IDs returned by ACP new/load/list use `_meta.codex.projectId`. `sessionGroup` and `groupSessions` project the list using persistent IDs, longest matching registered roots, remote quick-chat directories, then full remaining paths. Inferred display membership is never persisted. Project and thread-project change notifications refresh the catalog and list. API contains no ACP metadata interpretation.
