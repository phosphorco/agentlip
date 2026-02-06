# Plan: Tech debt cleanup after Craft + local publishing + OIDC migration

> Learnings relevant to future gates should be written back to respective gates, so future collaborators can benefit.

## Goal and Motivation

Stabilize and reduce maintenance risk in the release/publish tooling added during the Craft + local registry + npm Trusted Publishing (OIDC) epic. Focus on correctness (avoid footguns), maintainability (reduce YAML/script duplication), and documentation consistency.

## Scope

In-scope (this plan):
- Fix script reliability issues discovered during the epic (set -e pitfalls, temp cleanup, portability, guardrails).
- Hardening for local registry harness + local publish/smoke flows.
- Publish workflow maintainability improvements (OIDC vs token fallback clarity, concurrency, smaller diffs).
- Documentation consistency sweep (runbooks/README aligned with actual scripts/workflows).

Out-of-scope (tracked elsewhere):
- OIDC rehearsal + removal of token fallback (beads: bd-2bg.4, bd-2bg.5).
- Changing release strategy (still: Craft prepare PR → merge → tag vX.Y.Z triggers publish).
- Reworking package contents/build pipeline.

Dependencies / sequencing constraints:
- Avoid large refactors of `.github/workflows/publish.yml` until the OIDC rehearsal bead **bd-2bg.4** is green; keep changes minimal while the migration is still being validated.

## Interface contracts

**Script calling conventions (all scripts in `scripts/`):**
- Exit codes: `0` = success, `1` = user/input error (invalid args, prereqs), `2` = runtime/external failure (docker, npm, network).
- Stdout: Human-readable progress messages; machine-readable output (if any) prefixed with `KEY=value` format (one per line).
- Stderr: Error messages only. Never echo secrets.
- Arguments: Positional where order is obvious; `--flag value` for named options. Version arguments are always validated internally before use.

**Registry URL normalization contract:**
- Input: Accept URLs with or without trailing slash (`http://127.0.0.1:4873` or `http://127.0.0.1:4873/`).
- Internal: Strip trailing slash immediately upon parsing, store normalized form.
- Output: Always emit URLs without trailing slash when constructing commands or comparing URLs.

**Workflow-to-script boundary:**
- Workflows pass inputs via CLI arguments, not environment variables (exception: `NPM_TOKEN` for npm auth).
- Scripts do not read GitHub Actions context (`GITHUB_*` env vars); workflows extract and pass needed values explicitly.
- Scripts are testable standalone; workflows orchestrate but do not contain business logic.

## Codebase context

Release/publish surface area added/changed by the epic:
- Craft:
  - `.craft.yml`
  - `CHANGELOG.md`
  - `.github/workflows/release-prepare.yml`
  - `.github/workflows/changelog-preview.yml`
  - `.github/workflows/ci.yml` (Craft config validation job)
- Publishing:
  - `.github/workflows/publish.yml` (now `npm publish` with OIDC provenance; token fallback via `vars.USE_NPM_TOKEN`)
  - `scripts/bump-version.sh`
- Local registry harness:
  - `dev/verdaccio/docker-compose.yml`
  - `dev/verdaccio/config.yaml`
  - `scripts/local-registry-up.sh`
  - `scripts/local-registry-down.sh`
  - `scripts/publish-local.sh`
  - `scripts/smoke-install-from-registry.sh`
- Docs:
  - `README.md`
  - `.context/runbooks/craft-release.md`
  - `.context/runbooks/local-registry-testing.md`
  - `.context/runbooks/npm-trusted-publishing.md`
  - `.context/runbooks/first-publish-v0.1.0.md`

## Risks

- **Release tooling regressions**: changes to scripts/workflows can block real releases. Prefer small diffs and keep verification explicit.
- **`set -euo pipefail` edge cases**: fixing one early-exit path can create another. Verify no-op paths and failure paths.
- **Workflow duplication vs clarity**: DRY refactors can reduce readability in critical infra. Bias toward clarity.
- **Command injection via version strings**: Version arguments passed to shell scripts must be validated (semver pattern only) before interpolation into commands.
- **Token leakage in logs**: npm publish and workflow logs can leak tokens. Ensure `--quiet` flags or output filtering where needed; never echo secrets.
- **Partial publish state**: Multi-package publish can fail mid-sequence, leaving registry in inconsistent state. Document recovery procedure.
- **Interrupted scripts**: Ctrl+C or OOM-kill can leave docker containers running or temp files behind. Scripts must use `trap` for cleanup.
- **Network timeouts**: Docker pulls, npm publish, and registry health checks can hang indefinitely without explicit timeouts.
- **Concurrent local runs**: Two developers (or CI jobs on same runner) running local-registry scripts simultaneously can cause port conflicts or data corruption.

