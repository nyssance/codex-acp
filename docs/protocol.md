# Live chat metadata additions

These ACP v2 additions preserve the existing client exports and request methods.

- Accepted live user-message echoes carry `_meta.codex.turnId` after native insertion. Steering messages use the same native turn ID as the work they amend; receiving a message does not complete that turn.
- Native assistant-item start emits an `agent_message` upsert with its native ID, initial text and phase, reserving its transcript position before text arrives. Every subsequent text delta carries the same `_meta.codex.phase`, so completion does not reclassify commentary as a final answer or vice versa.
- Native assistant-item completion emits a full `agent_message` upsert, preserving the native message ID, phase, delivery and async questions. `_meta.codex.messageCompleted` is `true`; `messageCompletedAt` is included when the native event supplies its timestamp. This is item completion, not turn completion.
- Runtime `state_update` remains authoritative for whether the session is working or idle. Prompt responses acknowledge acceptance only.
- Live native turn completion upserts its last assistant message with `turnStartedAt`, `turnCompletedAt`, `turnDurationMs` and, when a final answer began, `workDurationMs`. They come from Codex's own turn timestamps; a turn without them carries no timing. These transient measurements are discarded when the turn ends. Terminal exit sends the full aggregate output snapshot so streamed chunks cannot be lost.

A v2 `session/prompt` sent while a turn runs is queued for a new turn, as upstream does. Input for the running turn goes through upstream's [`_session/steering`](steering.md); the steered message is shown as a live `user_message` once Codex records it.

## User shell commands

`_codex/shell/execute` accepts `{ sessionId, command, timeoutMs? }` and forwards to
Codex `thread/shellCommand` on the existing connection after preparing the writable
session. The adapter owns the `sessionId` to `threadId` translation.

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

## Model transport diagnostics

The Responses compatibility proxy emits bounded JSON lines on stderr with the prefix
`[alwith-model-proxy] `. This is diagnostic output, not ACP protocol traffic. Each
HTTP request or WebSocket connection gets a random `requestId`; `started`, `headers`
and one terminal `completed`, `cancelled` or `failed` event share that identifier.
Events include the request stage, target hostname and port, endpoint category,
transport/runtime, elapsed time, request/response byte counts, first-byte timing,
HTTP status, WebSocket close code and a syntax-checked `x-request-id` when available. Error cause chains
contain at most four allowlisted transport codes and `errorNames` contains the
corresponding bounded exception classes, never messages or stacks.

HTTP ingestion adds `requestBody` metadata: `declaredBytes` (null when absent or
invalid), `readBytes`, `decodedBytes`, the allowlisted `encoding`, and the
`IncomingMessage` flags `complete` and `aborted`. `readBytes` are wire bytes before
decompression; `decodedBytes` is the size after the content encoding is removed and
stays null until that succeeded; both are separate from upstream `sentBytes`.

The proxy does not cap an HTTP request: Codex is its only client, and its largest
request is a conversation's own history sent for compaction. A request the proxy
read whole but cannot use is answered with HTTP 400 and `forwardedStatus: 400`, and
names the step that failed: `REQUEST_BODY_DECOMPRESS_FAILED`,
`REQUEST_BODY_PARSE_FAILED` or `REQUEST_BODY_REWRITE_FAILED`. An upload that could not
be read records `REQUEST_BODY_READ_FAILED`. Each is followed by its cause codes.
WebSocket messages keep a 64 MiB limit, and receiver errors retain their allowlisted
codes, including `WS_ERR_UNSUPPORTED_MESSAGE_LENGTH`.

The event `version` is 2. Version 1 had `limitBytes` in place of `decodedBytes` and
the `REQUEST_BODY_TOO_LARGE` code.

No prompt, response text, authorization headers, URL paths or queries, local route
tokens, model identifiers, proxy addresses or environment values are emitted.
`proxyEnv` lists configured proxy variable names only; it does not prove which proxy
was used. `reusedSocket` is available on Node HTTP and remains null on Bun and
WebSocket transports. An empty or unknown error code is recorded as `UNKNOWN`.
The host must validate the schema before including these events in diagnostic exports.
These observations locate the failed stage but cannot identify which remote network
component reset a connection without additional network or server evidence.

## Application connectors

