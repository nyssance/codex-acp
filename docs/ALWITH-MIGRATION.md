# ALwith fork status

`nyssance/codex-acp` follows `agentclientprotocol/codex-acp` and publishes `@nyssance/codex-acp-v2`. Releases and synchronization are described in [RELEASES.md](RELEASES.md).

## Base and tooling

- Dependencies: ACP SDK 2.4 and Codex 0.166. Bun is the package manager; `bun.lock` is the lockfile.
- Formatting matches upstream. No formatter runs on this repository (see `AGENTS.md`).
- Upstream merges land on `main` through reviewed merges that keep upstream ancestry.

## What the fork adds

- History browse and export (`_codex/session_history`, `_codex/session_history_items`) on native Codex pagination. The adapter fits each page to `maxBytes`.
- Session list with fork lineage, and over v2 the standard `session/set_title`, `session/archive`, `session/unarchive` and `session/list` `archived` filter. AIR clients keep `_session/*`.
- Catalog, account, plugin, skill and file search pass-throughs on the upstream app-server connection, rebound after recovery.
- Client tools with per-prompt call deduplication, permission checks, cancellation and late-response rejection.
- Session-scoped provider catalogs that keep native and gateway models together; model changes rebind the selected thread.
- Configuration revisions on responses and updates; stale prompts are rejected after acquiring their queue slot. Client message IDs are validated.
- Predictions, retries, native turn IDs, fork boundaries and lineage.
- The browser client export `@nyssance/codex-acp-v2/client`, consumed through `@alwith/module-chat/client`.

## Tests

- `bun run test` runs the non-live suite; `bun run test:integration` runs a real Codex app-server against a local mock model. CI runs both.
- `bun run test:e2e` uses a real model and runs only when started manually.

## Native fork boundary metadata

Over ACP v2, fork, load, and context-only resume responses expose `_meta.codex.forkedAtTurnId`
for forked sessions. ACP v1 responses carry no lineage, as upstream's do. It is the latest native turn ID shared
by the parent and child, or `null` when they share no turns. The adapter derives
it from paginated `thread/turns/list` summaries, including after the child has
continued and both processes have restarted. It does not store a second copy of
conversation provenance. History failures are propagated rather than reported
as an empty boundary.

## Fork-only surface

Upstream defines only `_codex/hooks/list`, `_codex/hooks/trust` and `_codex/session/goal_control`
among `_codex/*` methods, and no `_alwith/*` method. Everything below is the fork's, kept because a
consumer uses it. Where Codex has a native method, the fork passes through to it and adds only the
ACP envelope. Workarounds for Codex gaps are listed separately in [fallbacks.md](fallbacks.md).

| Surface | Methods | Native Codex | Consumer |
|---|---|---|---|
| History browse and export | `_codex/session_history`, `_codex/session_history_items` | `thread/turns/list`, `thread/items/list`; the byte limit is the fork's | module-chat history, export |
| Session list | the upstream session index, enabled by `clientCapabilities._meta.alwith.capabilities: ["sessionIndex"]`; standard `session/list` rows with `archived` and `_meta.codex` lineage | `thread/list` through upstream `SessionIndexService` | module-chat sidebar |
| Archive and title over v2 | `session/set_title`, `session/archive`, `session/unarchive` | `thread/name/set`, `thread/archive`, `thread/unarchive` | module-chat |
| Gateway providers | `providers/set` (`mode: "catalog"`) and the per-session model option | none | U through `alwith-modules` `providers.rs` |
| Client tools | `_alwith/tool/call` | dynamic tools | U, TV |
| Configuration revisions | `_meta.alwith.configRevision`, `expectedConfigRevision` | none | module-chat, TV |
| Composer predictions | `_codex/session_prediction_request` | `thread/prediction/request` still answers not implemented, so the fork runs an ephemeral fork turn; switch when it lands (Desktop `docs/plans/index.md`) | module-chat composer |
| Retry | `_codex/session_retry` | none | module-chat |
| Image generation | `_codex/images/generate` | ChatGPT backend images | module-chat |
| Sites and connectors | `_codex/apps_*`, `_codex/mcp_status`, `_codex/mcp_tool_call` | `app/list`, `mcpServerStatus/list`, `mcpServer/tool/call` | U Sites |
| Plugins, skills, marketplace | `_codex/plugin_*`, `_codex/skills_*`, `_codex/marketplace_*` | `plugin/*`, `skills/*`, `marketplace/*` | module-chat settings |
| Realtime voice | `_codex/realtime/*` | `thread/realtime/*` | U, TV voice button |
| Import | `_codex/import/*` | `externalAgentConfig/*` | U imports |
| Account, rate limits, file search | `_codex/account_read`, `_codex/rate_limits`, `_codex/fuzzy_file_search` | `account/read`, `account/rateLimits/read`, `fuzzyFileSearch` | module-chat |
| Shell, projects | `_codex/shell/execute`, `_codex/project_context` | `thread/shellCommand`, `project/*` | module-chat |
| Async questions | question card over `session/request_permission` | `request_user_input` | module-chat |

Hooks and goal control are upstream's; the fork only exposes them in its browser client.

Two behaviors differ from upstream on purpose:

- A permission-mode change is written to the thread with `thread/settings/update` before it is
  confirmed, so it persists without a turn. Upstream records it and sends it with the next `turn/start`.
- A failed turn carries `_meta.codex.error.{category,retryable,stopReason}` from `classifyTurnError`.
  Upstream's `CodexEventHandler` has its own `CodexFailureKind` labels; module-chat reads the fork's.
  Merging the two would change the labels clients show and is not done yet.

## Waiting on upstream

- Session index for non-AIR v2 clients: [agentclientprotocol/codex-acp#736](https://github.com/agentclientprotocol/codex-acp/issues/736). Upstream gates `SessionIndexService` on the AIR `sessionIndex` capability. The fork enables the same service for a client that declares `_meta.alwith.capabilities: ["sessionIndex"]` and answers it with standard rows (`src/alwith/agent/sessionList.ts`); the fork's own list, fork index and `threadSource` are gone. Once upstream serves the index to v2 connections, the ALwith gate goes too.
- ACP SDK 2.3/2.4 standard methods. Upstream #727 (merged in `13c9eef`) moved to SDK 2.4 and adopted only `session/set_title`; it does not advertise `session/archive` / `session/unarchive`, `session/status` or `auth/status`. The fork serves `session/set_title`, `session/archive`, `session/unarchive` and the `session/list` `archived` filter over v2 (advertised as `session.archive`), and its client uses them; `_codex/session_rename`, `_codex/session_archive` and `_codex/session_unarchive` are removed. AIR keeps `_session/rename`, `_session/archive` and `_session/unarchive`. `_auth/status_update`, `proxy/initialize` / `proxy/successor` and v2 background work are not adopted.
