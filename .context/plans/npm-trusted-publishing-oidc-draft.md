# Plan (Draft): npm Trusted Publishing (GitHub Actions OIDC)

> Learnings relevant to future gates should be written back to respective gates, so future collaborators can benefit.

## Goal & Motivation
Replace long-lived `NPM_TOKEN` publishing secrets with npm **Trusted Publishing** via **GitHub Actions OIDC**, and enable npm **provenance**.

## Scope
In-scope:
- Switch CI publishing to an OIDC/provenance-compatible mechanism.
- Update `.github/workflows/publish.yml` accordingly.
- Document the required npm-side trusted publisher configuration.
- Provide a temporary, explicit fallback to `NPM_TOKEN` during migration.

Out-of-scope:
- Package build/distribution changes (repo ships TS source; Bun runtime).
- Changing the tag-driven release process.

Prereqs / constraints:
- `@agentlip` scope exists and is controlled.
- Maintainer can configure Trusted Publishing in npm.

## Codebase context
- `.github/workflows/publish.yml` — current tag-triggered publish; today uses `bun publish` + `NPM_TOKEN`.
- `.context/runbooks/first-publish-v0.1.0.md` — token-based first publish runbook.
- `README.md` — Publishing section (token-based).

---

## Gates

### Gate A — Confirm feasibility + lock in publish mechanism
Deliverables:
- Decision note (recorded in this plan):
  - `bun publish` does **not** support npm Trusted Publishing / OIDC provenance (`--provenance`).
  - CI publishing must use **`npm publish`**.
  - Bun remains for install/test steps.

Acceptance criteria:
- We can publish from GitHub Actions without storing a reusable npm token.


### Gate B — Update GitHub Actions workflow for OIDC (keep token fallback temporarily)
Deliverables:
- Update `.github/workflows/publish.yml`:
  - Add job permissions:
    - `contents: read`
    - `id-token: write` (required for GitHub OIDC)
  - Add `actions/setup-node@v4` (even if the repo uses Bun) with:
    - `node-version: '20'` (or pinned LTS)
    - `registry-url: 'https://registry.npmjs.org'` (**critical**: configures npm auth for OIDC token exchange)
  - Replace publish steps (`bun publish`) with `npm publish`:
    - Scoped packages: `npm publish --access public --provenance`
    - Unscoped CLI (`agentlip`): `npm publish --provenance`
  - Publish order and propagation delays stay the same:
    `@agentlip/protocol → @agentlip/kernel → @agentlip/workspace → @agentlip/client → agentlip → @agentlip/hub`

OIDC path notes:
- Do **not** set `NODE_AUTH_TOKEN` for OIDC publishes; a preset token may override the OIDC flow.

Temporary migration fallback (mutually exclusive with OIDC):
- If OIDC isn’t configured correctly yet on npm:
  - publish using token auth (`NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` or `~/.npmrc`)
  - **omit `--provenance`** (provenance requires OIDC)
- Remove this fallback in Gate E.

Acceptance criteria:
- Workflow remains tag-triggered on `v*`.
- Version consistency check remains.
- No secrets printed.


### Gate C — Configure npm Trusted Publishing (manual) + document
Deliverables:
- Add docs (README section and/or `.context/runbooks/npm-trusted-publishing.md`) describing the exact npm UI steps.

Manual checklist (must be done per-package; no org-wide toggle):
- Configure Trusted Publishing for each:
  - `@agentlip/protocol`
  - `@agentlip/kernel`
  - `@agentlip/workspace`
  - `@agentlip/client`
  - `@agentlip/hub`
  - `agentlip`

Details to document (per package):
- Npm UI path: `https://www.npmjs.com/package/<name>/access`
- “Trusted publishing” → link GitHub Actions publisher:
  - Repo owner: `phosphorco`
  - Repo name: `agentlip`
  - Workflow filename: `publish.yml`
  - (Optional) Environment name if releases require approvals

Acceptance criteria:
- Maintainer can follow the docs without guesswork.
- Rollback path is documented (temporarily use `NPM_TOKEN` fallback).


### Gate D — End-to-end rehearsal on a prerelease tag
Deliverables:
- A rehearsal tag that triggers CI publishing, using prerelease semver (example: `v0.2.0-rc.1`).

Acceptance criteria:
- CI publishes successfully via OIDC.
- `npm view @agentlip/client version` returns the prerelease version.
- Post-publish smoke test still passes.

Notes:
- npm ignores build metadata (`+...`); don’t use `0.1.0+rehearsal`.


### Gate E — Remove token-based publishing path
Deliverables:
- Remove token fallback from workflow and docs.
- Remove `NPM_TOKEN` GitHub secret (manual).

Acceptance criteria:
- Publish requires OIDC Trusted Publishing to be configured.

---

## Risks / Notes
- GitHub-hosted runners have non-static outbound IPs; IP allowlisting is not a robust approach.
- `--provenance` requires npm >= 9.5.0. GitHub-hosted runners with Node 20 typically include npm 10.x; self-hosted runners must verify npm version.
- If scoped vs unscoped packages require different Trusted Publishing configuration (unexpected), we may need to split workflows.
