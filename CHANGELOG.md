## 0.7.91 (2026-11-25)

- The browser client replaces a sent message with `prompt(id, text, {replace: messageId})`. It names the last user message on screen as the tail, shows no local copy, and cuts its history when the agent reports the new message, so a refused replacement leaves the conversation as it was.
- A v2 `session/prompt` can replace a user message that was already sent, together with everything after it. The prompt names the message and the last user message its client saw in `_meta.codex.replace: {messageId, tail}` and carries the new text only. In its place in the session's turn queue the adapter reads the turn that holds the message, checks that the session is idle and that `tail` is still the last user message, removes that turn and every later one with `thread/revert`, and starts the new turn with the removed turn's input: its text replaced, its images, files and mentions kept in order. A turn that took follow-up messages while it ran is one turn, so all of its user input is replaced together. The first chunk of the new user message has `_meta.codex.replaces` with the ID of the first user message of the removed turn, which is where a client or a log cuts its copy of the history; the chunks carry the kept input too. A session with a turn in progress, a history that moved on and an unknown message are refused before anything is removed. Files the removed turns changed stay changed. Declared in `capabilities.session.prompt._meta.codex.replace`. This is a fork extension until ACP has a method that rewinds a session.
## 0.7.90 (2026-11-25)

- `session/resume` applies the `mcpServers` of the request to a session that is already loaded. Codex keeps a loaded thread's MCP configuration, so the adapter remembers the servers each thread was loaded with and, when a resume declares others, unloads and resumes the thread the same way it does for a changed `systemPrompt`. That needs an idle session with a turn on disk and no background terminal; any other session is resumed as it is, and the next resume of the idle session applies the servers. Before, the request succeeded and the thread kept calling the server it was loaded with, which fails with `-33001` once the client has disposed it (agentclientprotocol/codex-acp#804).

## 0.7.89 (2026-11-25)

- The Responses proxy no longer caps an HTTP request at 64 MiB, before or after zstd decompression. A long conversation's compaction request exceeded it once decompressed and was refused locally as "Invalid Responses request body" without reaching the model. WebSocket messages keep their limit.
- A request the proxy cannot use is answered with HTTP 400 and the step that failed: `REQUEST_BODY_DECOMPRESS_FAILED`, `REQUEST_BODY_PARSE_FAILED` or `REQUEST_BODY_REWRITE_FAILED`. These failures are now recorded as failed in the proxy diagnostics; they used to be recorded as completed.
- Proxy diagnostics are version 2: `requestBody.decodedBytes` replaces `limitBytes`, and `REQUEST_BODY_TOO_LARGE` is gone. A host that validates these events must accept version 2.

## 0.7.88 (2026-11-24)

- The browser client's draft sessions are back: `newSession` takes `draft`, `state.drafts`, `isDraft`, `discardDraft` and the `materializeDraft` / `onDraftMaterialized` hooks return, and a draft is listed with its first prompt. A draft stays a session created when a conversation opens.
- Removed again, unused without session-less drafts: the browser client's `previewSession`, and the `_meta.codex.configOptions` choices on a `session/options` preview. The preview still lists the enabled skills of the directory among its commands.
- A new chat is set to standard speed after it is created, as before 0.7.87.
- Workflows run on macOS and no Linux binary is bundled.

## 0.7.87 (2026-11-24)

- Merge upstream 2.10.0 and the three commits after it, and move to Codex 0.172.0.
- From upstream: a v2 `session/prompt` sent while a turn runs is steered into that turn and answered when Codex records it; `session/options` previews a session's settings before it is opened, and `session/new`, `session/resume` and `session/fork` accept initial `configOptions`; each model option carries its reasoning efforts; v2 terminal output uses CRLF; v2 uses standard child sessions and background terminals, so `_subagent_update` and `_async_task_*` are no longer sent on v2.
- The internal "Implement the approved plan." prompt is no longer shown as a user message, as upstream does.
- Asynchronous questions follow upstream: the question is a form elicitation, and an answer is replayed as a completed "Answered questions" tool call. The fork's `_meta.codex.questionReply` and `questionReplyParts` are gone.
- Codex's three spend-limit errors are reported as `quota_exhausted`.
- Background terminals follow upstream: `_codex/terminals/list` and `_codex/terminals/stopAll` are removed, with the client's `listBackgroundTerminals` and `stopBackgroundTerminals`. Upstream's `background` snapshot on state updates and `terminal/cancel` remain.
- Prompt suggestions use the ACP standard: a client that declares `session.promptSuggestions` receives `prompt_suggestions_update`, and the browser client keeps the list as `Session.promptSuggestions`. The `_meta.alwith.capabilities` entry `promptSuggestions` and the `_meta.promptSuggestions` reading are removed; AIR is served as upstream serves it.
- The browser client's `steer()` is removed. A message sent while a turn runs is an ordinary `session/prompt`, which the adapter steers into that turn; the pre-standard `_session/steering` method is still served.
- A session's provider is chosen by the standard initial `model` entry of `configOptions` on session setup; `_meta.alwith.model` is removed. An initial gateway model that is no longer configured is skipped, as the standard says for a stale value. The browser client takes `configOptions` on `newSession`, `open` and `fork`.
- A `session/options` preview lists the enabled skills Codex finds in the directory among its commands, and applies the choices sent in `_meta.codex.configOptions` (the values a draft holds) so its options are those the choices lead to. The browser client's `previewSession` takes them as `configOptions`.
- A disabled skill is no longer offered as a `$name` command.
- The browser client has no draft sessions: `NewSessionOptions` with its `draft` flag, `state.drafts`, `isDraft`, `discardDraft` and the `materializeDraft` / `onDraftMaterialized` hooks are removed, and `newSession` lists every session it creates. `previewSession(cwd, {additionalDirectories?, sessionId?})` reads `session/options` instead, without creating anything; an application keeps an unsent conversation as its own data and creates the session with its first message.
- `CodexClient.newSession` starts at standard speed by sending `fast-mode: false` as an initial option, unless the caller chose a value, instead of switching Fast off after the session was created; a new-session preview shows that value.
- Removed with no client using them: the hook methods on v2, the goal data on v2 session info, and the full terminal output re-sent on exit.

## 0.7.86 (2026-11-22)

- Every session runs in one Codex app-server, whatever its provider. The adapter no longer starts a separate app-server per gateway; Codex 0.168 and later keep each thread on its own provider in one process.
- A chat still moves between the native provider and gateways turn by turn, with its history.

## 0.7.85 (2026-11-22)

- A v2 `session/prompt` sent while a turn runs is queued for a new turn, as upstream does. It is no longer turned into a steer. Input for the running turn goes through upstream's `_session/steering`.
- The client package has `steer(sessionId, prompt)`, which calls `_session/steering` and reports `injected` or `promptRequired`.
- `_meta.alwith.applicationContext` applies to prompts only.
- Upstream-owned files are back to upstream's code wherever the fork differed only in style.

## 0.7.84 (2026-11-22)

- Merge upstream 2.9.0 and move to ACP SDK 2.9.1 (v2 schema `2.0.0-beta.3`).
- `auth/status` is served on ACP v1 and v2, and `auth/status_update` reports changes next to `_auth/status_update`.
- V2 `session/new`, `session/resume` and `session/fork` reject MCP declarations the connection did not advertise, duplicate names and relative stdio commands with `-32602`.
- A cancelled prompt that Codex still inserts answers with its `messageId`; one that never lands answers `-32800`. `session/cancel` stops Codex-initiated foreground work, and later prompts wait for its idle.
- Lost root observability is reported as `unknown`. V2 replay no longer carries historical child configuration.
- Permission descriptions and subagent roles keep indentation and line breaks.
- `session/delete` right after `session/close` waits for Codex to finish unloading the thread instead of failing.

