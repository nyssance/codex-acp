# ALwith fork status

`nyssance/codex-acp` follows `agentclientprotocol/codex-acp` and publishes `@nyssance/codex-acp-v2`. Releases and synchronization are described in [RELEASES.md](RELEASES.md).

Everything the fork does differently from upstream falls into one of three groups, each listed below:

1. [Fork-only surface](#fork-only-surface): methods, `_meta` keys and notifications that upstream does not have.
2. [Behavior that differs from upstream](#behavior-that-differs-from-upstream): upstream features that behave differently in the fork.
3. [Registered workarounds](fallbacks.md): code that works around a gap in Codex, a backend or the protocol.

A change in an upstream-owned file that fits none of them is a defect: upstream-owned files keep upstream's syntax and style, and the agent `tsconfig.json` turns `erasableSyntaxOnly` off for that reason. When upstream fixes something the fork patched, adopt upstream's implementation and drop the local one (see `AGENTS.md`).

## Base and tooling

- Upstream base: 2.10.0 plus three commits (`394f2fad`).
- Dependencies: ACP SDK 2.9.1, the same as upstream, and Codex 0.172.0 (upstream is on 0.171.0). `src/app-server` is generated from Codex 0.172.0 with `bun run generate-types` (experimental API included) and not edited by hand.
- Bun is the package manager; `bun.lock` is the lockfile. The package version, name and release workflow are the fork's own; upstream's release-please files are not kept.
- Formatting matches upstream. No formatter runs on this repository (see `AGENTS.md`).
- Upstream merges land on `main` through reviewed merges that keep upstream ancestry.

## Tests

- `bun run test` runs the non-live suite; `bun run test:integration` runs a real Codex app-server against a local mock model. CI runs both.
- `bun run test:e2e` uses a real model and runs only when started manually.

## Fork-only surface

Upstream defines only `_codex/hooks/list`, `_codex/hooks/trust` and `_codex/session/goal_control` among `_codex/*` methods, and no `_alwith/*` method. Everything below is the fork's. Where Codex has a native method, the fork passes through to it and adds only the ACP envelope. The wire contracts are in [protocol.md](protocol.md), [acp-client.md](acp-client.md) and [session-state.md](session-state.md).

| Surface | Methods and keys | Native Codex | Consumer |
|---|---|---|---|
| History browse and export | `_codex/session_history`, `_codex/session_history_items` | `thread/turns/list`, `thread/items/list`; the byte limit is the fork's | module-chat history, export |
| History replay metadata | v2 replay `_meta.codex.{historyReplay, turnId, turnStartedAt, turnCompletedAt, turnDurationMs, messageSentAt, historyInterrupted}`, and one `codex-error:<turnId>` `agent_message` for a failed turn (`src/ReplayHistory.ts`, `src/alwith/agent/turnMetadata.ts`) | turn and item timestamps | module-chat session timeline |
| Local image replay | a replayed `localImage` input becomes an inline `image` block (`src/alwith/codex/userImages.ts`); an inline data URL image becomes an `image` block, not a link | `localImage` user input | module-chat |
| Native fork boundary | `_meta.codex.forkedAtTurnId`, `lastTurnId` and lineage on v2 fork, load and context-only resume responses (`src/alwith/sessionLineage.ts`) | `thread/turns/list` summaries | module-chat |
| Session list | the upstream session index, enabled by `clientCapabilities._meta.alwith.capabilities: ["sessionIndex"]`; standard `session/list` rows with `archived` and `_meta.codex` lineage | `thread/list` through upstream `SessionIndexService` | module-chat sidebar |
| Archive over v2 | `session/archive`, `session/unarchive`, the `session/list` `archived` filter. `session/set_title` is upstream's (#727); the fork only rejects it on a read-only session | `thread/archive`, `thread/unarchive` | module-chat |
| Read-only sessions | a v2 resume or load of a thread another Codex client is writing opens it read-only, with `_meta.codex.readOnly: true, reason: "active_writer"`; writes are rejected | `thread/read` | module-chat, U |
| Mode hint | `_meta.codex.mode` on `session/new` (a preset) and on resume, load and fork (`custom` keeps the thread's own permissions) (`src/alwith/hostSession.ts`) | thread settings | `src/client`, TV |
| Gateway providers | `providers/set` and `providers/disable` with `mode: "catalog"`, and the per-session model option. Upstream has single-gateway `providers/set` and `providers/disable`; catalog mode is added next to them | none | U through `alwith-modules` `providers.rs` |
| Anthropic Messages gateways | `providers/set` with `apiType: "anthropic"`; `baseUrl` is the Messages endpoint and `_meta.codex.bearerToken` its API key | none; Codex speaks Responses to the adapter's proxy, which translates with the pinned opencodex core (`src/alwith/codex/anthropicMessages.ts`) | module-chat provider catalog |
| Web search on DeepSeek gateways | `providers/set` with `_meta.alwith.webSearch: "deepseek"`: the gateway serves DeepSeek's `POST /v1/tools/search` and `POST /v1/tools/fetch` under the same origin and credential | none; Codex's hosted `web_search` tool, run by the adapter's proxy | U, TV and Desktop through `alwith-modules` |
| Existing Claude OAuth (local candidate) | `providers/set` with `apiType: "anthropic"`, `headers: {"X-Alwith-Anthropic-Auth-Mode": "oauth"}` and an access token in `_meta.codex.bearerToken`; only the official Anthropic origin is accepted | The existing translator keeps opencodex's OAuth framing. No OAuth login, token renewal, or credential storage is added to the adapter. The caller owns credential lifetime; an unchanged header/default selects API-key mode. | Local mock tests and one real minimal inference passed; no UI integration or release. |
| Native network transport | `CODEX_ACP_NATIVE_NETWORK_ENDPOINT` routes the adapter's own HTTP through the host, with `x-alwith-native-*` headers (`src/alwith/codex/nativeNetworkTransport.ts`, `nativeFetch.ts`; see `readme-dev.md`) | none | U `src-tauri/src/runtime.rs` |
| Application tools over ACP | MCP-over-ACP (`type: "acp"` servers, `mcp/message`), served to Codex through the ACP SDK's loopback HTTP bridge (upstream #771) | MCP servers; the bridge is needed only while Codex cannot take an ACP-provided server directly | U, TV |
| Host execution parameters | `_meta.alwith.nativeTools` and `_meta.alwith.applicationContext` on prompts (`src/alwith/codex/hostExecution.ts`) | tool settings, turn input | module-chat |
| Session input configuration | `_codex/session_input_config_get`, `_codex/session_input_config_set`, stored as a thread attachment of type `alwith.session-input.v2` (`src/alwith/codex/sessionInputConfig.ts`) | thread attachments | module-chat `agent/client.ts` |
| Configuration revisions | `_meta.alwith.configRevision`, `expectedConfigRevision` | none | module-chat, TV |
| Client message IDs | `_meta.alwith.messageId` on v2 `session/prompt`, validated | `clientUserMessageId` | module-chat |
| Prompt suggestions | the standard `prompt_suggestions_update` (ACP draft, `unstable_prompt_suggestions`) for a client that declares `session.promptSuggestions`; upstream sends its prediction only to AIR, as `_meta.promptSuggestions` on `session_info_update`, and AIR still gets that | `thread/sample` through upstream's `PromptSuggestionGenerator` | module-chat composer |
| Retry | `_codex/session_retry` | none | module-chat |
| Image generation | `_codex/images/generate` | ChatGPT backend images | module-chat `image-tools.ts` |
| Sites and connectors | `_codex/apps_installed`, `_codex/apps_read` | `app/installed`, `app/read` | module-chat, U |
| Plugins, skills, marketplace | `_codex/plugin_*`, `_codex/plugin_set_enabled`, `_codex/skills_*`, `_codex/marketplace_*`, `_codex/skills_changed` | `plugin/*`, `skills/*`, `marketplace/*` | module-chat and U settings |
| Realtime voice | `_codex/realtime/start`, `_codex/realtime/stop` and the `_codex/realtime/update` notification | `thread/realtime/*` | module-chat voice, TV |
| Account, rate limits, file search | `_codex/account_read`, `_codex/rate_limits`, `_codex/rate_limits_updated`, `_codex/fuzzy_file_search` | `account/read`, `account/rateLimits/read`, `fuzzyFileSearch` | module-chat |
| Shell | `_codex/shell/execute` | `thread/shellCommand` | module-chat composer |
| Projects | `_codex/project_context`, `_meta.codex.projectId`, `_codex/projects_changed`, `_codex/thread_project_updated` (`src/projects`) | `project/*` | module-chat, U |
| Browser client | `@nyssance/codex-acp-v2/client` (`src/client`) | none | module-chat re-exports it to U, TV, Desktop |

## Behavior that differs from upstream

Each item changes how an upstream feature behaves. Where a wire contract exists, the linked document has it.

**Sessions**

- **Permission mode persistence.** A permission-mode change is written to the thread with `thread/settings/update` before it is confirmed, so it persists without a turn. Upstream records it and sends it with the next `turn/start`.
- **Restored permission mode.** Resume, load and fork restore the thread's own mode (`AgentMode.fromThread`), a `custom` mode when it matches no preset. Upstream selects the default mode for a built-in profile. An unknown `INITIAL_AGENT_MODE` throws; upstream falls back to the default ([permission-profiles.md](permission-profiles.md)).
- **Read-only on an active writer.** Over v2, see the Fork-only row. Upstream fails with `thread_active_writer`.
- **v2 fork replays history.** v2 `session/fork` replays the child's history before its response; upstream replays nothing.
- **Cancelled session open.** Cancelling a v2 `session/new`, `session/resume` or `session/fork` (`-32800`) closes the session it already created (`runSessionOpen`). Upstream only stops waiting.
- **Immediate thread unload.** Every app-server starts with `thread_unload_delay_secs=0`, so a provider change can release every detached writer. Upstream keeps Codex's default delay.

**Prompts and turns**

- **Turn ids on v2 updates.** v2 updates that carry content get `_meta.codex.turnId` of their turn.
- **v2 assistant messages.** A native assistant item's start sends an `agent_message` upsert, and its completion sends the final chunk and the complete `agent_message` with `messageCompleted`, `phase`, `delivery` and `questions`. Every v2 `agent_message_chunk` carries `_meta.codex.phase` (upstream: AIR only). See [protocol.md](protocol.md).
- **Turn timing.** A completed v2 turn re-sends its last assistant message with `turnStartedAt`, `turnCompletedAt`, `turnDurationMs` and `workDurationMs`. A turn without Codex's start or completion time carries none.
- **Failed turn message.** A failed v2 turn sends one `codex-error:<turnId>` `agent_message` with `_meta.codex.error.{kind,category,actions}` from upstream's own classification (`src/CodexFailures.ts`, moved out of `CodexEventHandler.ts` so the exported client can import it), live and on replay. Upstream sends the error as an `agent_message_chunk`.
- **Guardian warnings.** Failures and interruptions of automatic approval review are shown as warnings; upstream drops every `guardianWarning` ([fallbacks.md](fallbacks.md) has the text match).
- **Prompt input.** An `image` block with `_meta["alwith.localImage"]` and a `file:` URI is sent as Codex `localImage`; an `app://<id>` resource link is sent as a mention; `_meta.alwith.retryTrigger` marks a capacity retry (`buildPromptItems`, `src/CodexAcpClient.ts`).

**Subagents**

- `subagent_update` carries `_meta.codex.threadId` and `parentTurnId` ([protocol.md](protocol.md) "Subagent turn origins").
- Root cancellation interrupts every child turn through the router's `cancelAll`, retrying while Codex has not registered the turn yet ([subagent-sessions.md](subagent-sessions.md)). Upstream interrupts each running child turn once.

**Goals and hooks**

- The goal is published to v2 clients as `_meta.codex.goal` (upstream: AIR only), and an update is sent whenever usage changes, not only when the objective, status, budget or creation time do.
- `_codex/hooks/list` and `_codex/hooks/trust` are registered over v2 too. Upstream registers them over v1.

**Tools**

- `commandSource: "userShell"` commands always render as terminals and carry `_meta.codex` for every client.
- MCP elicitations with `openai/form` or `openaiForm` are handled as forms; upstream cancels them.
- A correlated MCP approval over v2 carries the prompt's correlation fields in `_meta.permission_prompt` (`requestPermissionMeta`).
- Image generation tool calls carry `name: "image_generation"`; a `fileId` result is shown as `Generated image attachment: <id>`.

## Pending

The open items of this repository. Each names what unblocks it.

| Item | State | Done when |
|---|---|---|
| Session index for non-AIR v2 clients | [agentclientprotocol/codex-acp#736](https://github.com/agentclientprotocol/codex-acp/issues/736) open. The fork enables upstream's `SessionIndexService` for a client that declares `_meta.alwith.capabilities: ["sessionIndex"]` (`src/alwith/agent/sessionList.ts`). | Upstream serves the index to v2 connections; the ALwith gate goes. |
| Provider HTTP 402 | Codex treats an unknown status as a retried connection failure and drops the provider text on `QuotaExceeded`; the fork's proxy rewrites a 402 to 429 `usage_limit_reached` with the provider's message (`docs/fallbacks.md`). DeepSeek answers 402 `insufficient_balance_error` (observed 2026-11-05). | Codex recognizes 402, or DeepSeek answers OpenAI's 429 `insufficient_quota`. |
| Title generation on gateway sessions | `TitleGenerator` starts the title thread on the default model; whether it succeeds for a gateway-only login is unverified. Upstream PR #595 (skip AI titles on other providers) is open. Until then the history title repairs envelope previews (`src/alwith/agent/historyTitle.ts`). | Verified, or #595 decides it. |
| Standard ACP methods | Upstream serves `session/set_title` (#727), `auth/status` (#782, next to the interim `_auth/status_update`, which no ALwith client reads), v2 background work on state snapshots with `terminal/cancel` (#777), and `session/options` (#797); the fork inherits all of them. Upstream does not serve `session/archive`, `session/unarchive` or the `session/list` `archived` filter over v2; the fork does (advertised as `session.archive`), and AIR keeps `_session/*`. `session/status` and the proxy methods are not served; no consumer asks for them. | Upstream adopts standard archive; the fork's routes become upstream's. |
| `session/options` | Upstream serves it (#797) and the fork inherits it. The preview knows nothing about gateway providers, and a thread's provider is fixed when it is created, so module-chat drafts still create a session and pass `_meta.alwith.model`. | The preview and the setup request carry the provider choice; then drafts stop creating a session. |
| Surface without a consumer | The browser client's `CodexCapabilitiesClient.generateImage` has no caller (module-chat sends `_codex/images/generate` itself); kept until the image client is wired (`docs/plans/index.md` in Desktop). The rest of the unused surface was removed on 2026-11-17 after a check of alwith-modules, U, TV and Desktop. | It gets a caller, or is removed. |
| Upstream candidates | Fixes upstream would take: the `openai/form` elicitation, subagent cancellation retries, closing the session of a cancelled open, and waiting for `thread/closed` before a resume (Codex 0.167 race, see fallbacks.md). | Offered upstream; on merge the local copy goes. |
