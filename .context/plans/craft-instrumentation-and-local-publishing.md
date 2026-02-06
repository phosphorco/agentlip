# Craft instrumentation + local publishing (Agentlip)

> Learnings relevant to future gates should be written back to respective gates, so future collaborators can benefit.

## Goal and Motivation

Standardize Agentlip's release preparation with **Craft** (release branches + version bump + changelog discipline) and add a **local publish loop** (local npm registry) so we can validate "what would users install" without touching npmjs.

## Scope

Delivers:
- Craft config (`.craft.yml`) wired to this repo
- A changelog file + policy suitable for a monorepo with lockstep versions
- Make `scripts/bump-version.sh` compatible with Craft's `preReleaseCommand` contract
- GitHub Actions workflow(s) to run Craft "prepare release" (workflow_dispatch)
- Local registry + local publishing scripts (Verdaccio + `bun publish --registry ...`) and a smoke-test script
- README updates to document the new workflow

Excludes (for now):
- Replacing the existing tag-based `.github/workflows/publish.yml` pipeline
- Switching to Craft "auto" versioning (conventional commits) unless it becomes low-friction
- Shipping Node.js build artifacts or changing the Bun-only runtime stance

## Codebase context

| Area | Path | Notes |
|---|---|---|
| Current npm publish workflow | `.github/workflows/publish.yml` | Tag (`v*`) → typecheck/test → `bun publish` all packages |
| CI | `.github/workflows/ci.yml` | Test matrix |
| Version bump | `scripts/bump-version.sh` | Currently argument-driven; needs Craft env var support |
| Packages | `packages/*/package.json` | 6 packages, lockstep versions |
| Release docs | `README.md` | Has Publishing section |

Craft references:
- Craft config docs: https://craft.sentry.dev/configuration/
- Craft GitHub Actions: https://craft.sentry.dev/github-actions/

---

## Gate dependencies

```
A (Craft config)  ──┐
                    ├──► C (CI workflow)
B (bump script)   ──┘

D (local registry) ── independent (can run in parallel with A-C)

E (docs) ── depends on A, B, C, D complete
```

---

## Gate A - Craft baseline: config + changelog policy

### Deliverables
- Add `.craft.yml` with:
  - `github.owner` / `github.repo`
  - `versioning.policy: manual` (explicit version argument)
  - `changelog.policy: simple` using the default repo changelog file (`CHANGELOG.md`)
  - `preReleaseCommand: bash scripts/bump-version.sh`
  - (optional) `releaseBranchPrefix` (keep default `release` unless we need `publish/`)
- Add `CHANGELOG.md` (initial structure; doesn't need historic entries yet)

### Acceptance
- `craft` can read config and run `craft prepare 0.1.1` locally (dry-run / no push) without config errors.
- Changelog policy is enforceable (Craft blocks release if missing required entry per its rules).

### Failure handling
- **Missing Craft CLI**: Gate acceptance requires the `craft` CLI installed. Document in README per Craft docs: `npm install -g @sentry/craft` (or download the latest binary from GitHub releases). Local dry-runs are optional since CI uses the reusable workflow.
- **Config validation**: Run `craft --validate-config` (if available) or `craft prepare --dry-run` as part of CI on PRs that touch `.craft.yml`. Add a check job to `.github/workflows/ci.yml` that validates Craft config syntax.

### Notes / gotchas
- Prefer **simple changelog** first: avoids committing to conventional commits.
- Keep lockstep versioning: 1 version for all 6 packages.

---

## Gate B - Make bump-version.sh Craft-compatible

Craft runs `preReleaseCommand` during `craft prepare` with env vars:
- `CRAFT_OLD_VERSION`
- `CRAFT_NEW_VERSION`

…and also passes the old/new versions as the last two CLI args for backward compatibility.

### Deliverables
- Update `scripts/bump-version.sh` to support:
  1) direct usage: `./scripts/bump-version.sh 0.2.0` (1 arg = new version; current behavior)
  2) Craft env var usage: `CRAFT_NEW_VERSION=0.2.0 bash scripts/bump-version.sh` (0 args + env var)
  3) Craft positional args: `bash scripts/bump-version.sh <old> <new>` (2 args = old, new)
- **Mode detection logic** (in priority order):
  1. If `CRAFT_NEW_VERSION` is set → use it (ignore positional args)
  2. Else if 2 positional args → use `$2` as new version (Craft BC mode)
  3. Else if 1 positional arg → use `$1` as new version (manual mode)
  4. Else → error "Usage: bump-version.sh <new-version>"