## 0.7.81 (2026-11-18)

- Register selected folders by exact project root and keep unassigned nested folders separate in project lists.

## 0.7.80 (2026-11-18)

- Upgrade Codex to 0.170.0 and regenerate the experimental app-server bindings: recovered answers carry a `show` / `hide` / `block` display mode, and user verification reports the biometric type.

## 0.7.79 (2026-11-17)

- Preserve a session's native model identity when provider catalogs initialize after the session.
- Adopt user-message echoes in place so late receipts do not reorder the transcript.
- Expose transient ChatGPT plugin-service authentication separately from host catalog and search requests.
- Share gateway compaction request and response handling across HTTP and WebSocket, including continued conversation after compaction.

## 0.7.78 (2026-11-17)

- `Agent` in `./client` runs the SDK's own client connection over the Runtime port: the handshake, requests in both directions, their cancellation and their answers go through it, and the SDK refuses any protocol version but 2.
- `Agent.registerMcpServer` registers an MCP server the agent reaches over this connection; the SDK's MCP-over-ACP provider serves `mcp/message` (binding, cancellation and its errors), so clients no longer implement the binding themselves.
- Agent requests the Runtime hands over on attach enter the connection through `Agent.receive`. The standalone `initialize` and `ProtocolVersionError` exports are removed.

## 0.7.77 (2026-11-17)

- Applications provide tools as MCP servers over ACP (`type: "acp"` in `mcpServers`, `mcp/message`), following the MCP-over-ACP draft; the adapter advertises the `acp` MCP capability and serves these servers to Codex on a token-protected loopback endpoint. Codex owns the calls, their approvals and their cancellation, as for any MCP server.
- `Agent.respond` in `./client` passes an error's `data`, so a client can answer with the binding error details MCP-over-ACP defines.
- The private client tool channel is removed: `_meta.alwith.tools`, `_alwith/tool/call`, Codex dynamic tools for client tools, and the `_meta.alwith.tool` permission identity.

## 0.7.76 (2026-11-17)

- Client tool sets no longer carry a `revision`, and `_alwith/tool/call` and the permission identity no longer carry `toolSetRevision`. Each new, resumed or forked session replaces its declared tools, so the name identifies the tool.

## 0.7.75 (2026-11-17)

- Export `prependHistory`, `projectHistoryTurns` and `readHistoryPage` from `./client` again; module-chat's history tests use them, and 0.7.73 removed them.

## 0.7.74 (2026-11-17)

- Remote plugins are no longer enabled or disabled by the adapter. It called ChatGPT's plugin service with the Codex login, which Codex itself does not do; `_codex/plugin_set_enabled` now rejects `remotePluginId`, and `CodexClient.setPluginEnabled` takes only the plugin id and state. Remote plugins are enabled in ChatGPT, and Codex picks the state up when it reconciles.

## 0.7.73 (2026-11-17)

- Remove extension surface no ALwith application uses: the `_codex/import/*` methods and the `./import` package export; realtime `appendAudio`, `appendText`, `appendSpeech` and `listVoices`; `_codex/apps_list`, `_codex/mcp_status` and `_codex/mcp_tool_call` with `CodexClient.callMcpTool`; the browser client's hooks and goal methods and `onFileSearchUpdate`, with the fuzzy file search session notifications; the `configRevision`, `hooks` and `goal` initialize flags; and the client re-exports of internal history and project helpers.

## 0.7.72 (2026-11-17)

- Merge upstream 2.7.0: a Codex hook that blocks or stops a prompt or tool call is reported as a warning with the hook's reason, instead of a silent empty turn. Over v2 the notice carries `_meta.codex.turnId` like the other notices.
- A failed v2 turn's `codex-error:<turnId>` message is sent once; the terminal error and `turn/completed` both sent it.
- A v2 question reply keeps the notification's `_meta` (the turn id) when it becomes a `user_message`.
- A resumed built-in `:workspace` thread with auto review restores as Agent again when an approvals reviewer is configured; the configured default no longer overwrites the thread's own reviewer.
- Two v2 prompts sent during one running turn are steered in arrival order through upstream's steering queue, which also checks their content, instead of reaching Codex at the same time.
- A provider catalog change queued behind a failing one runs instead of failing with that error.
- Provider app-servers are stopped by upstream's `CodexAppServerSupervisor`, which also abandons a child that ignores SIGTERM and stops one whose stdout ended.
- `docs/ALWITH-MIGRATION.md` lists every difference from upstream: the fork-only surface, the upstream behavior the fork changes, and the registered workarounds, with the surface no app uses yet.

## 0.7.71 (2026-11-16)

- Add background-terminal listing and stop-all controls on both ACP versions, with typed client methods. Stop-all snapshots every page before terminating processes, verifies removal, reports individual failures, and leaves later processes running. Session close reuses the same cleanup implementation.
- Diagnose request uploads with bounded byte counts, allowlisted content encodings, completion and abort flags, and safe exception names. Oversized Responses requests return HTTP 413 without contacting the upstream; interrupted reads and WebSocket receiver failures retain their transport codes without exposing request content or credentials.
- Keep unassigned history in quick chats when a default chat directory is also a registered project. Broad roots such as the home directory no longer absorb unrelated child projects; explicit project assignments remain authoritative.
- Preserve user-shell command provenance during history replay.

## 0.7.70 (2026-11-15)

