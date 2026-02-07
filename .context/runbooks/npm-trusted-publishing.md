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
- The configuration is **per-package** — you cannot configure Trusted Publishing at the org or scope level

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
- **npm CLI is too old** (< 11.5.1): trusted publishing isn’t supported, so npm falls back to token auth.
  - `actions/setup-node` exports a placeholder `NODE_AUTH_TOKEN=XXXXX-...` when you don’t provide a real token, which then fails with misleading `404`/`expired or revoked` messages.
- Trusted Publishing is misconfigured: npm OIDC auth fails and may fall back to token auth.

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
5. If you temporarily need to ship, set `USE_NPM_TOKEN=1` and use the token fallback path.

---

### 4. Missing provenance on published package

**Symptom:** Package published successfully, but npm page shows no provenance badge.

**Possible causes:**
1. Publish ran via **token fallback** instead of Trusted Publishing (OIDC).
2. The source repo is **private** (npm provenance badges/attestations are not supported for private source repositories).
3. Provenance generation was explicitly disabled (`provenance=false` in config or `NPM_CONFIG_PROVENANCE=false`).
4. npm CLI is too old for provenance/trusted publishing.

**Fix:**
```bash
# Check which publish path ran in CI logs:
# OIDC path: "Publish @agentlip/<pkg> (OIDC)"
# Token path: "Publish @agentlip/<pkg> (token fallback)"

# Trusted Publishing should generate provenance automatically.
# If token fallback ran, either:
#   - switch back to OIDC (unset USE_NPM_TOKEN), or
#   - add --provenance to token publishes if you still want attestations.

# Confirm the repo is public and provenance is not disabled.
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

### 6. Workflow runs but publishes with token instead of OIDC

**Symptom:** Packages published successfully, but logs show "token fallback" steps.

**Cause:** `USE_NPM_TOKEN` Actions variable is set to `'1'`.

**Fix:**
```bash
# Remove the variable:
# GitHub → Settings → Variables → Actions → USE_NPM_TOKEN
# Delete or set to '0'

# Re-run workflow:
git tag -d v0.2.0-rc.1
git tag v0.2.0-rc.1
git push --force origin v0.2.0-rc.1
```

---

## Rollback to Token-Based Publishing

If OIDC publishing fails and you need to revert temporarily:

### Option 1: Use Token Fallback (Temporary)

The current workflow includes a token-based fallback path for migration safety.

**Steps:**
1. Set GitHub Actions variable: `USE_NPM_TOKEN = '1'`
   - GitHub → Settings → Variables → Actions → New repository variable
   - Name: `USE_NPM_TOKEN`
   - Value: `1`
2. Ensure `NPM_TOKEN` secret is still configured:
   - GitHub → Settings → Secrets → Actions → `NPM_TOKEN`
3. Re-run the workflow

**Limitations:**
- No provenance attestation
- Still requires a long-lived token

### Option 2: Remove Trusted Publishing (Permanent Rollback)

If you decide not to use OIDC publishing:

1. **Remove Trusted Publishing from npm:**
   - Visit each package's access settings
   - Delete the GitHub Actions trusted publisher
2. **Update workflow:**
   - Remove `id-token: write` permission
   - Remove `actions/setup-node` step
   - Replace all publish steps with token-based equivalents:
     ```yaml
     - name: Publish @agentlip/protocol
       run: cd packages/protocol && npm publish --access public
       env:
         NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
     ```
   - Remove `--provenance` flags
3. **Keep `NPM_TOKEN` secret** configured

---

## Migration Checklist (Gate C → Gate E)

### Gate C: Initial Setup
- [ ] Configure Trusted Publishing for `@agentlip/protocol`
- [ ] Configure Trusted Publishing for `@agentlip/kernel`
- [ ] Configure Trusted Publishing for `@agentlip/workspace`
- [ ] Configure Trusted Publishing for `@agentlip/client`
- [ ] Configure Trusted Publishing for `@agentlip/hub`
- [ ] Configure Trusted Publishing for `agentlip`
- [ ] Test with prerelease tag (Gate D)

### Gate D: Rehearsal
- [ ] Create prerelease tag (e.g., `v0.2.0-rc.1`)
- [ ] Verify CI publishes via OIDC (check logs for "OIDC" steps)
- [ ] Verify provenance badge on npm package pages
- [ ] Smoke test passes

### Gate E: Cleanup (After OIDC Proven)
- [ ] Remove token fallback steps from `.github/workflows/publish.yml`
- [ ] Remove `USE_NPM_TOKEN` variable from GitHub Actions (if set)
- [ ] Delete `NPM_TOKEN` secret from GitHub (Settings → Secrets → Actions)
- [ ] Update runbooks to remove token references

---

## Reference

- npm Trusted Publishing docs: https://docs.npmjs.com/generating-provenance-statements
- GitHub Actions OIDC: https://docs.github.com/en/actions/security-guides/using-oidc-with-actions
- actions/setup-node docs: https://github.com/actions/setup-node#usage

---

## Related Runbooks

- [Craft Release Workflow](./craft-release.md) — Tag-driven release process (unchanged by OIDC migration)
- [Local Registry Testing](./local-registry-testing.md) — Test publishing flow with Verdaccio (uses token auth)
