# Plan (Draft): npm Trusted Publishing (GitHub Actions OIDC)

> Learnings relevant to future gates should be written back to respective gates, so future collaborators can benefit.

## Goal & Motivation

Eliminate long-lived `NPM_TOKEN` secrets for publishes by using npm **Trusted Publishing** with **GitHub Actions OIDC**. Improves security posture (no reusable secret; short-lived, identity-bound publish credentials) and enables npm provenance.

## Scope

In-scope:
- Update CI publish workflow to support npm Trusted Publishing (OIDC) and provenance.
- Document/setup steps for npm org/repo/workflow trust configuration.
- Keep current tag-driven release flow intact (`v*` tags publish).
- Add a safe migration path (token-based fallback until trust is confirmed).

Out-of-scope:
- Reworking package build/distribution (repo is “ship TS source; Bun runtime”).
- Changing release cadence/versioning strategy.
- Adding self-hosted runners / IP allowlists.

Dependencies / external prerequisites:
- npm org/scope `@agentlip` exists.
- Maintainer has access to configure Trusted Publishing in npm.
- GitHub repo is the canonical publish source (`phosphorco/agentlip`).

## Codebase context

Files (current state):
- `.github/workflows/publish.yml` — tag-triggered publish, currently uses `bun publish` + `NPM_TOKEN`.
- `.context/runbooks/first-publish-v0.1.0.md` — first publish runbook, currently token-based.
- `README.md` — has a Publishing section (token-based).
- `packages/*/package.json` — `files` arrays, `name`, `version` lockstep, no build step.

Key constraints/unknowns to validate:
- Whether **`bun publish`** can participate in npm Trusted Publishing (likely **no**; OIDC support is typically in `npm publish`).
- Required npm CLI version/flags for OIDC + provenance (`npm publish --provenance`).
- Whether npm Trusted Publishing can be configured per-org vs per-package for scoped + unscoped (`agentlip`) publish.

---

## Gates

### Gate A — Verify feasibility + decide publish mechanism

Deliverables:
- A short decision note added to this plan: which CLI will publish in CI:
  - Option 1: switch CI publish steps to `npm publish` (recommended)
  - Option 2: keep `bun publish` and accept token-based auth only

Acceptance criteria:
- Confirmed (via npm docs / npm CLI behavior) that GitHub OIDC Trusted Publishing works with chosen mechanism.
- Confirmed flags needed for provenance and access (`--access public` for scoped packages).

Pass/fail:
- Pass if we can publish without storing `NPM_TOKEN` and workflow changes are straightforward.

### Gate B — Update GitHub Actions workflow for OIDC (with safe fallback)

Deliverables:
- `.github/workflows/publish.yml` updated to:
  - request `permissions: { contents: read, id-token: write }`
  - run publishes using the selected mechanism (likely `npm publish`)
  - enable provenance (likely `--provenance`)
  - include a temporary fallback path (env/conditional) for `NPM_TOKEN` while migrating (optional but recommended)

Acceptance criteria:
- Workflow remains tag-triggered on `v*`.
- Version consistency check remains.
- Publish order remains dependency-safe:
  `@agentlip/protocol → @agentlip/kernel → @agentlip/workspace → @agentlip/client → agentlip (CLI) → @agentlip/hub`
- No secrets printed.

Verification:
- Lint/parse YAML.
- Dry-run reasoning: workflow should run on a tag without needing repository secrets when OIDC is configured.

### Gate C — Configure npm Trusted Publishing (manual) and document it

Deliverables:
- Runbook / docs updates describing the manual configuration:
  - add “Trusted Publishing (OIDC)” section to `README.md`
  - optionally a dedicated runbook: `.context/runbooks/npm-trusted-publishing.md`
  - include exact values to enter (org, repo, workflow filename, environment if used)

Acceptance criteria:
- Maintainer can follow docs without guesswork.
- Docs clarify differences:
  - scoped packages vs unscoped `agentlip`
  - provenance expectations
  - rollback plan (re-enable `NPM_TOKEN` secret)

### Gate D — End-to-end publish rehearsal on a patch tag

Deliverables:
- A rehearsal release tag (e.g. `v0.1.1` or `v0.1.0+rehearsal` if allowed by policy) that triggers CI.
- Confirmation that:
  - CI publishes successfully using OIDC
  - npm lists `repository`/provenance links as expected
  - post-publish smoke test still passes

Acceptance criteria:
- `npm view @agentlip/client version` returns the tag version.
- Smoke test step succeeds.

### Gate E — Remove token-based publishing path

Deliverables:
- Remove `NPM_TOKEN` usage from workflow and docs.
- Remove repository secret (manual).

Acceptance criteria:
- Publish cannot proceed without OIDC trust configuration.

---

## Risks / Notes

- GitHub-hosted runners have non-static IPs; IP allowlisting is not a robust alternative.
- Trusted Publishing + provenance requires npm CLI support; may require adding `actions/setup-node` (or ensuring npm version) even if we keep Bun for install/test.
- If Trusted Publishing cannot support unscoped `agentlip` from the same workflow, we may need separate configuration or a separate workflow.