- Fix compaction on a thread that started on OpenAI and then moved to a gateway model (DeepSeek, Anthropic, any custom provider). Codex cannot change a thread's model provider, so such a thread stays on the built-in OpenAI provider and Codex asks the gateway for a server-side compaction that only OpenAI implements. Every turn after the switch and every `/compact` ended with `Error running remote compact task`. The local Responses proxy now implements that protocol for gateways: a request ending in `compaction_trigger` asks the gateway model for the handoff summary Codex itself uses when it compacts locally, the answer goes back to Codex as the single `compaction` item it requires, and that item is turned back into the summary message in later requests, whichever upstream they go to.
- Web search works on DeepSeek. Codex offers every model OpenAI's hosted `web_search` tool, which DeepSeek accepts and never runs. For a gateway that declares DeepSeek's search endpoints (`_meta.alwith.webSearch: "deepseek"` on `providers/set`: `/v1/tools/search` and `/v1/tools/fetch` under the gateway's origin and credential) the proxy now runs it: the model gets `web_search` and `web_open_page` functions instead, the proxy answers them from those endpoints and lets the model continue within the same response, and Codex receives each call as the `web_search_call` item it gets from OpenAI, so clients show the same search entries. Other gateways are unchanged.

## 0.7.69 (2026-11-15)

- Upgrade the ACP SDK to 2.7.0, ahead of upstream. `prompt_suggestions_update` passes through to v2 clients unchanged; `configOptions` on a v2 `session/fork` is accepted and not applied, as on `session/new` and `session/resume`. New in the SDK and unused: `replay_complete`, skills in `available_commands_update`, the `speed` configuration category.
- ws 8.23.0 and opencodex 2.100.3.

## 0.7.68 (2026-11-15)

- Upgrade Codex to 0.169.0 and regenerate the experimental app-server bindings. Replayed failure messages carry the new required `moderation` field. New in the bindings and unused: agent message moderation display, thread environments and `attachedToThreadId`, deferred item output, model provider configuration (`modelProvider/list`, `modelProvider/config/write`), `account/securitySetup/read` and `thread/prepareApprovedPlan`.

## 0.7.67 (2026-11-15)

- Merge upstream: ACP SDK 2.6.0, pinned with a tilde as upstream pins it. Delegated tasks are reported as `session_message` updates on both the sender and the child session, linked with `senderMessageId` and `recipientMessageId`; the `spawnAgent` call is no longer shown, and other collaboration calls reference their receivers with `session` tool call content. A child's `description` is the role Codex assigned, never the task prompt.
- The fork keeps its additions on top of that: standard subagent cancellation, and `_meta.codex.threadId` / `parentTurnId` on `subagent_update`.
- The AIR retry warning shows the retry cause as its details (upstream).
- `_codex/session_history` renders collaboration calls without session references, since no session is attached to that request.
- Codex 0.167.2 and other in-range dependency updates. `typecheck` runs through `bun check`.
- Codex 0.167.2 can report a thread as not loaded just before it finishes closing it, and rejects a resume in between. Changing `systemPrompt` on `session/resume` and switching providers now wait for `thread/closed` and retry the resume once.

## 0.7.66 (2026-11-12)

- Identify application tool permission requests.

## 0.7.65 (2026-11-11)

- Retry transient Codex turn-registration failures when cancelling standard subagents, including cancellation from a parent session. Reuse the existing bounded turn-interruption retry policy and stop retries when the selected child turn ends, changes, or becomes unobservable.

## 0.7.64 (2026-11-10)

- Persist opaque session input configuration through `_codex/session_input_config_get/set` in Codex thread attachments. Hosts own mode validation and configuration semantics; the adapter does not maintain a separate conversation store.
- Replace image-specific execution policy with host-provided native tool settings and application context. Preserve native tool settings during client recovery and leave user text and image attachments unchanged.
- Copy input configuration when forking sessions. Read the source before creating a fork and release the failed fork subscription if configuration copying or finalization fails, while respecting concurrent session ownership.

## 0.7.63 (2026-11-10)

- Gateways can speak Anthropic Messages. `providers/set` accepts `apiType: "anthropic"` with the Messages endpoint as `baseUrl` and the API key as `_meta.codex.bearerToken`; `providers/list` reports `supported: ["openai", "anthropic"]`. Codex still sends Responses requests: the adapter's local proxy translates each one to Messages and the answer back, so sessions, tools, approvals and compaction stay Codex's. The translation is the core of opencodex 2.100.0, built into the bundle; it needs the Bun runtime. Verified against a scripted Messages endpoint, not yet against Anthropic's API.

## 0.7.62 (2026-11-10)

- Merge upstream: ACP SDK 2.5.0; checklist plans from `update_plan` are `items` `plan_update`s with `planId` `codex-structured-plan`; fast mode sends the `fast` service tier (Codex reports it back as `priority`, which still reads as fast).
- Follow upstream where the fork duplicated it. Session titles in the list and in history are normalized as upstream normalizes them (whitespace collapsed, 256 characters) instead of the first line cut at 120. A custom permission profile resolves to the mode upstream picks from the allowed list. Fork lineage pages through upstream's history paging, with its timeout. `_codex/skills_list` omits the skills the adapter disables.
- Removed: `capabilities._meta.codex.rename`. The exported client reads rename support from the standard `capabilities.session.title`; `hasRename` and `codexExtensionCapabilities(agent).rename` keep their meaning.
- Changing `systemPrompt` on `session/resume` works again. Since 0.7.60 the app-server unloads a detached thread at once and refuses a resume while it closes; the adapter now waits for the unload before it resumes.
- Source formatting follows upstream throughout. No behavior change.

## 0.7.61 (2026-11-09)

- Restore `thread/status/changed` with `notLoaded` as the provider-switch unload signal. Keep immediate thread unloading and the image-session improvements from 0.7.60.

## 0.7.60 (2026-11-09)

- Route application image sessions through the selected image model. Per-request image intent reaches Codex as additional context without changing user text or attachments; session routing survives resume and fork, and inline image attachments remain images during history replay.
- Preserve bounded image-service error messages, error codes and request IDs alongside the HTTP status, while redacting credentials and image data. Ambiguous failures are not retried automatically.
- Start adapter-owned app-server processes with immediate thread unloading so a detached writer cannot block the next provider.

## 0.7.59 (2026-11-09)

- Approval reviews on a gateway session run on a model the gateway serves. A gateway model's `auto_review_model_override` defaults to itself instead of Codex's native `codex-auto-review`, which a third-party endpoint such as DeepSeek rejects; a reviewer named by the provider catalog resolves to that model's alias on the same gateway, and one the gateway does not list is a registration error.

## 0.7.58 (2026-11-09)

- Composer predictions are upstream's predicted follow-up prompt. A client that declares `clientCapabilities._meta.alwith.capabilities: ["promptSuggestions"]` receives `_meta.promptSuggestions` on `session_info_update` after each completed turn, as AIR does; the exported client declares it and reads it with `promptSuggestion(session._meta)`. Removed: `_codex/session_prediction_request`, the `composerPredictions` capability flag, `requestPrediction` and `composerPrediction` on the client, and the fork's ephemeral prediction thread.
- Merge upstream codex-acp 2.6.0. The upstream prompt suggestion (AIR clients) samples the session thread with `thread/sample` instead of forking it, and skips plan mode and turns that did not complete; approval prompts carry the command as their title so Zed labels them. Shell-wrapped commands are unwrapped for display only when the quoting is recognized.

## 0.7.57 (2026-11-06)

- Upgrade Codex to 0.167.0 and regenerate the experimental app-server bindings. An `audio` input may now reference an upload by `fileId`, rendered like an image upload; `thread/section/changed` is received and ignored like the other thread bookkeeping notifications. New in the bindings and unused: guardian review (`thread/guardianReview`).

## 0.7.56 (2026-11-05)

- `session/list` is answered by the upstream session index for a client that declares `_meta.alwith.capabilities: ["sessionIndex"]`, with standard rows: top-level `archived`, `_meta.codex.{projectId,nativeSessionId,forkedFromId}`, titles repaired where the native preview starts with a prompt envelope. The exported client declares it. Removed: `_codex/session_list`, the fork's own list and rollout fork index, and `threadSource` on `session/new`, `session/fork`, lineage and `SessionSummary`. A v2 client that declares neither index gets upstream's legacy list and archive-on-delete.
- A failed turn's `_meta.codex.error` carries the adapter's own failure classification, the one its AIR session failures use: `kind` (`CodexFailureKind`), `category` and `actions`. The fork's second taxonomy (`category` such as `usage_limit`, `retryable`, `stopReason`) is gone; `codexTurnError` returns `kind`, `category`, `actions` and `retryable` derived from `actions`. Retrying a failed turn follows the same policy.
- Reply envelopes are parsed by upstream's `parseAsyncQuestionReply`; session titles are derived with upstream's attachment-envelope reader. The fork's `sessionConfig.ts` is gone.
- An external provider's HTTP 402 (DeepSeek's exhausted balance) reaches Codex as its usage-limit error instead of a retried connection failure. The turn error names the provider host, the 402 and the provider's message, and the thread keeps it; the proxy diagnostic records the upstream status.

## 0.7.55 (2026-11-04)

