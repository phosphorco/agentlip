# Runbook: Local Registry Testing

**Use case:** Test package publishing and installation flow locally before releasing to npm.

**Audience:** Developers verifying publish scripts or debugging package issues.

---

## Prerequisites

- [ ] Docker installed and running: `docker info`
- [ ] `docker-compose` or `docker compose` available
- [ ] Bun installed: `bun --version`
- [ ] Repository at root: `cd /path/to/agentlip`

---

## Step 1: Start the Local Registry

```bash
./scripts/local-registry-up.sh
```

**What happens:**
- Starts Verdaccio registry via Docker Compose (`dev/verdaccio/docker-compose.yml`)
- Registry runs at `http://127.0.0.1:4873`
- Waits for health check (timeout: 30s)
- Data persists in Docker volumes (`agentlip-verdaccio-storage`, `agentlip-verdaccio-plugins`) until you run `./scripts/local-registry-down.sh --clean`

**Expected output:**
```
[registry-up] Starting Verdaccio registry...
[registry-up] Registry is healthy!

  REGISTRY_URL=http://127.0.0.1:4873

[registry-up] To stop the registry:
  ./scripts/local-registry-down.sh
```

---

## Step 2: Authenticate to Local Registry

**First time only:**

```bash
npm adduser --registry http://127.0.0.1:4873
```

**Prompts:**
- Username: (anything, e.g., `testuser`)
- Password: (anything, e.g., `testpass`)
- Email: (anything, e.g., `test@example.com`)

**Note:** Credentials persist in the Verdaccio storage volume (`/verdaccio/storage/htpasswd` inside the container) until you run `./scripts/local-registry-down.sh --clean`.

---

## Step 3: Bump Version (Optional for Testing)

If you want to test with a version that doesn't conflict with production:

```bash
./scripts/bump-version.sh 0.2.0-test.1
```

**Note:** This updates all 6 `package.json` files. You can revert with:
```bash
git checkout -- packages/*/package.json
```

---

## Step 4: Publish to Local Registry

```bash
./scripts/publish-local.sh 0.2.0-test.1 --registry http://127.0.0.1:4873
```

**What happens:**
- Validates version is semver
- Verifies registry is localhost-only (safety guard)
- Checks all package versions match `0.2.0-test.1`
- Publishes in dependency order: `protocol` → `kernel` → `workspace` → `client` → `cli` → `hub`

**Expected output:**
```
Publishing Agentlip packages to http://127.0.0.1:4873
Target version: 0.2.0-test.1

Pre-flight: verifying package versions...
✓ packages/protocol/package.json is at 0.2.0-test.1
✓ packages/kernel/package.json is at 0.2.0-test.1
...

→ Publishing protocol...
✓ protocol published successfully
...

✓ Successfully published 6 package(s) to http://127.0.0.1:4873
```

---

## Step 5: Smoke Test Installation

```bash
./scripts/smoke-install-from-registry.sh 0.2.0-test.1 --registry http://127.0.0.1:4873
```

**What happens:**
- Creates a temp directory
- Initializes a Bun project (`bun init -y`)
- Installs `@agentlip/client@0.2.0-test.1` from local registry
- Verifies import works: `import { createChannel } from "@agentlip/client"`
- Cleans up temp directory on exit (even on failure)

**Expected output:**
```
Smoke testing @agentlip/client@0.2.0-test.1 from http://127.0.0.1:4873
Temp directory: /var/folders/.../agentlip-smoke-XXXXXX

→ Initializing Bun project...
→ Installing @agentlip/client@0.2.0-test.1...
→ Verifying TypeScript imports...
✓ Import verified: createChannel is a function

✓ Smoke test passed: @agentlip/client@0.2.0-test.1 works correctly
```

---

## Step 6: Clean Up

```bash
# Stop registry (keeps data/users)
./scripts/local-registry-down.sh

# Stop registry and delete all data/users
./scripts/local-registry-down.sh --clean
```

**Note:** Running `--clean` means you'll need to `npm adduser` again next time.

---

## Troubleshooting

### 1. Registry Health Check Times Out