---

## Gate A - Script correctness + portability sweep

### Deliverables
- Fix `set -euo pipefail` arithmetic issues (e.g., `(( count++ ))` returns non-zero when count is 0, causing script exit) in:
  - `scripts/bump-version.sh`
  - `scripts/publish-local.sh`
  - (optional) `scripts/local-registry-*.sh`
  - (optional) `scripts/smoke-install-from-registry.sh`
- Ensure all scripts conform to **Interface contracts** section above:
  - Exit codes: `0`/`1`/`2` as specified; no silent failures.
  - run from any working directory (scripts that need repo context must `cd "$(dirname "$0")/.."` to repo root at startup)
  - normalize registry URLs per the contract (strip trailing slash on input, emit without trailing slash)
  - do not claim to "preserve" temp dirs if they are always cleaned up (docs/output consistency)
  - **validate version arguments** match semver pattern (`^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$`) before use; exit `1` with clear error otherwise (prevents command injection)
- Add a lightweight `shellcheck` opt-in runner (one of):
  - `scripts/shellcheck.sh` that checks all scripts if `shellcheck` exists, or
  - a CI job that runs shellcheck only when available (keep it fast and non-flaky)
- **Interrupt safety**: All scripts that create temp files or start background processes must use `trap 'cleanup' EXIT ERR INT TERM` to clean up on Ctrl+C or failure. Cleanup function should be idempotent.

### Acceptance
- `bash -n` passes on all scripts.
- Running scripts in "no-op" paths does not exit early due to arithmetic return codes (e.g. bump to the same version; publish-local version mismatch path).

