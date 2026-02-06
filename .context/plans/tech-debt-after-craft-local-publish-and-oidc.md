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

---

## Gate A — Script correctness + portability sweep

### Deliverables
- Fix `set -euo pipefail` counter/arithmetics footguns in:
  - `scripts/bump-version.sh`
  - `scripts/publish-local.sh`
  - (optional) `scripts/local-registry-*.sh`
  - (optional) `scripts/smoke-install-from-registry.sh`
- Ensure all scripts:
  - run from any working directory (cd to repo root where applicable)
  - normalize registry URLs consistently (strip trailing slash for matching + use normalized value for actual commands)
  - do not claim to “preserve” temp dirs if they are always cleaned up (docs/output consistency)
- Add a lightweight `shellcheck` opt-in runner (one of):
  - `scripts/shellcheck.sh` that checks all scripts if `shellcheck` exists, or
  - a CI job that runs shellcheck only when available (keep it fast and non-flaky)

### Acceptance
- `bash -n` passes on all scripts.
- Running scripts in "no-op" paths does not exit early due to arithmetic return codes (e.g. bump to the same version; publish-local version mismatch path).

### Verification
- `bash -n scripts/*.sh`
- `./scripts/bump-version.sh 0.1.0 && echo OK` (must exit 0 even if already at version)
- `./scripts/publish-local.sh 0.1.0 --registry http://127.0.0.1:4873/` (must get past localhost/normalization checks; may fail later if registry isn’t running)

---

## Gate B — Local registry harness hardening

### Deliverables
- Improve Verdaccio + scripts UX without broadening scope:
  - `local-registry-up.sh`: verify prerequisites (`curl`, docker) with actionable errors.
  - `local-registry-up.sh`: optionally print a single machine-readable line: `REGISTRY_URL=...` (keep other output user-friendly).
  - `local-registry-down.sh`: ensure `--clean` is clearly documented and safe.
- Confirm runbooks match actual persistence behavior (docker volumes, not local folders).
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
- Smoke “happy-path” can be exercised locally (manual).

---

## Gate C — Publish workflow maintainability + safety (post-OIDC rehearsal)

> **Dependency:** Do not start this gate until the OIDC rehearsal bead **bd-2bg.4** is green.

### Deliverables
- Apply small, safe cleanups to `.github/workflows/publish.yml`:
  - Add `concurrency` to prevent two tag publishes racing.
  - Reduce duplication where it’s low-risk (e.g. use `env:` blocks / reusable bash snippets), while preserving explicit publish order and sleeps.
  - Add a clear header comment explaining:
    - default mode = OIDC
    - fallback = `USE_NPM_TOKEN == '1'`
    - provenance only in OIDC mode

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

## Gate D — Documentation tech-debt sweep

### Deliverables
- Ensure README + runbooks match reality:
  - No stale `bun publish` instructions for npmjs publishing (token fallback now uses `npm publish`).
  - `USE_NPM_TOKEN` variable instructions include where to set it (Repo Settings → Variables → Actions).
  - Craft runbook does not assume conventional commits for changelog.
- Add a short “release troubleshooting index” section linking:
  - craft-release
  - npm-trusted-publishing
  - local-registry-testing

### Acceptance
- `rg -n "bun publish" README.md .context/runbooks/*.md` returns only local-registry contexts (or none).

### Verification
- `rg -n "USE_NPM_TOKEN" README.md .context/runbooks/*.md`

---

## Gate E — Close-out + follow-ups captured

### Deliverables
- Add a short “Known remaining debt” section to this plan with any deferrals discovered during execution.
- If any changes are non-trivial, convert them into beads (epic + leaf tasks) with explicit Done means + verification.

### Acceptance
- No high-risk TODOs remain untracked.

### Verification
- `br ready` does not reveal any newly-discovered high-priority tech-debt items that should have been captured.
- If the plan is completed, move it to `.context/completed-plans/`.