- Ensure it does **not** commit, tag, or change git state beyond file edits.
- Exit codes: 0 on success, non-zero on failure (Craft aborts release if preReleaseCommand fails).

### Acceptance
- Running in "Craft mode" updates all 6 package versions to `CRAFT_NEW_VERSION`.
- Running in "manual mode" still works.
- `bun run typecheck` and `bun test` still pass after a version bump.

### Failure handling
- Script must be **atomic or roll-back safe**: if any package.json update fails (e.g., jq error, disk full), the script should exit non-zero **before** any partial writes. Use a temp-file-then-mv pattern: write all updated package.json files to temp locations, then mv them in place only after all succeed.
- **Idempotency**: running the script twice with the same version must produce the same result (no-op if already at target version).

---

## Gate C - GitHub Actions: Craft "prepare release" workflow

### Deliverables
- Add `.github/workflows/release-prepare.yml` (or similar):
  - Trigger: `workflow_dispatch` with input `version` (semver string, or later allow "auto")
  - **Permissions** (least-privilege):
    - `contents: write` (create release branch, push commits)
    - `pull-requests: write` (create/update release PR)
  - Uses Craft reusable workflow: `getsentry/craft/.github/workflows/release.yml@v2` (pin to latest v2.x SHA after initial setup for reproducibility)
  - `secrets: inherit` (only `GITHUB_TOKEN` is needed; no npm/registry secrets at this stage)
  - Note: Craft's reusable workflow handles checkout with `fetch-depth: 0` internally (needed for tags/history)
- (Optional but recommended) Add changelog preview workflow:
  - `pull_request_target` trigger per Craft docs
  - Uses: `getsentry/craft/.github/workflows/changelog-preview.yml@v2`
  - Minimal permissions (`pull-requests: write`, `contents: read`, `statuses: write`)
  - **Security note**: `pull_request_target` runs in the context of the base branch. Only use Craft's reusable workflow as-is (do not add custom steps that check out PR code with `ref: ${{ github.event.pull_request.head.sha }}`). If customization is needed, review Craft docs for safe patterns.

### Acceptance
- Dispatching the workflow creates the expected release branch (`release/<version>` by default) and opens/updates a PR.
- Release branch contains:
  - version bumps
  - changelog update/entry expectations
- No secrets leak (workflow uses `GITHUB_TOKEN` only).

### Concurrency & failure handling
- **Concurrency control**: Add `concurrency: { group: release-prepare, cancel-in-progress: false }` to the workflow. This queues concurrent dispatches rather than racing them; `cancel-in-progress: false` ensures a running release isn't aborted by a second trigger.
- **Stale branch cleanup**: Document in runbook (Gate E) how to delete orphaned `release/*` branches if a workflow fails mid-way: `git push origin --delete release/<version>`.
- **Workflow timeout**: Set `timeout-minutes: 15` at the job level; Craft operations are fast but network issues shouldn't hang indefinitely.

---

## Gate D - Local publishing loop (Verdaccio + Bun)

### Deliverables
- Add a local registry harness (Verdaccio recommended):
  - `dev/verdaccio/docker-compose.yml` + minimal config
  - Configure to allow local publishing:
    - Bind to `127.0.0.1:4873` only (no network exposure)
    - Use htpasswd auth with a known dev user (e.g., `dev:dev`)
    - Disable anonymous publish (require auth even locally)
  - Document security caveat in README: local registry is for testing only; never proxy to npmjs.com with write credentials
