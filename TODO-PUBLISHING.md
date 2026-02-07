Pulled the bead graph and coordinated parallel work as PM.

## 1) What `br` / `bv` says is next
- `bv --robot-next` / `bv --robot-triage` top pick remains: **bd-2bg.4** “OIDC Gate D: rehearsal prerelease tag publish (OIDC)”
  - Reason: it unblocks **bd-2bg.5** (remove token fallback) and **bd-23k.3** (publish.yml maintainability gate).

## 2) Created a tech-debt epic + beads from the reviewed plan
Converted `.context/plans/tech-debt-after-craft-local-publish-and-oidc.md` into a new epic:

- **Epic:** `bd-23k` Tech debt cleanup: release tooling hardening…
  - Children:
    - `bd-23k.1` Gate A scripts hardening
    - `bd-23k.2` Gate B verdaccio harness hardening
    - `bd-23k.3` Gate C publish.yml safety/maintainability (**blocked by bd-2bg.4**)
    - `bd-23k.4` Gate D docs sweep
    - `bd-23k.5` Gate E close-out (**blocked by bd-23k.3**)
  - Wired deps:
    - `bd-23k.3` → depends on `bd-2bg.4`
    - `bd-23k.5` → depends on `bd-23k.1/.2/.3/.4`

## 3) Launched background tasks (parallel) and integrated results
Started 3 background tasks in parallel for the *ready* tech-debt beads (with strict non-overlapping file scopes), then reviewed + tightened their output.

### Shipped code/docs changes (pushed to `origin/main`)
**Commit:** `6add9b6 chore: harden local registry + local publish scripts and docs`

Key changes included:
- `scripts/bump-version.sh`, `scripts/publish-local.sh`, `scripts/smoke-install-from-registry.sh`
  - semver validation + “invalid version” error
  - fixed `set -e` arithmetic increment footguns
  - added cleanup traps where temp dirs/files are used
- `scripts/local-registry-up.sh`, `scripts/local-registry-down.sh`
  - prereq checks, port conflict detection, 30s health timeout, machine-readable `REGISTRY_URL=...`
  - compose up/down failures now **exit 2** (runtime/external), prereq/input failures **exit 1**
- `dev/verdaccio/docker-compose.yml`
  - localhost-only binding comment retained (`127.0.0.1:4873:4873`)
- `.context/runbooks/local-registry-testing.md`
  - updated to match new behaviors + exit codes
- `README.md`
  - added “Release Troubleshooting” index
  - removed token fallback (`USE_NPM_TOKEN`); CI now publishes via OIDC only

Verification I ran after integration:
- `bash -n scripts/*.sh`
- `docker compose -f dev/verdaccio/docker-compose.yml config`
- `bun test` (passed: 725 pass, 1 skip, 0 fail)

## 4) Closed the completed beads (and committed bead updates)
Closed:
- `bd-23k.1` (Gate A) ✅
- `bd-23k.2` (Gate B) ✅
- `bd-23k.4` (Gate D) ✅

**Commit:** `6860a63 chore(beads): add tech-debt epic bd-23k and close gates A/B/D`

## 5) Helped unblock the critical path (bd-2bg.4) with an execution run-sheet
Added a checklist comment to **bd-2bg.4** with a tight “rehearsal run-sheet” (pre-flight, tag flow, verification, retry notes).

**Commit:** `e036671 chore(beads): add run-sheet comment for bd-2bg.4`

## Current state / next actions
- **Do now:** finish **bd-2bg.4** rehearsal publish (it’s still the critical path).
- **After bd-2bg.4 goes green:** we can immediately pick up (now unblocked)
  - `bd-23k.3` (publish.yml maintainability/safety gate)
  - `bd-2bg.5` (remove token fallback + delete secret)
- **Then:** `bd-23k.5` close-out becomes unblocked (wrap remaining debt into follow-up beads if any).