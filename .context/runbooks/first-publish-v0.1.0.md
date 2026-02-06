# Runbook: First Publish to npm (v0.1.0)

**Bead:** bd-2dw.9 — Claim @agentlip npm scope and first publish (manual)

---

## Pre-flight Checklist

- [ ] All 6 packages at version `0.1.0`:
  ```bash
  for pkg in protocol kernel workspace client cli hub; do
    echo "$pkg: $(jq -r .version packages/$pkg/package.json)"
  done
  # Expected: all show 0.1.0
  ```
- [ ] Typecheck passes: `bun run typecheck`
- [ ] Tests pass: `bun test`
- [ ] Workflow exists: `ls .github/workflows/publish.yml`

---

## Step 1: Claim the @agentlip npm Scope

```bash
# Login to npm (if not already)
npm login

# Option A: Create an npm organization (recommended for teams)
npm org create agentlip

# Option B: If using personal scope instead, skip this step
# Packages would be @<username>/protocol etc.
```

**Verify:** Visit https://www.npmjs.com/org/agentlip — org page should exist.

---

## Step 2: Create NPM_TOKEN (Automation Token)

1. Go to: https://www.npmjs.com/settings/tokens
2. Click **Generate New Token** → **Automation**
3. Token type: **Automation** (not Classic)
4. Expiration: Never (or choose policy-compliant duration)
5. **Copy the token immediately** — it's shown only once

**Security notes:**
- Automation tokens bypass 2FA on publish (required for CI)
- Store securely; never commit to git

---

## Step 3: Add NPM_TOKEN to GitHub Repository Secrets

1. Go to: `https://github.com/<owner>/agentlip/settings/secrets/actions`
2. Click **New repository secret**
3. Name: `NPM_TOKEN`
4. Value: paste the token from Step 2
5. Click **Add secret**

**Verify:** Secret appears in the list (value is hidden).

---

## Step 4: Commit, Tag, and Push

```bash
# Confirm working directory is clean (or stage changes)
git status

# If version bump was already done, just commit any pending changes
git add -A
git commit -m 'release: v0.1.0'

# Create annotated tag
git tag -a v0.1.0 -m 'Release v0.1.0 - initial npm publish'

# Push commit and tag
git push origin main
git push origin v0.1.0
```

---

## Step 5: Monitor CI Publish

1. Go to: `https://github.com/<owner>/agentlip/actions`
2. Watch the "Publish" workflow triggered by the `v0.1.0` tag
3. Expected duration: ~3-5 minutes
4. All steps should pass including the post-publish smoke test

**If workflow fails:** See Recovery section below.

---

## Step 6: Verify Packages on npmjs.org

```bash
# Check all 6 packages are published
for pkg in protocol kernel workspace client cli hub; do
  npm view @agentlip/$pkg version
done
# Expected: all return 0.1.0

# Check CLI package (unscoped)
npm view agentlip version
# Expected: 0.1.0
```

**Also verify visually:**
- https://www.npmjs.com/package/@agentlip/client
- https://www.npmjs.com/package/@agentlip/kernel
- https://www.npmjs.com/package/agentlip

---

## Step 7: Smoke Test (Local)

```bash
TEMP="$(mktemp -d)"
echo "Using temp dir: $TEMP"
cd "$TEMP"

# Init bun project
bun init -y

# Install client
bun add @agentlip/client@0.1.0

# Test import
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

# Cleanup
cd -
rm -rf "$TEMP"
```

---

## Verification Summary

| Check | Command | Expected |
|-------|---------|----------|
| Scope exists | Visit npmjs.com/org/agentlip | Org page visible |
| All packages published | `npm view @agentlip/client version` | `0.1.0` |
| CLI published | `npm view agentlip version` | `0.1.0` |
| Import works | Smoke test above | Functions defined |

---

## Recovery: CI Publish Failure

### Identify which packages published

```bash
for pkg in protocol kernel workspace client cli hub; do
  echo -n "$pkg: "
  npm view @agentlip/$pkg version 2>/dev/null || echo "NOT PUBLISHED"
done
```

### Resume manually from failed package

```bash
# Set token (don't echo it)
export NPM_TOKEN="npm_..."

# Configure npm auth
npm set //registry.npmjs.org/:_authToken=$NPM_TOKEN

# Publish remaining packages (example: client failed, need client + cli + hub)
cd packages/client && bun publish --access public --no-git-checks && cd ../..
sleep 5
cd packages/cli && bun publish --no-git-checks && cd ../..
sleep 5
cd packages/hub && bun publish --access public --no-git-checks && cd ../..
```

### Unpublish bad version (within 72 hours)

```bash
npm unpublish @agentlip/<pkg>@0.1.0
```

After 72 hours, you cannot unpublish. Publish a patch version instead.

---

## Post-Publish: Close Bead

```bash
br close bd-2dw.9 --reason="All 6 packages published to npm as v0.1.0. Verified via npm view and smoke test (bun add @agentlip/client, import createChannel works). CI workflow successful."
br sync --flush-only
git add .beads/
git commit -m 'close: bd-2dw.9 first npm publish complete'
```