- Filter restricted subagent sessions from the ACP v2 `session/list` and overlay their `additionalDirectories`, as the other list paths do.
- Send `useStateDbOnly` with `thread/list`, matching upstream.
- ACP v1 session responses no longer carry `_meta.codex` lineage, matching upstream; v2 keeps it.
- Remove fork copies of upstream helpers and the unused `CodexImportClient.detect` and `readHistories` wrappers.
- `codexExtensionCapabilities` also reports `providerCatalog`, `realtime` and `sessionHistory`; `supportsCodexRealtime` takes the initialize response.
- Document every fork-only method, its native counterpart and consumer in `docs/ALWITH-MIGRATION.md`.

## 0.7.54 (2026-11-04)

- Replace `_codex/session_rename`, `_codex/session_archive`, `_codex/session_unarchive` and `_meta.codex.archived` with the standard ACP `session/set_title`, `session/archive`, `session/unarchive` and the `session/list` `archived` filter.
- Render `_codex/session_history` with the same upstream path as `session/load`; the adapter fits history pages to `maxBytes`. Structured async question replies are kept in history.
- Reject incomplete gateway registrations: `providers/set` requires `_meta.codex.id` and `name`, and each model requires a label.
- Report protocol facts without filling them in: tools still open at turn end are `interrupted`, a disconnected session is `unknown`, message frames without a `messageId` are rejected, and an omitted `availableCommands` list means none.
- Composer prediction failures carry a `message`.
- The exported client uses the generated Codex types for skills, plugins, account and file search; `fuzzyFileSearch` takes `cancellationToken` and accounts carry `workspaceRouting`.
- Remove unused extensions: config snapshots, read state, Bedrock, the permission list, `seedHistory`, the `includeNative` and `anchorItemId` history parameters, `state_update` message ids and the capability flags no client reads.
- Register the remaining Codex and backend workarounds in `docs/fallbacks.md`.

## 0.7.51 (2026-11-02)

- Route Responses HTTP/SSE and WebSocket traffic through an authenticated native network host when configured, allowing Windows clients to use native TLS and system proxy resolution.
- Route gateway model discovery and remote plugin enablement through the same host, preserving native routing across redirects and stripping credentials on cross-origin redirects.
- Correlate native transport failures with bounded, credential-free proxy diagnostics without retrying through Bun or bypassing the selected proxy.
- Add macOS and Windows transport coverage for streaming, cancellation, WebSocket lifecycle, authentication failures, and auxiliary requests.

## 0.7.50 (2026-11-02)

- Keep per-session model routing compatible with Codex's immutable provider identity, including native history restored after unused gateways are removed.
- Preserve native model metadata and decode logical model aliases before forwarding Responses requests.
- Drain final provider-process messages before recovery and reload MCP configuration across all provider processes.
- Preserve configured environment credentials when routing custom providers through native history without forwarding unrelated native credentials.

## 0.7.49

- Update ACP SDK to 2.2.0 and merge upstream session setup, shutdown, configuration, and replay fixes through 927c480.
- Preserve ALwith goal and thread metadata together when resynchronizing sessions; use upstream replay initialization to clear stale entity metadata.
- Apply ACP v2 usage cost patch semantics in the exported client: omitted retains, null clears, and a value replaces.

# Changelog

## 0.7.48 (2026-10-30)

- Preserve custom approval policies, reviewers, and complete sandbox settings when restoring or forking sessions, and expose the current custom mode in permission selectors.
- Add correlated, bounded HTTP and WebSocket proxy diagnostics without logging credentials, request content, response text, or routing tokens.
- Report interrupted upstream streams as transport failures without inserting diagnostic text into streamed responses.

## 0.7.45 (2026-10-30)

- Sync upstream through `ac8d925`, including standard subagent sessions, async question elicitations, prompt suggestions, file citations, and session lookup improvements.
- Upgrade Codex to 0.166.0 and regenerate experimental app-server bindings.
- Prefer upstream fixes and session setup serialization while retaining ALwith provider routing, message metadata, and cancellation cleanup.

## 0.7.44 (2026-10-29)

- Keep model-provider routing tied to the native session connection and recover failed threads that ignore provider overrides.
- Normalize reasoning history when switching between native and external Responses providers.
- Expose native shell commands and preserve user-shell command metadata in live updates and history replay.

## 0.7.42 (2026-10-28)

- Accept `openai/form` and `openaiForm` MCP elicitation aliases as structured forms instead of silently cancelling them.
- Surface Guardian failure and interruption warnings while suppressing duplicate approval review summaries.

## 0.7.40 (2026-10-28)

- Preserve live ACP v2 message positions, phases, native turn identity, completion markers, and turn/work timing.
- Accept prompts during native turns as steering input; keep command turns serialized and retain native lifecycle ownership.
- Reconcile complete ACP v2 terminal output on exit without duplicating ACP v1 output.
- Repair stale tool and terminal history without losing newer live messages or changing their positions.

## 0.7.39 (2026-10-27)

- `@alwith/api` is a plain peer dependency of the `./client` entry, no longer marked optional: a consumer of the client always has it, and one shared copy keeps the api's error classes identical across packages.

## 0.7.38 (2026-10-27)

- Ship `CodexClient` on the `./client` entry: `@alwith/api/client`'s SessionClient plus every `_codex/*` extension (full session list, archive, history browsing and export, skills, plugin marketplaces, rate limits, file search, retries, predictions, fork lineage, realtime). ALwith U's `codex-extensions`, history readers and activity preview move here with their tests.
- The `./client` entry now depends on `@alwith/api` (peer, `>=0.4.22`) and keeps it external in the bundle.

## 0.7.31 (2026-10-23)

- Restore fork boundary metadata in fork, load, and context-only resume responses for ACP v1 and v2.
- Derive fork boundaries from persisted native turn history so they remain available after branches continue and processes restart.
- Propagate fork history errors instead of reporting an empty boundary.

## 0.7.30 (2026-10-23)

- Upgrade Codex to 0.164.0 and regenerate experimental app-server bindings.
- Preserve generated image attachment IDs and local file references in ACP v1 and v2.
- Verify concurrent client tool calls complete independently and retain response identity.

## 0.7.29 (2026-10-23)

- Base the adapter on official codex-acp while retaining the existing package and executable names.
- Preserve ALwith provider catalogs, host tools, configuration revisions, native history, retries, predictions, and asynchronous questions.
- Correlate turn states with prompt receipts; preserve replay identity, timing, interrupted status, and failed-turn transcript messages.
- Replay fork history before replying and isolate cancellation cleanup by opening-request ownership.
- Publish tagged releases through npm Trusted Publishing and synchronize upstream through reviewed merge PRs.

## [2.5.0](https://github.com/agentclientprotocol/codex-acp/compare/v2.4.0...v2.5.0) (2026-10-29)


### Features

