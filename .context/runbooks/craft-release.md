# Runbook: Craft Release Workflow

**Use case:** Prepare and publish a new version of Agentlip using the Craft-powered release workflow.

**Audience:** Maintainers creating releases.

---

## Prerequisites

- [ ] Clean working directory: `git status` shows no uncommitted changes
- [ ] On `main` branch: `git branch --show-current`
- [ ] All tests pass: `bun test`
- [ ] Typecheck passes: `bun run typecheck`
- [ ] **OIDC path (preferred):** Trusted Publishing configured for all 6 packages (see [npm-trusted-publishing.md](./npm-trusted-publishing.md))
- [ ] **Token fallback:** If `USE_NPM_TOKEN=1` is set, ensure `NPM_TOKEN` secret is configured (Settings → Secrets → Actions)

---

## Step 1: Trigger Release Prepare Workflow

1. Go to GitHub Actions: `https://github.com/phosphorco/agentlip/actions/workflows/release-prepare.yml`
2. Click **Run workflow** (top right)
3. Select branch: `main`
4. Enter version (semver): e.g., `0.2.0`, `1.0.0-beta.1`
5. Click **Run workflow**

**What happens:**
- Craft creates branch `release/X.Y.Z`
- Runs `scripts/bump-version.sh X.Y.Z` to update all `package.json` versions
- Updates `CHANGELOG.md` with commit log since last release
- Opens a pull request

**Duration:** ~1-2 minutes

---

## Step 2: Review the Release PR

1. Wait for PR to appear (linked in workflow run)
2. Review changes:
   - All 6 `package.json` files show new version
   - `CHANGELOG.md` has new section with commits
   - No unexpected file changes
3. CI checks must pass (typecheck + tests)
4. Approve and **merge** the PR

**Prefer merge commits (avoid squash-merge)** so the release PR history stays easy to audit. If you must squash, ensure the PR still contains the version bumps + `CHANGELOG.md` updates.

---

## Step 3: Tag the Release

After PR is merged:

```bash
# Pull the merged commit
git checkout main
git pull origin main

# Tag with the version (include 'v' prefix)
git tag v0.2.0

# Push the tag
git push origin v0.2.0
```

**What happens:**
- Tag `vX.Y.Z` triggers `.github/workflows/publish.yml`
- CI publishes all 6 packages to npm in dependency order
- Post-publish smoke test runs

**Duration:** ~3-5 minutes

---

## Step 4: Verify Publish

After CI completes:

```bash
# Check all packages are published
for pkg in protocol kernel workspace client cli hub; do
  npm view @agentlip/$pkg version
done
# Expected: all return the new version (e.g., 0.2.0)

# Check CLI package (unscoped)
npm view agentlip version
# Expected: the new version
```

**Also verify:**
- npm package pages updated (e.g., `https://www.npmjs.com/package/@agentlip/client`)
- **Provenance badge** visible on npm package pages (if OIDC path was used)
- CI logs show `Publish ... (OIDC)` steps ran (not `(token fallback)`)

---

## Step 5: Smoke Test (Local)

```bash
TEMP="$(mktemp -d)"
cd "$TEMP"

bun init -y
bun add @agentlip/client@0.2.0  # Use actual version

cat > test.ts << 'EOF'
import { createChannel, createTopic, sendMessage } from "@agentlip/client";
console.log("createChannel:", typeof createChannel);
console.log("createTopic:", typeof createTopic);
console.log("sendMessage:", typeof sendMessage);
EOF

bun run test.ts
# Expected output:
# createChannel: function
# createTopic: function
# sendMessage: function

cd -
rm -rf "$TEMP"
```

---

## Common Failure Modes

### 1. Release Prepare Fails: "dirty repository"

**Symptom:** Craft workflow fails with uncommitted changes error.

**Cause:** Working directory has uncommitted files.

**Fix:**
```bash
git status
# Commit or stash changes, then re-run workflow
git add -A && git commit -m "prep for release"
```

---

### 2. Release Prepare Fails: "branch already exists"

**Symptom:** Craft cannot create `release/X.Y.Z` branch.

**Cause:** Previous failed release left branch behind.

**Fix:**
```bash
# Delete the stale branch locally and remotely
git branch -D release/0.2.0
git push origin --delete release/0.2.0

# Re-run Release Prepare workflow
```

---

### 3. Publish Fails: NPM_TOKEN invalid

**Symptom:** CI publish step fails with `401 Unauthorized`.

**Cause:** `NPM_TOKEN` secret is expired or missing.

**Fix:**
1. Generate new token at https://www.npmjs.com/settings/tokens (type: **Automation**)
2. Update GitHub secret: Settings → Secrets → Actions → `NPM_TOKEN`
3. Re-run the workflow (or re-tag: `git tag -d v0.2.0 && git tag v0.2.0 && git push --force origin v0.2.0`)

---

### 4. Publish Fails: version already exists on npm

**Symptom:** `npm publish` fails with "cannot publish over existing version".

**Cause:** A package at that version was already published (possibly a partial failure).

**Fix:**
```bash
# Check which packages published
for pkg in protocol kernel workspace client cli hub; do
  echo -n "$pkg: "
  npm view @agentlip/$pkg version 2>/dev/null || echo "NOT PUBLISHED"
done

# Option A: Unpublish (within 72 hours only)
npm unpublish @agentlip/<pkg>@0.2.0

# Option B: Publish next patch version
# Re-run Release Prepare workflow with 0.2.1
```

---

### 5. Publish Fails: 403 Forbidden (OIDC)

**Symptom:** CI fails with `403 Forbidden` on OIDC publish step.

**Cause:** Trusted Publishing not configured for that package, or config mismatch.

**Fix:** See [npm-trusted-publishing.md](./npm-trusted-publishing.md) → Troubleshooting → "403 Forbidden during publish"

---

### 6. Changelog Missing Entries

**Symptom:** `CHANGELOG.md` has no content between releases.

**Cause:** There may be few/no meaningful commits since the last release, or Craft's autogenerated changelog content may be sparse for this repo.

**Fix:**
- Manually edit `CHANGELOG.md` in the release PR before merging (this repo uses Craft "simple" changelog policy; conventional commits are not required)
- If there truly were no changes, it's OK to keep the entry minimal (but keep the section present)

---

## Manual Recovery: Publish Without CI

If CI is completely broken:

```bash
# Ensure all package.json files are at the release version
for pkg in protocol kernel workspace client cli hub; do
  echo "$pkg: $(jq -r .version packages/$pkg/package.json)"
done

# Set npm token (token fallback path; provenance will not be emitted)
export NODE_AUTH_TOKEN="$NPM_TOKEN"

# Publish in dependency order
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

---

## Verification Checklist

- [ ] All 6 packages show new version on npmjs.org
- [ ] `npm view @agentlip/client version` returns new version
- [ ] Local smoke test passes (`bun add @agentlip/client@X.Y.Z` works)
- [ ] Tag `vX.Y.Z` exists: `git tag -l`

---

## Next Steps

- Announce release in relevant channels
- Close milestone/project board if applicable
- Update dependent projects to use new version