- Add scripts:
  - `scripts/local-registry-up.sh` / `scripts/local-registry-down.sh` (or a single script with subcommands)
    - `local-registry-up.sh` must output the registry URL to stdout in a parseable format (e.g., `REGISTRY_URL=http://127.0.0.1:4873`).
    - If Verdaccio is configured to require auth for publish, document the one-time local setup step: `npm adduser --registry http://127.0.0.1:4873` (stores creds in the user’s `~/.npmrc`, which `bun publish` will reuse).
    - Ensure any local-only files/dirs are gitignored (e.g., `dev/verdaccio/storage/`, `dev/verdaccio/conf/htpasswd`, any `.env`/output files).
  - `scripts/publish-local.sh <version> --registry <url>` (**registry is required, not optional**)
    - **Fails fast** if `--registry` is omitted (prevents accidental publish to npmjs.com)
    - **Registry validation**: Script must verify the registry URL starts with `http://127.0.0.1` or `http://localhost`; reject any other URL with error "Only localhost registries are allowed for local publish". This prevents misconfigured `npm_config_registry` env vars from routing to production.
    - publishes in dependency order (provisional, verify before implementing): protocol → kernel → workspace → client → cli → hub
      - Rationale: client depends on (protocol, workspace); cli depends on (kernel, workspace); hub depends on (protocol, kernel, workspace)
      - If auth is required and credentials are missing, fail with a clear message telling the user to run: `npm adduser --registry <url>`
    - uses `bun publish --registry <url>` (omit `--access public`; local registry doesn't need it)
    - exits 0 on success, non-zero on first package failure (fail-fast)
  - `scripts/smoke-install-from-registry.sh <version> --registry <url>` (**registry is required**)
    - **Fails fast** if `--registry` is omitted (same rationale as publish-local.sh)
    - creates temp dir
    - `bun add @agentlip/client@<version> --registry <url>`
    - imports `createChannel` and asserts it's a function
    - exits 0 on success, non-zero on failure

### Acceptance
- A maintainer can run:
  1) start registry
  2) publish all 6 packages to the local registry
  3) smoke install from the local registry
- The smoke install exercises the same entrypoints as the npm publish smoke test.
- **Pre-implementation check**: Before writing `publish-local.sh`, verify the publish order against actual workspace dependencies by running: `bun pm ls --all | grep @agentlip` and adjust the script accordingly.

### Failure handling & operability
- **Registry health check**: `local-registry-up.sh` must block until Verdaccio is healthy (poll `http://127.0.0.1:4873/-/ping` with 30s timeout, exit 1 on timeout). This prevents publish attempts against a not-yet-ready registry.
- **Publish failure recovery**: If `publish-local.sh` fails mid-way, the local registry may have partial packages. Add a `--clean` flag to `local-registry-down.sh` that removes Verdaccio's storage volume (`docker compose down -v`) for a clean slate.
- **Smoke test cleanup**: `smoke-install-from-registry.sh` must clean up its temp directory on both success and failure (use `trap 'rm -rf "$TMPDIR"' EXIT`).
- **Docker unavailable**: `local-registry-up.sh` should check for `docker` binary and fail with a clear message: "Docker is required but not found in PATH".
- **Port conflict**: If port 4873 is already in use, Docker will fail with a bind error. `local-registry-up.sh` should detect this (check exit code of `docker compose up`) and emit: "Port 4873 is in use. Stop existing process or run `scripts/local-registry-down.sh` first."
- **Logs**: Verdaccio container logs are the primary debug source. Document: `docker compose -f dev/verdaccio/docker-compose.yml logs -f`.

---

## Gate E - Documentation + operational runbooks

### Deliverables
- Update `README.md` Publishing section to include Craft-based "prepare release" step:
  - Generate release branch/PR via workflow_dispatch
  - Merge PR
  - Tag `vX.Y.Z` to trigger existing `publish.yml`
- Add a short runbook under `.context/runbooks/`:
  - "How to cut a release with Craft + tag-publish"
  - "How to test a release via local registry"
  - **"Troubleshooting releases"** section covering:
    - Cleaning up orphaned release branches (`git push origin --delete release/<version>`)
    - Re-running a failed release-prepare workflow (idempotent if branch already exists)
    - Resetting local registry (`scripts/local-registry-down.sh --clean`)
    - Viewing Verdaccio logs for publish failures

### Acceptance
- A new maintainer can follow docs without tribal knowledge.
- Runbook includes at least 3 troubleshooting scenarios with copy-paste commands.

---

## Verification matrix (pass/fail)

- Craft config:
  - `craft prepare 0.1.1` (local) works without config errors
- Version bump:
  - `CRAFT_NEW_VERSION=0.1.1 CRAFT_OLD_VERSION=0.1.0 bash scripts/bump-version.sh` updates all packages
  - Idempotency: running again with same version exits 0 with no changes
- Local registry:
  - publish all → `bun add @agentlip/client@0.1.1 --registry http://localhost:4873` succeeds
  - Safety: `scripts/publish-local.sh 0.1.1` (no `--registry`) exits non-zero
  - Safety: `scripts/publish-local.sh 0.1.1 --registry https://registry.npmjs.org` exits non-zero (rejects non-localhost)
- CI:
  - `release-prepare.yml` produces a release branch + PR
  - existing `publish.yml` remains unchanged and still works off tags