* publish a predicted follow-up prompt as _meta.promptSuggestions ([#703](https://github.com/agentclientprotocol/codex-acp/issues/703)) ([87569c5](https://github.com/agentclientprotocol/codex-acp/commit/87569c5a9e095ee99acf83d0d7062c9835f2d176))


### Bug Fixes

* update ACP SDK to 2.1 and align protocol behavior ([#704](https://github.com/agentclientprotocol/codex-acp/issues/704)) ([597a037](https://github.com/agentclientprotocol/codex-acp/commit/597a03767ebd3356825284efae8746e84b1dd1bd))

## [2.4.0](https://github.com/agentclientprotocol/codex-acp/compare/v2.3.0...v2.4.0) (2026-10-29)


### Features

* add batch session metadata lookup ([#669](https://github.com/agentclientprotocol/codex-acp/issues/669)) ([0539d3d](https://github.com/agentclientprotocol/codex-acp/commit/0539d3da63948f55be3a90727fc550db40c5e8bb))
* add live standard ACP subagent sessions ([#682](https://github.com/agentclientprotocol/codex-acp/issues/682)) ([fe3ae92](https://github.com/agentclientprotocol/codex-acp/commit/fe3ae92487f991fe456541f3e9344732faeadac7))
* replay recorded subagent conversations ([#684](https://github.com/agentclientprotocol/codex-acp/issues/684)) ([bbe14f6](https://github.com/agentclientprotocol/codex-acp/commit/bbe14f6661bb90027938374346f15cc7254708a6))


### Bug Fixes

* explain an unreachable ChatGPT backend as a connection failure ([#697](https://github.com/agentclientprotocol/codex-acp/issues/697)) ([b7ca688](https://github.com/agentclientprotocol/codex-acp/commit/b7ca6881c4b45f53a7e929d31427c4a4a3a7fe89))
* recover recorded paths for known subagents ([#687](https://github.com/agentclientprotocol/codex-acp/issues/687)) ([6cce035](https://github.com/agentclientprotocol/codex-acp/commit/6cce03545eaaf5daef849aa9647d4ccfdc22eb41))
* render Codex file citations as Markdown links, parsed the way Codex does ([#698](https://github.com/agentclientprotocol/codex-acp/issues/698)) ([3f6d371](https://github.com/agentclientprotocol/codex-acp/commit/3f6d371b142efc1bc7efe66de665c511d7744a6c))
* support a host-owned idle steering fallback ([#593](https://github.com/agentclientprotocol/codex-acp/issues/593)) ([356abaf](https://github.com/agentclientprotocol/codex-acp/commit/356abaf0e7b5194489b62304011a37e5b02f1184))
* update codex to 0.165.0 ([#692](https://github.com/agentclientprotocol/codex-acp/issues/692)) ([e0de9bb](https://github.com/agentclientprotocol/codex-acp/commit/e0de9bb4662481fa8210ce32ff246af82cebe6c3))


### Performance Improvements

* no rollout reads and no archived listing for the session list ([#689](https://github.com/agentclientprotocol/codex-acp/issues/689)) ([582e545](https://github.com/agentclientprotocol/codex-acp/commit/582e545eb1868763645ea59b1a2c106e50d5d471))

## [2.3.0](https://github.com/agentclientprotocol/codex-acp/compare/v2.2.2...v2.3.0) (2026-10-26)


### Features

* add ACP v2 support again ([#620](https://github.com/agentclientprotocol/codex-acp/issues/620)) ([9e1690f](https://github.com/agentclientprotocol/codex-acp/commit/9e1690ff79aad55f173721907c7a65d9fe8b8d64))
* mark session list rows of worktrees Codex made (agentWorktree) ([#631](https://github.com/agentclientprotocol/codex-acp/issues/631)) ([aa02d43](https://github.com/agentclientprotocol/codex-acp/commit/aa02d439f2d7a47a1338c9db92b62780555a460b))
* narrow models to what the providers/set gateway lists ([#627](https://github.com/agentclientprotocol/codex-acp/issues/627)) ([3f555f9](https://github.com/agentclientprotocol/codex-acp/commit/3f555f9cd9566b759aef2711d1dbec1e3220dfa3))
* report the model of each native subagent session ([#678](https://github.com/agentclientprotocol/codex-acp/issues/678)) ([51005a6](https://github.com/agentclientprotocol/codex-acp/commit/51005a6e11fd2cb7caa2d27fcfdd5ad0fbf41027))
* return initial ACP v2 session commands ([#652](https://github.com/agentclientprotocol/codex-acp/issues/652)) ([5e9b7c5](https://github.com/agentclientprotocol/codex-acp/commit/5e9b7c55a023683829559d6c5c90a3bc3af5903b))
* support AIR sessionIndex extension ([#590](https://github.com/agentclientprotocol/codex-acp/issues/590)) v2 ([#622](https://github.com/agentclientprotocol/codex-acp/issues/622)) ([2fd758c](https://github.com/agentclientprotocol/codex-acp/commit/2fd758ce212e0f1121f0fe608d7d59cc169cc65c))
* support append-mode ACP system prompts ([#653](https://github.com/agentclientprotocol/codex-acp/issues/653)) ([5993a12](https://github.com/agentclientprotocol/codex-acp/commit/5993a12febe914d556332fc81f70e2b4613ee104))


### Bug Fixes

* disable Codex's Visualize skill, whose output ACP clients show as raw text ([#667](https://github.com/agentclientprotocol/codex-acp/issues/667)) ([0ba94f5](https://github.com/agentclientprotocol/codex-acp/commit/0ba94f520ec521a5a23353dbf34e51ca488b92c9))
* display the selected wire provider as JetBrains Air Gateway ([#589](https://github.com/agentclientprotocol/codex-acp/issues/589)) ([cc54abf](https://github.com/agentclientprotocol/codex-acp/commit/cc54abf3e4cdb6e58629b24060b0a1e39be73c0a))
* explain Codex config load errors caused by a deleted working directory ([#626](https://github.com/agentclientprotocol/codex-acp/issues/626)) ([a636804](https://github.com/agentclientprotocol/codex-acp/commit/a636804e57d41c3ec52c40aab9ffcef70de3db5d))
* explain invalid_encrypted_content errors after a provider change ([#668](https://github.com/agentclientprotocol/codex-acp/issues/668)) ([a77829f](https://github.com/agentclientprotocol/codex-acp/commit/a77829fecc87cebbb2e53782ce6795aee072adc8))
* hold a fork back from the session list until its session/fork response is out ([#642](https://github.com/agentclientprotocol/codex-acp/issues/642)) ([59974c7](https://github.com/agentclientprotocol/codex-acp/commit/59974c7d173e4fd6ef9498fc1e91779606c2404d))
* include subagent edits in the agent file-change report ([#632](https://github.com/agentclientprotocol/codex-acp/issues/632)) ([7d07123](https://github.com/agentclientprotocol/codex-acp/commit/7d071236c66e12c20f83e4b04d7a3619fd90de2d))
* leave codex exec runs out of the session list without sessionIndex ([#639](https://github.com/agentclientprotocol/codex-acp/issues/639)) ([df75d2b](https://github.com/agentclientprotocol/codex-acp/commit/df75d2b70fe2a0540cd621ebe664883860b90c6c))
* migrate to ACP SDK 2.0 ([#649](https://github.com/agentclientprotocol/codex-acp/issues/649)) ([c8fd166](https://github.com/agentclientprotocol/codex-acp/commit/c8fd16652b55c226329fb43d58f5419798fa541b))
* publish the commands when the skills change ([#643](https://github.com/agentclientprotocol/codex-acp/issues/643)) ([a62b568](https://github.com/agentclientprotocol/codex-acp/commit/a62b56847f473a2be6c67ea779c1ef9c7f227c38))
* report structured ACP v2 failures ([#651](https://github.com/agentclientprotocol/codex-acp/issues/651)) ([5377bfe](https://github.com/agentclientprotocol/codex-acp/commit/5377bfeea1c0f0d6530441046274c7c033c82db8))
* show a Codex subagent's follow-up turn in a new subagent session ([#634](https://github.com/agentclientprotocol/codex-acp/issues/634)) ([7c761c7](https://github.com/agentclientprotocol/codex-acp/commit/7c761c7f8fb3f6166587013f5cf9eb48911d3617))
* synchronize ACP v2 foreground state ([#650](https://github.com/agentclientprotocol/codex-acp/issues/650)) ([986955a](https://github.com/agentclientprotocol/codex-acp/commit/986955aeb4bfc2dd074b4a9e3642022f3f3b38fc))
* update codex to 0.164.0 ([#666](https://github.com/agentclientprotocol/codex-acp/issues/666)) ([e227c0e](https://github.com/agentclientprotocol/codex-acp/commit/e227c0eb098437e3b2897eeb1aab5bcde5012c3e))
* wait for the compact turn to finish ([#654](https://github.com/agentclientprotocol/codex-acp/issues/654)) ([ced4c34](https://github.com/agentclientprotocol/codex-acp/commit/ced4c34368d271d61bbc81f4047813b4db387623))

## [2.2.2](https://github.com/agentclientprotocol/codex-acp/compare/v2.2.1...v2.2.2) (2026-10-10)


### Bug Fixes

* title listed sessions by name, title, summary, then preview ([#606](https://github.com/agentclientprotocol/codex-acp/issues/606)) ([90fea43](https://github.com/agentclientprotocol/codex-acp/commit/90fea43dc15a6e8e3538ecea5c96ffe55dfcc42f))

## [2.2.1](https://github.com/agentclientprotocol/codex-acp/compare/v2.2.0...v2.2.1) (2026-10-10)


### Bug Fixes

* resume a session without messages after an app-server restart ([#604](https://github.com/agentclientprotocol/codex-acp/issues/604)) ([9ac3254](https://github.com/agentclientprotocol/codex-acp/commit/9ac32543b2990574b43bb29b41e3b2b3f6fbc6a7))

## [2.2.0](https://github.com/agentclientprotocol/codex-acp/compare/v2.1.1...v2.2.0) (2026-10-10)


### Features

* add pre-session Codex hook trust ([#588](https://github.com/agentclientprotocol/codex-acp/issues/588)) ([51aa211](https://github.com/agentclientprotocol/codex-acp/commit/51aa21123c1724db96ef3b7b2de982437e9ab4e4))
* add the AIR sessionIndex extension for fast session lists ([#590](https://github.com/agentclientprotocol/codex-acp/issues/590)) ([95bc33f](https://github.com/agentclientprotocol/codex-acp/commit/95bc33f354a2260cd65990450525b1f65bbe1e41))
* report the MCP servers that the Codex config replaces ([#587](https://github.com/agentclientprotocol/codex-acp/issues/587)) ([fbb15ad](https://github.com/agentclientprotocol/codex-acp/commit/fbb15adc6ff5a821543818e48170ee0b006a8fc7))
* show live MCP server status and reconnect from /mcp ([#579](https://github.com/agentclientprotocol/codex-acp/issues/579)) ([ca1d971](https://github.com/agentclientprotocol/codex-acp/commit/ca1d97173ad37b471d5a4e5847725a4657d34e29))
* Support custom instructions for agent sessions via meta ([#546](https://github.com/agentclientprotocol/codex-acp/issues/546)) ([51f78d6](https://github.com/agentclientprotocol/codex-acp/commit/51f78d67e46c3a96ee8d8bf4e43fc917ab21c73e))


### Bug Fixes

* report cancelled device-code sign-in as auth error instead of invalid params ([#594](https://github.com/agentclientprotocol/codex-acp/issues/594)) ([951844f](https://github.com/agentclientprotocol/codex-acp/commit/951844f87e276cc4cb1640defe7afce7068a50c0))
* update codex to 0.160.1 ([#586](https://github.com/agentclientprotocol/codex-acp/issues/586)) ([cf83291](https://github.com/agentclientprotocol/codex-acp/commit/cf83291d3f35821c89308985f8b123f0d283ae48))

## [2.1.1](https://github.com/agentclientprotocol/codex-acp/compare/v2.1.0...v2.1.1) (2026-10-01)


### Bug Fixes

* preserve attachments in imported session history ([#571](https://github.com/agentclientprotocol/codex-acp/issues/571)) ([b9fc02b](https://github.com/agentclientprotocol/codex-acp/commit/b9fc02b63e3267cb4350cab774219b947dae72da))
* send the legacy custom answer key to AIR ([#577](https://github.com/agentclientprotocol/codex-acp/issues/577)) ([56cc428](https://github.com/agentclientprotocol/codex-acp/commit/56cc4287f13453e830b0c3801fea7db2d4379044))
* show readable service error messages ([#572](https://github.com/agentclientprotocol/codex-acp/issues/572)) ([4578615](https://github.com/agentclientprotocol/codex-acp/commit/4578615599705a7a55fe7096fa90bf3c9fc1549a))

## [2.1.0](https://github.com/agentclientprotocol/codex-acp/compare/v2.0.1...v2.1.0) (2026-10-01)


### Features

* add ACP v2 support ([#552](https://github.com/agentclientprotocol/codex-acp/issues/552)) ([ba7b216](https://github.com/agentclientprotocol/codex-acp/commit/ba7b21636190a95626631c9a9226298d41d19325))


### Bug Fixes

* mark the request_user_input note as the AIR custom answer ([#570](https://github.com/agentclientprotocol/codex-acp/issues/570)) ([2283d33](https://github.com/agentclientprotocol/codex-acp/commit/2283d33800aa2558135aaf0d4ad4041ee40260f9))
* report a thread held by another Codex client as a clear error ([#564](https://github.com/agentclientprotocol/codex-acp/issues/564)) ([5065453](https://github.com/agentclientprotocol/codex-acp/commit/506545315e52c0593415d18b05dd2d3dbe527d32))
* temporarily revert ACP v2 commit ba7b216 ([#573](https://github.com/agentclientprotocol/codex-acp/issues/573)) ([e46eed1](https://github.com/agentclientprotocol/codex-acp/commit/e46eed1ef4c1b64733969c66fe54197f4356db7d))

## [2.0.1](https://github.com/agentclientprotocol/codex-acp/compare/v2.0.0...v2.0.1) (2026-09-29)


### Bug Fixes

* update codex to 0.159.0 ([#562](https://github.com/agentclientprotocol/codex-acp/issues/562)) ([9785e75](https://github.com/agentclientprotocol/codex-acp/commit/9785e75c1ffe110032b57e78ec2a2da17c2c81e2))
* update codex to 0.159.1 ([#565](https://github.com/agentclientprotocol/codex-acp/issues/565)) ([645da2a](https://github.com/agentclientprotocol/codex-acp/commit/645da2a09f1b6fdfc6e6f28e781faf033d22a0d8))

## [2.0.0](https://github.com/agentclientprotocol/codex-acp/compare/v1.13.1...v2.0.0) (2026-09-28)


### ⚠ BREAKING CHANGES

* AIR tool call contract, exact diff patches, and fixes for every client ([#530](https://github.com/agentclientprotocol/codex-acp/issues/530))

### Features

* add  _meta.mcpStartupAwaitTimeoutMs option to allow awaiting for requested MCP servers startup outcome on session start ([#517](https://github.com/agentclientprotocol/codex-acp/issues/517)) ([cf6609e](https://github.com/agentclientprotocol/codex-acp/commit/cf6609e6be2f932251a7a379a0f3d2d79efd23d0))
* AIR tool call contract, exact diff patches, and fixes for every client ([#530](https://github.com/agentclientprotocol/codex-acp/issues/530)) ([966a544](https://github.com/agentclientprotocol/codex-acp/commit/966a544bdb798de7f965df05ef66d2e3cb055364))


### Bug Fixes

* report authentication failures through ACP login flow ([#550](https://github.com/agentclientprotocol/codex-acp/issues/550)) ([2a26ee4](https://github.com/agentclientprotocol/codex-acp/commit/2a26ee44e07bdfbd6f2416a528fa2a6c18ff696d))
* resolve ACP v1 conformance failures found by acp-tck ([#536](https://github.com/agentclientprotocol/codex-acp/issues/536)) ([1cc6223](https://github.com/agentclientprotocol/codex-acp/commit/1cc62233fb6f2abde7cadd518a53de9d0826ea77))
* restore read-only mode and clarify access presets ([#480](https://github.com/agentclientprotocol/codex-acp/issues/480)) ([7fee150](https://github.com/agentclientprotocol/codex-acp/commit/7fee150a55098f7140a03907fec5f11edbe45086))
* specify correct default behavior in mcp-stratup-await-timeout.md ([#551](https://github.com/agentclientprotocol/codex-acp/issues/551)) ([bf37821](https://github.com/agentclientprotocol/codex-acp/commit/bf37821e8f3c1f1e9b6954171855a9e2579cd2c9))
* update codex to 0.157.0 ([#549](https://github.com/agentclientprotocol/codex-acp/issues/549)) ([7839796](https://github.com/agentclientprotocol/codex-acp/commit/78397963740f7263fdb8ae9178682d0fc714790e))
* update codex to 0.157.1 ([#554](https://github.com/agentclientprotocol/codex-acp/issues/554)) ([9510cf1](https://github.com/agentclientprotocol/codex-acp/commit/9510cf18248023e1e165b422416919e43776b93e))
* update codex to 0.158.0 ([#559](https://github.com/agentclientprotocol/codex-acp/issues/559)) ([59d0fb0](https://github.com/agentclientprotocol/codex-acp/commit/59d0fb0b6fd9dc85bf7c45f841f39a5225bea232))

## [1.13.1](https://github.com/agentclientprotocol/codex-acp/compare/v1.13.0...v1.13.1) (2026-09-23)


### Bug Fixes

* update codex to 0.156.1 ([#541](https://github.com/agentclientprotocol/codex-acp/issues/541)) ([761264b](https://github.com/agentclientprotocol/codex-acp/commit/761264b6323f1caffbfd75941de132cb4744a9e2))

## [1.13.0](https://github.com/agentclientprotocol/codex-acp/compare/v1.12.0...v1.13.0) (2026-09-22)


### Features

* Add experimental session notices for Codex advisories ([#532](https://github.com/agentclientprotocol/codex-acp/issues/532)) ([e4c9af6](https://github.com/agentclientprotocol/codex-acp/commit/e4c9af6f4459013e4382dd18e25e8f184b63cb33))
* Add expermental ACP session compaction updates ([#515](https://github.com/agentclientprotocol/codex-acp/issues/515)) ([6ec22f3](https://github.com/agentclientprotocol/codex-acp/commit/6ec22f39774320d759bf9ba37fc536c68766d1af))


### Bug Fixes

* prefer terminal output deltas ([#528](https://github.com/agentclientprotocol/codex-acp/issues/528)) ([71bceb1](https://github.com/agentclientprotocol/codex-acp/commit/71bceb19c20887c91df3a30a6bf930abb033ccf8))
* update codex to 0.155.0 ([#523](https://github.com/agentclientprotocol/codex-acp/issues/523)) ([d7b07c1](https://github.com/agentclientprotocol/codex-acp/commit/d7b07c1b44a28890cdf3d5450f8974a812db5ae2))
* update codex to 0.155.1 ([#525](https://github.com/agentclientprotocol/codex-acp/issues/525)) ([acc035a](https://github.com/agentclientprotocol/codex-acp/commit/acc035a7444bf7550aabcc24597ed845ba3e593b))

## [1.12.0](https://github.com/agentclientprotocol/codex-acp/compare/v1.11.0...v1.12.0) (2026-09-15)


### Features

* Add tool names to ACP tool call events ([#513](https://github.com/agentclientprotocol/codex-acp/issues/513)) ([e46df48](https://github.com/agentclientprotocol/codex-acp/commit/e46df48fe7e54f2a4073cb11f9e24f1a223fc9e6))


### Bug Fixes

* improve request_user_input elicitation forms ([#299](https://github.com/agentclientprotocol/codex-acp/issues/299)) ([472e60e](https://github.com/agentclientprotocol/codex-acp/commit/472e60e4e99234c47c6de67a6d9cc8a71ebda47e))
* update codex to 0.154.0 ([#494](https://github.com/agentclientprotocol/codex-acp/issues/494)) ([a24ebc4](https://github.com/agentclientprotocol/codex-acp/commit/a24ebc4f35e6e800b37ddc59c58e58abe7cf8a5c))


### Performance Improvements

* derive file change reports from turn diffs ([#518](https://github.com/agentclientprotocol/codex-acp/issues/518)) ([caddefe](https://github.com/agentclientprotocol/codex-acp/commit/caddefe56ff55a3f0827aa8ad60d03779f168425))

## [1.11.0](https://github.com/agentclientprotocol/codex-acp/compare/v1.10.0...v1.11.0) (2026-09-09)


### Features

* advertise recommended model and reasoning effort ([#491](https://github.com/agentclientprotocol/codex-acp/issues/491)) ([649b63c](https://github.com/agentclientprotocol/codex-acp/commit/649b63cbcd033f626676c5189a0db3b1166195b0))
* simplify GPT model display names ([#493](https://github.com/agentclientprotocol/codex-acp/issues/493)) ([df025c7](https://github.com/agentclientprotocol/codex-acp/commit/df025c73ba02d9e35d728aa81a0fbb3b13f4c8fb))


### Bug Fixes

* finalize standalone MCP elicitation permission requests ([#471](https://github.com/agentclientprotocol/codex-acp/issues/471)) ([7c374bc](https://github.com/agentclientprotocol/codex-acp/commit/7c374bc9ce6808d278c5d47887fb6a7ad1e65b28))
* paginate thread history when forking and loading sessions ([#481](https://github.com/agentclientprotocol/codex-acp/issues/481)) ([1a3c01e](https://github.com/agentclientprotocol/codex-acp/commit/1a3c01e8ca317f83e3b60bc5632cf052882bea15))

## [1.10.0](https://github.com/agentclientprotocol/codex-acp/compare/v1.9.0...v1.10.0) (2026-09-04)


### Features

* expose background terminals as async tasks ([#460](https://github.com/agentclientprotocol/codex-acp/issues/460)) ([e31c8c3](https://github.com/agentclientprotocol/codex-acp/commit/e31c8c369ec74f551d017d09abdb6d04d926dcab))


### Bug Fixes

* update codex to 0.153.3 ([#476](https://github.com/agentclientprotocol/codex-acp/issues/476)) ([b9f1386](https://github.com/agentclientprotocol/codex-acp/commit/b9f1386e0d14e1322dca5b6574146f8faa6ecea6))

## [1.9.0](https://github.com/agentclientprotocol/codex-acp/compare/v1.8.0...v1.9.0) (2026-09-04)


### Features

* report the agent's auth identity over ACP (authStatus extension) ([#467](https://github.com/agentclientprotocol/codex-acp/issues/467)) ([fe696b0](https://github.com/agentclientprotocol/codex-acp/commit/fe696b0a12b20a2d4dbfab68ff703a5adb7fe38c))


### Bug Fixes

* report complete status usage and limits ([#463](https://github.com/agentclientprotocol/codex-acp/issues/463)) ([5552cef](https://github.com/agentclientprotocol/codex-acp/commit/5552cef60fd60d3c7f8ad2ae8cefea401addeb37))
* update codex to 0.153.2 ([#469](https://github.com/agentclientprotocol/codex-acp/issues/469)) ([6cd7048](https://github.com/agentclientprotocol/codex-acp/commit/6cd7048e55195aea5bc7ce618f4c13fb9e9378f9))

## [1.8.0](https://github.com/agentclientprotocol/codex-acp/compare/v1.7.0...v1.8.0) (2026-09-01)


### Features

* AI session title generation and /rename command ([#392](https://github.com/agentclientprotocol/codex-acp/issues/392)) ([4823131](https://github.com/agentclientprotocol/codex-acp/commit/4823131475b3b0d996ccc305e49dcf9fdaa6ee52))
* support ACP session forks ([#435](https://github.com/agentclientprotocol/codex-acp/issues/435)) ([69ca755](https://github.com/agentclientprotocol/codex-acp/commit/69ca755d9878238aecf0737c0e4568b3bab37be2))


### Bug Fixes

* **LLM-25012:** OAuth2 Authentication for MCP Server Connections ([#452](https://github.com/agentclientprotocol/codex-acp/issues/452)) ([06765be](https://github.com/agentclientprotocol/codex-acp/commit/06765be12a7303048722946ece6c2a3b1695e28d))
* update codex to 0.152.0 ([#455](https://github.com/agentclientprotocol/codex-acp/issues/455)) ([d70e380](https://github.com/agentclientprotocol/codex-acp/commit/d70e3809e7beed8a1c51c59ee206f53d8d9df690))

## [1.7.0](https://github.com/agentclientprotocol/codex-acp/compare/v1.6.2...v1.7.0) (2026-08-27)


### Features

* add ACP v1 permission presentation ([#405](https://github.com/agentclientprotocol/codex-acp/issues/405)) ([8ff9e67](https://github.com/agentclientprotocol/codex-acp/commit/8ff9e67f79335345ce53b3157b3d690c191ea027))
* add native ACP subagent sessions ([#419](https://github.com/agentclientprotocol/codex-acp/issues/419)) ([6067b7f](https://github.com/agentclientprotocol/codex-acp/commit/6067b7f48fe37db82b6ddb9d596a4a4d8cb8a2e4))
* expose permission mode kinds ([#430](https://github.com/agentclientprotocol/codex-acp/issues/430)) ([50f69e5](https://github.com/agentclientprotocol/codex-acp/commit/50f69e57ca761ccafd2ca29de7fb591068277516))


### Bug Fixes

* report AIR file changes from audit turns ([a2152e2](https://github.com/agentclientprotocol/codex-acp/commit/a2152e2d337291ca2f8dd7f9cc8b68a2355ce955))
* send elicitation complete event for device authentication ([#421](https://github.com/agentclientprotocol/codex-acp/issues/421)) ([6b01a28](https://github.com/agentclientprotocol/codex-acp/commit/6b01a28c4706762a9663914845c51cd605cde339))
* suppress late session updates after close ([#418](https://github.com/agentclientprotocol/codex-acp/issues/418)) ([ae048a6](https://github.com/agentclientprotocol/codex-acp/commit/ae048a66e485bae5184cb87ae75fcfa1549b69d5))

## [1.6.2](https://github.com/agentclientprotocol/codex-acp/compare/v1.6.1...v1.6.2) (2026-08-19)


### Bug Fixes

* right-size the apt timeouts so a slow mirror still finishes ([86e0772](https://github.com/agentclientprotocol/codex-acp/commit/86e0772204a07d6fc4a8853c523ceb5006431f88))

## [1.6.1](https://github.com/agentclientprotocol/codex-acp/compare/v1.6.0...v1.6.1) (2026-08-19)


### Bug Fixes

* kill stalled apt from outside and serialize the unit suite ([51e011f](https://github.com/agentclientprotocol/codex-acp/commit/51e011fef27b812b238bf29c2a815f8ad149fa87))

## [1.6.0](https://github.com/agentclientprotocol/codex-acp/compare/v1.5.1...v1.6.0) (2026-08-19)


### Features

* harden release pipeline against hangs and e2e flakes ([#413](https://github.com/agentclientprotocol/codex-acp/issues/413)) ([39af81c](https://github.com/agentclientprotocol/codex-acp/commit/39af81c29b79a85f878db096f9cb593b6d1c7429))

## [1.5.1](https://github.com/agentclientprotocol/codex-acp/compare/v1.5.0...v1.5.1) (2026-08-19)


### Bug Fixes

* update codex to 0.148.0 ([#410](https://github.com/agentclientprotocol/codex-acp/issues/410)) ([3616954](https://github.com/agentclientprotocol/codex-acp/commit/3616954dc0e24af83b512adb618d7acbc5b98de5))

## [1.5.0](https://github.com/agentclientprotocol/codex-acp/compare/v1.4.0...v1.5.0) (2026-08-17)


### Features

* switch providers for loaded Codex sessions ([#404](https://github.com/agentclientprotocol/codex-acp/issues/404)) ([47b57da](https://github.com/agentclientprotocol/codex-acp/commit/47b57da5641a04df9aeeedc254a3aef53a9497da))

## [1.4.0](https://github.com/agentclientprotocol/codex-acp/compare/v1.3.0...v1.4.0) (2026-08-16)


### Features

* report changed files to AIR ([#403](https://github.com/agentclientprotocol/codex-acp/issues/403)) ([e305394](https://github.com/agentclientprotocol/codex-acp/commit/e305394d3f001f21e600597f41a3bee3d4530762))

## [1.3.0](https://github.com/agentclientprotocol/codex-acp/compare/v1.2.0...v1.3.0) (2026-08-14)


### Features

* add versioned context compaction metadata ([#396](https://github.com/agentclientprotocol/codex-acp/issues/396)) ([c4a9311](https://github.com/agentclientprotocol/codex-acp/commit/c4a9311f60a638e3a4b03a475afff1d7678e594f))
* align typed session failures with AIR protocol ([#393](https://github.com/agentclientprotocol/codex-acp/issues/393)) ([e4fb92f](https://github.com/agentclientprotocol/codex-acp/commit/e4fb92fffd8b8b9db9b40591ccbdb375c9f3f525))


### Bug Fixes

* Restore native provider state after overrides ([#400](https://github.com/agentclientprotocol/codex-acp/issues/400)) ([90ed600](https://github.com/agentclientprotocol/codex-acp/commit/90ed60077a928a02ce795a35c90c2ed3a8af381e))

## [1.2.0](https://github.com/agentclientprotocol/codex-acp/compare/v1.1.14...v1.2.0) (2026-08-11)


### Features

* expose typed session failures for AIR ([#383](https://github.com/agentclientprotocol/codex-acp/issues/383)) ([54987e1](https://github.com/agentclientprotocol/codex-acp/commit/54987e1c4a4f878af9afad96ec8b6b0b48c7045e))


### Bug Fixes

* normalize cwd filters for Windows sessions ([#377](https://github.com/agentclientprotocol/codex-acp/issues/377)) ([145ebba](https://github.com/agentclientprotocol/codex-acp/commit/145ebba5d2030b4aa6d19cbb89d190b7b498d454))
