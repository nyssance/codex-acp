# ALwith migration status

This branch is work in progress. It is not a production replacement yet. The npm package remains `private: true` to prevent an incomplete cutover.

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
- Native list/archive/rename/read-state extensions, prediction plumbing, retry plumbing, history seeding, native fork boundaries, and lineage have been ported. These later additions still require focused integration verification.
- Live native turn IDs and stable failed-turn transcript messages have been added. Replay/live metadata equivalence is not yet verified.

## Verification actually performed

- Release candidate 0.7.29 passes the complete non-live suite: 139 files, 1,871 tests passed, one skipped (`/private/tmp/upstream-release-unit.log`). Source/examples type checking, package build, executable `--version`, and whitespace checks pass.
- The last complete non-live run before the latest changes passed 1,890 tests and failed five. The five failures were subsequently fixed and their 110-test focused run passed.
- Receipt correlation: 54 tests passed after reviewing 24 state-notification snapshots.
- Replay identity and whole-message primers: 32 tests passed after reviewing two snapshots.
- Native history, child replay, foreign-writer ownership, and session lifecycle: 46 tests passed. Read-only sessions reject prompt/config/cancel/delete/archive/unarchive/rename and close without unsubscribing the foreign writer.
- `npm run build` passed. `npm pack --dry-run` contains only the executable bundle, manifest, README, and Apache license (four files, approximately 431 KB compressed). Rebuild after later source changes before release.
- Complete non-live run 3 passed 1,851 tests, failed nine state-metadata snapshots, and skipped one test. Those nine differences were fixed; the affected 62-test run passed both with reviewed updates and without update mode. Later replay changes still need the final full regression.
- No Cargo commands or real Agent sessions were started.

## Publication and synchronization

- Publishing now uses tagged releases, GitHub OIDC, and the `npm` environment. Main pushes do not publish previews. Live E2E is manual only.
- Removed upstream release-please manifests, preview-version scripts, release preflight, and the automatic Codex update workflow. Release instructions describe this fork's actual package identity and workflow.
- Upstream synchronization reuses a branch keyed by upstream and base revisions, never overwrites an existing branch, reports merge conflicts, and opens a review PR even when verification fails. The PR instructs reviewers to check the run rather than claiming success.
- npm account verification succeeded. `npm trust list` confirmed publisher ID `315cdcac-6da2-40bf-866f-df4b0afce85c` still points at `nyssance/codex-acp-v2`, workflow `publish.yml`. It has not been changed yet. Migrate it only when the canonical fork is release-ready.
- Candidate package is 0.7.29 and remains private pending final acceptance. Registry latest was rechecked at 0.7.28. The canonical repository now has its `npm` environment and Actions PR creation enabled.

## Remaining cutover gates

1. Local non-live regression is green. Push the final candidate and verify GitHub CI, including platform bundles.
2. Replay now joins snapshot-bounded turn metadata with streamed item pages, restores timing/interruption/error metadata, and includes failed turns with no items. Three pure replay tests pass; both legacy and paginated failed-turn wire tests pass. V2 fork now streams replay before its response, matching U’s existing contract. Run final replay/fork regressions after the latest fixture change.
3. Open-request cancellation tracks request ownership across async setup. Late new/resume/fork results are cleaned up; a cancelled old resume cannot close or overwrite a newer owner (four wire tests). Responses routes reuse stable workspace resolvers and replace readers after app-server recovery. All are covered by the green release-candidate suite.
4. Existing extension capability flags are restored after targeted validation, including fork boundaries, lineage, receipts, retries, seed history and predictions. Review their initialize snapshot in the final regression.
5. Migrate and verify Trusted Publisher, and validate release/sync workflows on GitHub. Repository environment and PR permissions are configured.
6. Build and inspect the final package, commit/push to the canonical fork, publish a patch, then update and verify Desktop, U, and TV against the published package.
7. Update the Desktop migration record and retire the old release path only after all consumers are verified.

No publication or consumer cutover has occurred. The migration implementation is being checkpointed on the migration branch; do not merge or publish until the remaining gates pass.

Real Codex test-session authorization was requested explicitly, as required by the user. No response has arrived; do not run live/session-creating tests without it.