### Verification
- `bash -n scripts/*.sh`
- `./scripts/bump-version.sh 0.1.0 && echo OK` (must exit 0 even if already at version)
- `./scripts/publish-local.sh 0.1.0 --registry http://127.0.0.1:4873/` (must get past localhost/normalization checks; may fail later if registry isn't running)
- Semver validation rejects malformed input: `./scripts/bump-version.sh '$(whoami)' 2>&1 | grep -q 'invalid version'` (must reject with clear error, not execute)
- **Interrupt safety**: Visual verification that scripts declare `trap` for cleanup. Run: `grep -l 'trap.*cleanup' scripts/*.sh` should include scripts that create temp dirs (smoke-install-from-registry.sh, publish-local.sh). Manual test: start a long-running script, Ctrl+C, verify no orphan temp dirs in `/tmp`.

---

## Gate B - Local registry harness hardening

### Deliverables
- Improve Verdaccio + scripts UX without broadening scope:
  - `local-registry-up.sh`: verify prerequisites (`curl`, docker) with actionable errors; exit `1` per contract if missing.
  - `local-registry-up.sh`: on success, emit `REGISTRY_URL=http://127.0.0.1:4873` to stdout (per `KEY=value` contract). Other output remains human-friendly.
  - `local-registry-up.sh`: **Timeout + health check**: poll `curl -sf http://127.0.0.1:4873/-/ping` with 1s interval, 30s total timeout. Exit `2` if timeout exceeded with message: "Registry failed to start within 30s. Check `docker compose logs`."
  - `local-registry-up.sh`: **Port conflict detection**: Before starting, check if port 4873 is already bound (`lsof -i :4873` or `nc -z`). Exit `1` with clear error if occupied (avoids silent docker-compose failure).
  - `local-registry-down.sh`: ensure `--clean` is clearly documented and safe; exit `0` even if already down (idempotent).
- **Security: Verify Verdaccio binds to localhost only** (`127.0.0.1:4873`) in `dev/verdaccio/docker-compose.yml` port mapping. Add a comment explaining this is intentional to prevent network exposure.
- Confirm `.context/runbooks/local-registry-testing.md` matches actual persistence behavior (docker volumes, not local folders).
- **Concurrent run warning**: `local-registry-up.sh` should detect if another instance may be running (check for existing container with same name via `docker ps -q -f name=verdaccio`) and warn: "Registry container already running. Run `local-registry-down.sh` first or use `--force`."
- (optional) Add `scripts/local-registry-e2e.sh` that assumes you already ran `npm adduser --registry ...` once, then runs:
  - `local-registry-up.sh` → `publish-local.sh` → `smoke-install-from-registry.sh` → `local-registry-down.sh`
  This gives a repeatable non-interactive regression check.

### Acceptance
- A developer can run:
  - `./scripts/local-registry-up.sh`
  - `npm adduser --registry http://127.0.0.1:4873`
  - `./scripts/publish-local.sh <version> --registry http://127.0.0.1:4873`
  - `./scripts/smoke-install-from-registry.sh <version> --registry http://127.0.0.1:4873`
  - `./scripts/local-registry-down.sh --clean`
  with clear failure messages at each step.

### Verification
- `docker compose -f dev/verdaccio/docker-compose.yml config` parses.
- `grep -q '127.0.0.1:4873' dev/verdaccio/docker-compose.yml` confirms localhost-only binding.
- **Timeout behavior**: With registry down, `./scripts/local-registry-up.sh` must exit within ~35s (not hang).
- **Port conflict**: With port 4873 occupied (e.g., `nc -l 4873 &`), `./scripts/local-registry-up.sh` must exit `1` immediately with clear error.
- Smoke "happy-path" can be exercised locally (manual).

---

## Gate C - Publish workflow maintainability + safety (post-OIDC rehearsal)

> **Dependency:** Do not start this gate until the OIDC rehearsal bead **bd-2bg.4** is green.

### Deliverables
- Apply small, safe cleanups to `.github/workflows/publish.yml`:
  - Add `concurrency` to prevent two tag publishes racing:
    ```yaml
    concurrency:
      group: publish-${{ github.ref }}
      cancel-in-progress: false  # Never cancel in-progress publishes (causes partial state)
    ```
  - Reduce duplication where it's low-risk (e.g. extract shared variables to `env:` blocks at job level), while preserving explicit publish order and sleeps.
  - Add a clear header comment explaining:
    - default mode = OIDC
    - fallback = `USE_NPM_TOKEN == '1'`
    - provenance only in OIDC mode
  - **Token hygiene** (per workflow-script boundary contract): `NPM_TOKEN` secret passed only to `npm publish` step via env, not to scripts. Verify workflow logs do not echo token values (use `::add-mask::` if interpolating).
  - **Publish timeout**: Each `npm publish` step should have `timeout-minutes: 5` to fail fast on network hangs (default GHA timeout is 6 hours).
  - **Workflow-script boundary**: Workflow extracts tag version from `GITHUB_REF`, validates semver format in workflow before passing to any script. Scripts receive clean version string, not raw ref.
  - **Partial publish recovery**: Add a header comment documenting recovery procedure if publish fails mid-sequence:
    1. Identify which packages succeeded: `npm view @agentlip/<pkg>@<version>` for each package (404 = not published).
    2. Re-run the publish workflow from the same tag (idempotent: npm will 403 on already-published, continue to next).
    3. If npm 403 errors persist on *unpublished* packages (can happen due to registry cache propagation), wait 5 min and retry.
    4. If still failing, manually publish from local: `cd packages/<pkg> && npm publish --access public` (requires local npm login).

### Acceptance
- YAML still reads clearly and preserves existing behavior.
- `python3 -c 'import yaml; yaml.safe_load(open(".github/workflows/publish.yml"))'` succeeds.

### Verification
- Trigger publish on a prerelease tag (e.g. `v0.1.1-rc.1`) in the actual repo.
- Confirm:
  - concurrency prevents duplicate/racing publish runs
  - OIDC mode emits provenance (`npm publish --provenance` path)
  - token fallback still works when `USE_NPM_TOKEN == '1'` (no provenance)

---

## Gate D - Documentation tech-debt sweep

### Deliverables
- Ensure README + runbooks match reality:
  - No stale `bun publish` instructions for npmjs publishing (token fallback now uses `npm publish`).
  - `USE_NPM_TOKEN` variable instructions include where to set it (Repo Settings → Variables → Actions).
  - Craft runbook does not assume conventional commits for changelog.
- Add a short "release troubleshooting index" section linking:
  - craft-release
  - npm-trusted-publishing
  - local-registry-testing

### Acceptance
- `rg -n "bun publish" README.md .context/runbooks/*.md` returns only local-registry contexts (or none).

### Verification
- `rg -n "USE_NPM_TOKEN" README.md .context/runbooks/*.md`

---

## Gate E - Close-out + follow-ups captured

### Deliverables
- Add a short "Known remaining debt" section to this plan with any deferrals discovered during execution.
- If any changes are non-trivial, convert them into beads (epic + leaf tasks) with explicit Done means + verification.

### Acceptance
- No high-risk TODOs remain untracked.

### Verification
- `br ready` does not reveal any newly-discovered high-priority tech-debt items that should have been captured.
- If the plan is completed, move it to `.context/completed-plans/`.
