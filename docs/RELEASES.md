# Releases and upstream synchronization

The canonical fork is `nyssance/codex-acp`. The npm identity remains
`@nyssance/codex-acp-v2`, with the `codex-acp-v2` executable. Existing consumers
keep their package name and update the version after a verified release.

## Publishing

`.github/workflows/publish.yml` publishes an existing `v<package version>` tag
when its GitHub release is published, or when the workflow is manually dispatched
with that tag. It verifies the package identity, rejects a private manifest, runs
type checking and non-live unit tests, and builds through `prepublishOnly` before
publishing with provenance. A failure stops publication. Main pushes do not publish.

Configure the package's npm Trusted Publisher once with:

- GitHub owner: `nyssance`
- Repository: `codex-acp`
- Workflow filename: `publish.yml`
- Environment: `npm`

The workflow uses GitHub OIDC; do not add an npm token fallback. Binding is a
registry-side setting and must be verified separately from the workflow file.
Changing the binding requires npm account verification. 
Update `package.json` and `bun.lock` together, choose an unused patch version
newer than the published package, and review CI and the packed artifact before
creating the release tag. Upstream release-please versions and preview
channels do not control this fork.

## Upstream synchronization

`Upstream Sync` runs on weekdays and can be started manually in GitHub Actions.
It merges official upstream history into a dedicated branch, opens a review PR,
and checks the merged source. An existing branch is reused without overwriting it.
Conflicts fail with the conflicting paths and require manual resolution.

The synchronization workflow does not auto-merge, publish, or launch an Agent.
Review extension behavior, generated Codex schemas, and workflow changes together.
The GitHub repository must allow Actions to create pull requests. Check the sync
run's results before merging; PR creation alone is not evidence that tests passed.

Integration tests run a real Codex app-server against a local mock model and
are part of CI. E2E tests use a real model; they require explicit authorization
and are not part of unattended synchronization or publishing.
