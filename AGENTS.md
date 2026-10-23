# Repository Guidelines

## Project Structure

- `src/` — ACP server implementation. Entry point: `src/index.ts`.
- `src/__tests__/` — Vitest suite (behavior-focused tests around ACP/Codex events).
- `src/app-server/` — generated Codex app-server API types (regenerate via `npm run generate-types`).
- `dist/bin/` — release-ready single-file executables and `*.zip` archives.
- `.github/workflows/ci.yml` — CI mirrors the local workflow: typecheck → tests → bundle.


## Coding Style & Naming Conventions

- Keep edits consistent with existing upstream formatting. Follow this fork’s upstream tooling and configuration; do not apply Desktop’s `fab format` or Bun formatter configuration.
- When adding env/config knobs, document them in `readme-dev.md`.
- The adapter serves ACP v1 and v2. A change that is not meant for one protocol version only must work correctly in both.
- When updating discriminated-union/event `switch` statements, do not add a trailing fallback like `return null` only to satisfy TypeScript.
- Handle each variant with an explicit `case`; if intentionally ignored, use an explicit no-op case.
- Code comments should be concise and in plain language; avoid verbosity and overly specific detail.

## Testing Guidelines

- Tests live under `src/__tests__/` and use Vitest.
- Favor event-driven assertions (see `src/__tests__/CodexACPAgent/*`).
- Prefer snapshot-based tests using `toMatchFileSnapshot()` over inline assertions.
- When snapshot response data drifts, prefer replacing that response payload with a stable placeholder over asserting fragile fields (except for 'model/list').
- Focus on behavior and outputs rather than implementation details.
- Cover both ACP v1 and v2 when a change affects what a client receives (updates, responses, replay). A change to internal logic only does not need its tests duplicated per version.
- Use `/run-codex` skill (`.agents/skills/run-codex/`) to test with real Codex and observe actual events.

## Pull Requests

- Use conventional commit titles. Review upstream merges before merging them; a merged PR never publishes a package by itself.

## Releasing

- Keep the npm identity `@nyssance/codex-acp-v2`; the canonical repository is `nyssance/codex-acp`.
- Releases use `.github/workflows/publish.yml`, npm Trusted Publishing, and the `npm` GitHub environment. Do not add an npm token fallback.
- Publishing requires an existing `v<package version>` tag and a public package manifest. Main pushes do not publish previews or stable packages.
- Use patch releases for this migration. Release-please metadata from upstream must not control this fork's package version.
- Upstream Sync creates reviewed merge PRs and runs non-live checks. Never auto-merge or launch a real Agent to resolve conflicts.
- Live E2E tests are manual only and require explicit authorization to create Agent sessions.

## Docs

- Codex app-server usage: see https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md when touching protocol/transport details, adding or consuming JSON-RPC methods, handling approvals/turn events, or updating generated schema/clients.
- App-server events: prefer `thread/*`, `turn/*`, and `item/*` event surfaces; avoid the deprecated `codex/event/*` API (planned removal). Keep implementations aligned with generated types in `src/app-server` (including `v2` exports).
