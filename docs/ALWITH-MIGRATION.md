# ALwith migration status

The official-upstream migration has passed release acceptance. Publication and consumer cutover are tracked separately below.

## Base and tooling

- Upstream baseline: `082be156aacac3ef21e231da2efcdf5f6af34a6b`.
- Canonical fork: `nyssance/codex-acp`; migration branch: `migration/official-upstream`.
- Package identity remains `@nyssance/codex-acp-v2`.
- Dependencies now target ACP SDK 2.0.1 and Codex 0.163.0. Keep the upstream npm lockfile workflow.
- Follow upstream formatting and tooling. Do not apply Desktop's formatting configuration. Upstream currently prescribes consistency with existing formatting and does not define a formatter script.

## Implemented on the migration branch

- Updated generated app-server schemas and nullable fixture fields.
- History browse/export and item pagination reuse native Codex history and the upstream connection.
- Catalog, account, plugin enablement, and notification extensions share the upstream process, including notification rebinding after recovery.
- Client tools use the upstream app-server, with per-prompt call deduplication, permission checks, cancellation, and late-response rejection.
- Session-scoped provider catalogs retain native and gateway models together. Model changes rebind the selected thread rather than restarting all sessions. Failed changes attempt to restore the previous routing and report failures.
- Responses compatibility transport shares its lifetime across recovered app-server clients and closes with ACP stdin.
- Fast mode sends the native `priority` request value; both `priority` and `fast` are recognized on read. The local Vendor Codex implementation confirms this mapping.
- Configuration snapshots carry revisions; stale prompts are rejected after acquiring their queue slot. Client-provided message IDs are retained.
- Native list/archive/rename/read-state extensions, prediction plumbing, retry plumbing, history seeding, native fork boundaries, and lineage have been ported. These additions are covered by focused non-live regression tests.
- Live native turn IDs and stable failed-turn transcript messages have been added. Replay preserves native turn identity and timing; real-process and real-model replay acceptance passed.

## Release acceptance (2026-10-23)

- Candidate 0.7.29 passes the complete non-live suite: 139 files, 1,871 tests passed, one skipped. Source/examples type checking, package build, executable version, and whitespace checks pass.
- [GitHub CI on 9485a30](https://github.com/nyssance/codex-acp/actions/runs/39885963008) passed, including all six platform bundles.
- The real Codex process integration test `src/__tests__/integration/foreground-state-v2.test.ts` passed: structured authentication failure, recovery, state synchronization, replay, and fork.
- With explicit user authorization, real-model acceptance passed against the built package in an isolated temporary Codex home. Two concurrent sessions received only their own replies. After restarting the adapter, full replay matched the original transcript and retained native turn metadata. Fork history was present before the fork response. A real continuation remained isolated from its parent and survived a second process restart. Temporary credentials and session files were removed after process shutdown.
- The package contains only the executable bundle, manifest, README, and Apache license. No Cargo commands were run.
- Unit and wire regressions cover request cancellation ownership, late responses, failed and interrupted replay, provider routing, host tools, revisions, asynchronous questions, and seed/retry/prediction contracts. Real-model acceptance above does not claim live coverage of every extension.

## Publication and synchronization

- Releases retain `@nyssance/codex-acp-v2` and the `codex-acp-v2` executable. Candidate version: 0.7.29; registry latest was 0.7.28 when acceptance completed.
- Publishing uses tagged releases, GitHub OIDC, and the `npm` environment. Main pushes do not publish. Live E2E is manual only.
- Upstream Sync opens reviewed merge PRs, reports merge conflicts, and never auto-merges, publishes, or launches a real Agent. It preserves official upstream ancestry.
- The canonical repository has its `npm` environment and Actions PR creation enabled. Trusted Publisher migration requires renewed npm authentication; the previous binding still targets `nyssance/codex-acp-v2` until that change succeeds.
- Remaining release operations: migrate and verify Trusted Publisher, merge the release-ready branch, publish the patch through GitHub Actions, and upgrade U and TV from npm. Desktop has no direct dependency on this adapter and requires no package cutover.
- Retire the old release path only after publication and consumer verification.