`_codex/apps_installed` and `_codex/apps_read` forward to
Codex `app/installed` and `app/read` respectively, with the same
parameters, results and errors. They are advertised through the existing
extension-method catalog. `CodexClient.installedApps()` returns effective
`enabled` and `callable` state; clients must not treat catalog presence as
permission to call an app. These methods do not change configuration or install
apps. A rejected request is surfaced without automatic retry.

For both ACP protocol versions, an explicit `resource_link` with URI
`app://<id>` becomes a native Codex `mention` input with the link's name and URI.
Ordinary resource links retain their existing text representation. The adapter
does not infer application mentions from ordinary prompt text or enable apps.

## ChatGPT image generation

`_codex/images/generate` accepts `{ prompt: string, images?: string[] }` and
returns `{ images: Array<{ mimeType: string, data: string }> }`, with base64 media.
References must be inline PNG, JPEG or WebP data URLs. The adapter validates the
prompt, reference count and media budget before contacting the image service.
Without references it uses Wham generations; with references it uses edits.

The existing Codex ChatGPT account owns authentication and workspace routing.
Clients never supply or receive account tokens. A 401 permits one token refresh;
ambiguous provider failures are not retried automatically. Failures retain the HTTP
status, bounded structured service message, error code and request ID when supplied.
Credentials and raw response bodies are not forwarded. Account changes and
connection cancellation invalidate pending results. API-key accounts are rejected.

Applications provide their own tools as MCP servers over ACP (the MCP-over-ACP draft):
they declare `{type: "acp", name, serverId}` in `mcpServers` on `session/new`,
`session/resume` and `session/fork`, and answer `mcp/message` on the same ACP
connection. The adapter advertises v1 `mcpCapabilities.acp` and v2
`session.mcp.acp` only when the running Codex binary implements `mcp_2026_07_28`.
Codex reaches these servers like any other HTTP MCP server, through the ACP SDK's
authenticated loopback bridge; the adapter enables `mcp_2026_07_28` for threads that
use one. See [MCP-over-ACP](mcp-over-acp.md). Codex owns these tool calls: approvals
follow its MCP policy and tool annotations, and dropping the HTTP request cancels the
ACP request. The host may expose image generation this way; Codex retains
conversation and media history, and the extension creates no image store.

## Subagent turn origins and reload routing

Standard ACP `subagent_update` carries `_meta.codex.threadId` and the originating
`_meta.codex.parentTurnId` when native delegation provides them. Late origin
information patches the complete `codex` metadata entry so its thread ID is
preserved. Omitted metadata is unchanged; null clears it, following ACP metadata
patch semantics. The association survives child-router replacement during replay. Native
collaboration items remain available in history for clients browsing children
without attaching them.

When a frontend reconnects, `thread/resume` first reuses the connection that
already owns that thread. A changed model catalog must not route the resume to
a second native process and collide with the original writer. Native unload,
close and successful unloading unsubscribe responses release only that
connection's ownership; a later resume can then select the current catalog.

Adapter-owned app-server processes start with `thread_unload_delay_secs=0`,
including native threads created before any gateway is configured.

Native listing and resume responses in some Codex versions omit the source after
unloading a thread. The adapter reads Codex's existing rollout header in that
case; it does not create a source registry or modify native history.


# Host execution parameters

The host owns input-mode validation, model selection, tool policy and application
instructions. The adapter never interprets persisted modes or configuration to
choose an execution policy.

Session creation, load, resume and fork accept `_meta.alwith.nativeTools`.
The optional `imageGeneration` boolean maps to Codex's native
`features.image_generation` and `features.imagegenext` switches. Omitted switches
leave native configuration unchanged. Unknown capability names and non-boolean
values are rejected. This is a capability-specific protocol, not arbitrary Codex
configuration passthrough. Application tools are MCP servers over ACP.
An omitted `nativeTools` field preserves in-memory settings during internal
connection/provider repairs; an explicit object replaces those cached settings.
Hosts resend settings when reopening a session after an adapter restart.

Prompt requests accept `_meta.alwith.applicationContext`, an object
of application-owned keys to strings or null. The adapter converts each entry to
Codex `additionalContext` with kind `application`; null writes an empty value for
that key. Omission leaves context untouched; an empty object does not clear prior
keys. Hosts must explicitly replace or clear previously used keys when needed.
The object is limited to 128 entries and 64 KiB; keys are nonempty and at most 128
characters. User text and attachments remain unchanged. The adapter does not
construct application instructions or recognize image-edit/generation intents.

