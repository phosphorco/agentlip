# Runbook: npm Trusted Publishing (OIDC) Configuration

**Use case:** Configure npm Trusted Publishing for all Agentlip packages to enable OIDC-based publishing from GitHub Actions with provenance.

**Audience:** Maintainers setting up or troubleshooting OIDC publishing.

---

## Overview

npm Trusted Publishing allows GitHub Actions to publish packages without storing a long-lived `NPM_TOKEN` secret. Instead, GitHub's OIDC provider issues short-lived tokens that npm validates against your configured trusted publisher settings.

**Benefits:**
- No long-lived tokens to rotate or leak
- Provenance attestation (signed metadata linking published package to source commit)
- More secure supply chain

**Tradeoff:**
- Must configure manually per package (no org-wide setting)
- npm validates repo owner, repo name, and workflow filename

---

## Prerequisites

- [ ] npm account with publish access to all packages
- [ ] Access to package settings at npmjs.org
- [ ] CI uses **npm CLI >= 11.5.1** (Trusted Publishing requirement). Our `publish.yml` should run with **Node 24+** (ships npm 11.x on GitHub-hosted runners).
- [ ] Packages you'll configure:
  - `@agentlip/protocol`
  - `@agentlip/kernel`
  - `@agentlip/workspace`
  - `@agentlip/client`
  - `@agentlip/hub`
  - `agentlip` (unscoped CLI package)

---

## Setup Instructions (Repeat for Each Package)

### 1. Navigate to Package Access Settings

For **scoped packages** (`@agentlip/*`):
```
https://www.npmjs.com/package/@agentlip/<package-name>/access
```

For **unscoped package** (`agentlip`):
```
https://www.npmjs.com/package/agentlip/access
```

**Specific URLs:**
- `@agentlip/protocol`: https://www.npmjs.com/package/@agentlip/protocol/access
- `@agentlip/kernel`: https://www.npmjs.com/package/@agentlip/kernel/access
- `@agentlip/workspace`: https://www.npmjs.com/package/@agentlip/workspace/access
- `@agentlip/client`: https://www.npmjs.com/package/@agentlip/client/access
- `@agentlip/hub`: https://www.npmjs.com/package/@agentlip/hub/access
- `agentlip`: https://www.npmjs.com/package/agentlip/access

### 2. Link GitHub Actions Publisher

In the **Publishing access** section, find **Trusted publishing** and click **Add trusted publisher**.

Fill in the following values (same for all 6 packages):

| Field | Value |
|-------|-------|
| **Provider** | GitHub Actions |
| **Repository owner** | `phosphorco` |
| **Repository name** | `agentlip` |
| **Workflow filename** | `publish.yml` |
| **Environment name** | *(leave blank)* |