**Symptom:**
```
[registry-up] Still waiting... (30s / 30s)
[registry-up] Registry failed to become healthy after 30s
```

**Cause:** Docker daemon not running, or port 4873 already in use.

**Fix:**
```bash
# Check Docker is running
docker info

# Check if port 4873 is already bound
lsof -i :4873

# If something else is using 4873, kill it or change registry port in:
# dev/verdaccio/docker-compose.yml
```

---

### 2. Publish Fails: Authentication Error

**Symptom:**
```
✗ protocol failed to publish (exit code 1)

If you see an authentication error, run:
  npm adduser --registry http://127.0.0.1:4873
```

**Cause:** You haven't authenticated to the local registry.

**Fix:**
```bash
npm adduser --registry http://127.0.0.1:4873
# Enter any username/password/email

# Re-run publish
./scripts/publish-local.sh 0.2.0-test.1 --registry http://127.0.0.1:4873
```

---

### 3. Publish Fails: Version Mismatch

**Symptom:**
```
Error: 2 package(s) have version mismatches
Run scripts/bump-version.sh 0.2.0-test.1 to fix versions.
```

**Cause:** Not all package.json files are at the requested version.

**Fix:**
```bash
./scripts/bump-version.sh 0.2.0-test.1

# Re-run publish
./scripts/publish-local.sh 0.2.0-test.1 --registry http://127.0.0.1:4873
```

---

### 4. Smoke Test Fails: Package Not Found

**Symptom:**
```
✗ Failed to install @agentlip/client@0.2.0-test.1 from http://127.0.0.1:4873
```

**Cause:** Publish failed, or wrong version specified.

**Fix:**
```bash
# Verify package exists in local registry
curl http://127.0.0.1:4873/@agentlip/client

# Check published versions
npm view @agentlip/client versions --registry http://127.0.0.1:4873
```

---

### 5. Smoke Test Fails: Import Verification

**Symptom:**
```
Error: createChannel is not a function
✗ Import verification failed
```

**Cause:** Package exports are broken (bad `package.json` or `index.ts`).

**Fix:**
- Check `packages/client/package.json` → `"exports"` field
- Check `packages/client/src/index.ts` → ensure `createChannel` is exported
- Rebuild and re-publish

---

## Advanced: Testing Dependency Resolution

Test that packages correctly depend on each other:

```bash
# Publish all packages
./scripts/publish-local.sh 0.2.0-test.1 --registry http://127.0.0.1:4873

# Install @agentlip/hub (which depends on kernel, protocol, workspace)
TEMP=$(mktemp -d)
cd "$TEMP"
bun init -y
bun add @agentlip/hub@0.2.0-test.1 --registry http://127.0.0.1:4873

# Check that dependencies resolved correctly
bun pm ls --depth=1
# Expected: @agentlip/kernel, @agentlip/protocol, @agentlip/workspace installed

rm -rf "$TEMP"
```

---

## Full Workflow Example

```bash
# 1. Start registry
./scripts/local-registry-up.sh

# 2. Authenticate (first time only)
npm adduser --registry http://127.0.0.1:4873

# 3. Bump to test version
./scripts/bump-version.sh 0.2.0-test.1

# 4. Publish all packages
./scripts/publish-local.sh 0.2.0-test.1 --registry http://127.0.0.1:4873

# 5. Smoke test
./scripts/smoke-install-from-registry.sh 0.2.0-test.1 --registry http://127.0.0.1:4873

# 6. Revert version changes
git checkout -- packages/*/package.json

# 7. Stop registry (keep data)
./scripts/local-registry-down.sh
```

---

## Verification Checklist

- [ ] Registry starts and health check passes
- [ ] `npm adduser` creates credentials
- [ ] All 6 packages publish successfully
- [ ] Smoke test installs and verifies imports
- [ ] Registry stops cleanly (`docker-compose ps` shows nothing)

---

## When to Use

- **Before first npm publish:** Test the publish flow end-to-end
- **After changing package.json exports:** Verify imports resolve correctly
- **When debugging dependency issues:** Test inter-package dependencies
- **Before CI changes:** Validate publish script changes locally