# Persistent session input configuration

ACP v2 exposes `_codex/session_input_config_get` with `{sessionId}` and
`_codex/session_input_config_set` with `{sessionId, inputConfig}`. An input configuration
contains `mode: string` and `config: JSON object`. Absence means default chat; U does not write an extra record for ordinary chat.
Chat model, provider and reasoning settings remain owned by Codex. The explicit
`{mode: "chat", config: {}}` shape remains readable;
image uses `{mode: "image", config: {model, size}}`. Responses
are `{sessionId, revision, inputConfig}`; an absent configuration returns revision
zero and null inputConfig. ACP v2 advertises `sessionInputConfig: {version: 2}`.

Codex owns these values as `alwith.session-input.v2` thread attachments. Immutable
numeric revision identities preserve the previous configuration throughout writes;
competing writers use the native attachment identity constraint rather than deleting
and replacing an attachment. Reads select the latest revision across all pages.
Transport failures are not automatically replayed. Forks explicitly copy the native
input configuration to the new thread. Native archive and deletion govern the attachment
lifecycle; no separate conversation or configuration registry is created.

A loaded, unsent draft has no persistent attachment owner yet. Read returns no
input configuration after verifying the draft exists; initial writes must follow first
message acceptance. The hosting application retains unsent choices in draft state.
U reads native input configuration on reopen, keeps only a disposable presentation cache
and recent new-conversation choices locally, and does not migrate legacy local records.

The storage boundary validates only the envelope and JSON representation (64 KiB,
maximum nesting depth 32), preserving unknown modes without interpreting their
settings. Object keys are canonicalized so server serialization order does not
create new revisions. The host owns configuration validation and tool routing. Unknown modes remain
readable as opaque data; hosts reject unsupported modes before executing them. Version 1 records are not migrated.

Host input-mode definitions own configuration validation, tool selection and prompt
routing. The adapter validates generic protocol values and translates native tool
switches and application context without understanding input modes.

### Background work

Background work is upstream's: every v2 `state_update` carries the `background` snapshot, and `terminal/cancel` stops one listed terminal. The browser client does not use either yet.

## Plugin-service authentication for hosts

`_codex/plugin_service_auth({refreshToken?: boolean | null})` returns `{backendOrigin, accountId, accessToken}` for the current ChatGPT account, or `null` for a non-ChatGPT account. `refreshToken: true` requests refreshed credentials after HTTP 401. Missing workspace routing, missing credentials, cancellation and account changes reject the request. The account is checked again before returning credentials. This is a host authentication method, not a model tool: never log, persist or add its result to conversation projections. Hosts own HTTP catalog and search requests; this method reads no plugin catalog and issues no plugin search.

## Local image attachments

On a prompt or steer request, an ACP image block with `_meta["alwith.localImage"] = true` and an absolute `file:` URI selects the Codex app server's `localImage` input. The path must be readable on the Codex host. The block's MIME type and data describe its conversation preview. Image input capability checks apply as they do for inline images. An invalid file URI returns invalid parameters. Image blocks without this marker retain their existing URL or inline data behavior.

## Framed history browsing

An adapter advertising `sessionHistory.framedItems: true` also returns `framedItems: true`
on browse turn pages. Read turn metadata with `itemsView: "summary"`. Read bodies with
`_codex/session_history_items`, `mode: "browse"` and `framed: true`. Omit `maxBytes`.
Export and clients requesting their own byte budget retain the existing contract.
The optional `framed` and `fragment` fields treat `null` as omission.

A normal item response carries its native continuation in `nextCursor`. The adapter
reduces the requested count until the result and JSON-RPC envelope fit one 32 MiB frame.
Legacy Codex stores supply items from inline turns, with continuation after the
identified item. Empty turns and their errors come from the metadata page.

An oversized single item returns an empty `items` array and a base64 `fragment` of
the UTF-8 JSON item, its SHA-256 `fragmentDigest`, zero-based `fragmentPart`, and
`nextFragment`. Repeat the original request with `fragment: nextFragment` until
`nextFragment` is null. Decode and concatenate the parts, then parse one item and
advance the item cursor. This preserves message IDs, tool patches, media and omissions.
A changed item fails with `history_changed`; discard partial bytes and retry the
original page. Ordinary item pages have no fragment fields.