**Notes:**
- **Workflow filename:** Must match `.github/workflows/publish.yml` exactly (case-sensitive)
- **Environment name:** Only required if the workflow uses GitHub Environments for approvals (we don't)
- The configuration is **per-package** - you cannot configure Trusted Publishing at the org or scope level

### 3. Save and Verify

After saving, the package settings should show:
```
Trusted publishers: GitHub Actions (phosphorco/agentlip @ publish.yml)
```

**Repeat this for all 6 packages before triggering a release.**

---

## Verification

After configuring all packages, test with a prerelease tag (Gate D):

```bash
git tag v0.2.0-rc.1
git push origin v0.2.0-rc.1
```

Monitor the GitHub Actions workflow at:
```
https://github.com/phosphorco/agentlip/actions/workflows/publish.yml
```

**Expected outcome:**
- All publish steps succeed (OIDC path used, no token fallback)
- The published version is present on npm (works for prereleases too):
  - `npm view @agentlip/client@0.2.0-rc.1 version` → `0.2.0-rc.1`
- For prereleases, dist-tags include the prerelease channel (derived from the prerelease id, e.g. `rc`):
  - `npm view @agentlip/client dist-tags` includes `rc: 0.2.0-rc.1`
- Provenance badge visible on npm package pages
- Smoke test passes

---

## Troubleshooting

### 1. Prerelease publish fails: must specify `--tag`

**Symptom:** CI fails with:
- `npm error You must specify a tag using --tag when publishing a prerelease version.`

**Cause:** npm CLI v11+ requires an explicit dist-tag for prerelease versions (`x.y.z-...`). Our workflow computes a tag (for example `rc`) and passes `--tag` to all `npm publish` commands.

**Fix:**
- Ensure `.github/workflows/publish.yml` computes `NPM_DIST_TAG` and all `npm publish` commands include `--tag $NPM_DIST_TAG`.
- Re-push the git tag so the publish workflow runs from the updated ref.

---

### 2. 403 Forbidden during publish

**Symptom:** CI fails with `npm ERR! 403 Forbidden - PUT https://registry.npmjs.org/@agentlip/...`

**Possible causes:**
1. **Trusted Publishing not configured** for this package
2. **Mismatch in publisher config** (wrong repo owner, repo name, or workflow filename)
3. **Job permissions missing** (`id-token: write` not set in workflow)

**Fix:**
```bash
# Verify Trusted Publishing configured:
# Visit https://www.npmjs.com/package/<package-name>/access

# Check workflow has correct permissions:
# .github/workflows/publish.yml should have:
#   permissions:
#     contents: read
#     id-token: write

# Verify workflow filename matches exactly:
# npm expects: publish.yml
# Actual file: .github/workflows/publish.yml
```

---

### 3. `Access token expired or revoked` and/or `404 Not Found` during publish

**Symptom:** CI fails with a combination of messages like:
- `npm notice Access token expired or revoked. Please try logging in again.`
- `npm ERR! 404 Not Found - PUT https://registry.npmjs.org/@agentlip%2f<package> - Not found`

**Why this happens:**
- npm may return `404 Not Found` for authorization failures, especially for scoped packages.
- **npm CLI is too old** (< 11.5.1): trusted publishing isn't supported.
- Trusted Publishing is misconfigured: npm OIDC auth fails.

**Fix:**
1. Confirm CI is using **npm CLI >= 11.5.1** (Trusted Publishing requirement).
   - Easiest: use **Node 24+** in `actions/setup-node`.
2. Re-check Trusted Publishing config for the specific package:
   - Provider: GitHub Actions
   - Repo owner: `phosphorco`
   - Repo name: `agentlip`
   - Workflow filename: `publish.yml`
   - Environment name: (blank)
3. Confirm the workflow has `permissions: id-token: write`.
4. Confirm the workflow uses `actions/setup-node` with `registry-url: https://registry.npmjs.org`.
5. If you must ship urgently, use manual local publish (see Emergency Fallback section).

---

### 4. Missing provenance on published package

**Symptom:** Package published successfully, but npm page shows no provenance badge.

**Possible causes:**
1. The source repo is **private** (npm provenance badges/attestations are not supported for private source repositories).
2. Provenance generation was explicitly disabled (`provenance=false` in config or `NPM_CONFIG_PROVENANCE=false`).
3. npm CLI is too old for provenance/trusted publishing.
4. Package was published manually (not via CI).

**Fix:**
```bash
# CI publishes with --provenance automatically.
# Confirm the repo is public (required for provenance).
# If published manually, provenance won't be attached unless you configure it locally.
```

---

### 5. Wrong repo or workflow referenced

**Symptom:** 403 Forbidden, but Trusted Publishing is configured.

**Cause:** npm validates the OIDC token's `repository` and `workflow_ref` claims. If they don't match, publish is rejected.

**Fix:**
1. Verify Trusted Publishing config in npm UI matches:
   - Repository owner: `phosphorco`
   - Repository name: `agentlip`
   - Workflow filename: `publish.yml`
2. Check CI logs for token claims (npm may log them on failure)
3. If repo was renamed or transferred, reconfigure Trusted Publishing

---

### 6. OIDC token claims mismatch

**Symptom:** 403 Forbidden even with Trusted Publishing configured correctly in npm UI.

**Cause:** The OIDC token's claims don't match the configured publisher (e.g., after a repo rename or fork).

**Fix:**
1. Check the GitHub Actions logs for the actual claims being sent
2. Update Trusted Publishing config in npm to match:
   - Repository owner: `phosphorco`
   - Repository name: `agentlip`
   - Workflow filename: `publish.yml`
3. If repo was renamed or transferred, reconfigure all 6 packages

---

## Emergency Fallback: Manual Local Publish

CI no longer supports token-based publishing. If OIDC publishing fails:

### Option 1: Fix OIDC Configuration (Preferred)

Most OIDC failures are configuration issues. See Troubleshooting above and fix the root cause.

### Option 2: Manual Publish from Local Machine (Emergency)

If CI is completely broken and you need to ship urgently:

```bash
# Authenticate with your personal npm token
npm login

# Publish in dependency order (from repo root)
cd packages/protocol && npm publish --access public && cd ../..
sleep 5
cd packages/kernel && npm publish --access public && cd ../..
sleep 5
cd packages/workspace && npm publish --access public && cd ../..
sleep 5
cd packages/client && npm publish --access public && cd ../..
sleep 5
cd packages/cli && npm publish && cd ../..
sleep 5
cd packages/hub && npm publish --access public && cd ../..
```

**Limitations:**
- No provenance attestation (unless you configure provenance locally)
- Relies on personal credentials, not CI automation
- Use only as emergency measure; fix OIDC config afterwards

---

## Migration Checklist (Completed)

### Gate C: Initial Setup ✓
- [x] Configure Trusted Publishing for `@agentlip/protocol`
- [x] Configure Trusted Publishing for `@agentlip/kernel`
- [x] Configure Trusted Publishing for `@agentlip/workspace`
- [x] Configure Trusted Publishing for `@agentlip/client`
- [x] Configure Trusted Publishing for `@agentlip/hub`
- [x] Configure Trusted Publishing for `agentlip`
- [x] Test with prerelease tag (Gate D)

### Gate D: Rehearsal ✓
- [x] Create prerelease tag (e.g., `v0.1.1-rc.1`)
- [x] Verify CI publishes via OIDC (check logs for "OIDC" steps)
- [x] Verify provenance badge on npm package pages
- [x] Smoke test passes

### Gate E: Cleanup (After OIDC Proven) — In Progress
- [ ] Remove token fallback steps from `.github/workflows/publish.yml`
- [ ] Delete `USE_NPM_TOKEN` variable from GitHub Actions (if set): Settings → Variables → Actions
- [ ] Delete `NPM_TOKEN` secret from GitHub: Settings → Secrets → Actions
- [ ] Update runbooks to remove token references ← this doc

---

## Post-Migration Cleanup (Manual Steps)

After Gate E workflow changes are merged, complete these manual GitHub cleanup steps:

1. **Delete `USE_NPM_TOKEN` variable** (if it exists):
   - Go to: GitHub → Settings → Secrets and variables → Actions → Variables
   - Find `USE_NPM_TOKEN` and delete it

2. **Delete `NPM_TOKEN` secret**:
   - Go to: GitHub → Settings → Secrets and variables → Actions → Secrets
   - Find `NPM_TOKEN` and delete it

These secrets/variables are no longer needed since CI publishes exclusively via OIDC.

---

## Reference

- npm Trusted Publishing docs: https://docs.npmjs.com/generating-provenance-statements
- GitHub Actions OIDC: https://docs.github.com/en/actions/security-guides/using-oidc-with-actions
- actions/setup-node docs: https://github.com/actions/setup-node#usage

---

## Related Runbooks

- [Craft Release Workflow](./craft-release.md) - Tag-driven release process (unchanged by OIDC migration)
- [Local Registry Testing](./local-registry-testing.md) - Test publishing flow with Verdaccio (uses token auth)
