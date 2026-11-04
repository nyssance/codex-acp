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
- Configuration revisions on responses and updates; stale prompts are rejected after acquiring their queue slot. Client message IDs are retained.
- Predictions, retries, history seeding, native turn IDs, fork boundaries and lineage.
- The browser client export `@nyssance/codex-acp-v2/client`, consumed through `@alwith/module-chat/client`.

## Tests

- `bun run test` runs the non-live suite; `bun run test:integration` runs a real Codex app-server against a local mock model. CI runs both.
- `bun run test:e2e` uses a real model and runs only when started manually.

## Native fork boundary metadata

Fork, load, and context-only resume responses expose `_meta.codex.forkedAtTurnId`
for forked sessions in both ACP v1 and v2. It is the latest native turn ID shared
by the parent and child, or `null` when they share no turns. The adapter derives
it from paginated `thread/turns/list` summaries, including after the child has
continued and both processes have restarted. It does not store a second copy of
conversation provenance. History failures are propagated rather than reported
as an empty boundary.

## Waiting on upstream

- ACP SDK 2.3/2.4 standard methods. Upstream #727 (merged in `13c9eef`) moved to SDK 2.4 and adopted only `session/set_title`; it does not advertise `session/archive` / `session/unarchive`, `session/status` or `auth/status`. The fork serves `session/set_title`, `session/archive`, `session/unarchive` and the `session/list` `archived` filter over v2 (advertised as `session.archive`), and its client uses them; `_codex/session_rename`, `_codex/session_archive` and `_codex/session_unarchive` are removed. AIR keeps `_session/rename`, `_session/archive` and `_session/unarchive`. `_auth/status_update`, `proxy/initialize` / `proxy/successor` and v2 background work are not adopted.
