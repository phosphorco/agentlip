# npm Publish Setup for Agentlip

> Learnings relevant to future gates should be written back to respective gates, so future collaborators can benefit.

## Goal and Motivation

Make all 6 `@agentlip/*` packages installable from npmjs.org so external agents and developers can `bun add @agentlip/client` or `bunx agentlip init`. The project is Bun-only (no Node compat) — that's acceptable; we declare `engines` and ship `.ts` source directly.

## Scope

**Delivers:**
- All 6 packages configured for npm publishing (metadata, files, engines, license)
- MIT LICENSE file at repo root
- `files` arrays excluding tests/dev artifacts from published tarballs
- `bun publish` working from repo root for all packages (resolves `workspace:*` → real versions)
- GitHub Actions workflow: publish all packages on version tag push (`v*`)
- npm scope `@agentlip` claimed (manual step documented)

**Excludes:**
- Node.js compatibility or build step (ships .ts, requires Bun)
- Changesets / automated version bumping (manual for now)
- Per-package independent versioning (all packages share one version, bumped in lockstep)

## Codebase Context

| Area | Path | Notes |
|---|---|---|
| Root package.json | `package.json` | `private: true`, workspaces config |
| Protocol | `packages/protocol/package.json` | Zero deps, types + constants only |
| Kernel | `packages/kernel/package.json` | `bun:sqlite`, ships migrations/ |
| Workspace | `packages/workspace/package.json` | Pure TS (node:fs/path/os only) |
| Client | `packages/client/package.json` | SDK — no `bun:` imports in source (only tests) |
| CLI | `packages/cli/package.json` | Binary: `agentlip`, deps on workspace+kernel |
| Hub | `packages/hub/package.json` | Binary: `agentlipd`, Bun.serve, deps on protocol+workspace+kernel |
| CI | `.github/workflows/ci.yml` | Existing: typecheck + test matrix (FTS on/off) |
| Migrations | `migrations/*.sql` → `packages/kernel/migrations/` | Currently at root; Gate 1 moves to kernel |
| tsconfig | `tsconfig.json` | `noEmit`, `moduleResolution: Bundler` |

---

## Gate 1 — Package metadata and LICENSE

Add publishing metadata to all 6 `packages/*/package.json`:

- Remove `"private": true` from each
- Set `version` to `"0.1.0"` across all 6
- Add `engines: { "bun": ">=1.0.0" }` (even for protocol/workspace/client which have no `bun:` imports in source — the overall project is Bun-only and deps like kernel require Bun)
  - **Note:** npm does not enforce `engines` by default. Users who install on Node will get cryptic TypeScript/import errors. Add a runtime guard in CLI/Hub binaries (first lines after shebang):
    ```ts
    if (typeof Bun === "undefined") {
      console.error("Error: @agentlip/cli requires Bun runtime (https://bun.sh)");
      process.exit(1);
    }
    ```
  - Library packages (protocol, kernel, workspace, client) should NOT add runtime guards — let consumers handle Bun detection
- Add `license: "MIT"`
- Add `repository`, `description`, `homepage` fields
- Add `files` arrays scoped to published content (with negation patterns to exclude tests):
  - Protocol: `["src/", "!src/**/*.test.ts"]`
  - Kernel: `["src/", "migrations/", "!src/**/*.test.ts"]` (after moving migrations/ into kernel)
  - Workspace: `["src/", "!src/**/*.test.ts"]`
  - Client: `["src/", "!src/**/*.test.ts"]`
  - CLI: `["src/", "!src/**/*.test.ts"]`
  - Hub: `["src/", "!src/**/*.test.ts", "!src/integrationHarness.ts"]`
- Additionally exclude from all packages: `verify.ts`, `*.edge.test.ts` (add patterns if these exist in src/)

Create `LICENSE` at repo root (MIT, copyright holder: Phosphor).

**Kernel migration path concern:** `"../migrations/"` in `files` won't work — npm packs relative to the package dir and won't include parent paths. Options:
- Move `migrations/` into `packages/kernel/migrations/` and update the code path in kernel
- Copy migrations into kernel at publish time
- Symlink

Best option: move `migrations/` into `packages/kernel/migrations/` since kernel is the only consumer.

**Required code changes after migration move:**
1. `packages/kernel/src/index.ts` — export the migrations directory path:
   ```ts
   import { join } from "node:path";
   export const MIGRATIONS_DIR = join(import.meta.dir, "../migrations");
   ```
2. `packages/hub/src/index.ts:373` — import and use kernel's exported path:
   ```ts
   import { MIGRATIONS_DIR as KERNEL_MIGRATIONS_DIR } from "@agentlip/kernel";
   // ...
   const effectiveMigrationsDir = migrationsDir ?? KERNEL_MIGRATIONS_DIR;
   ```
3. Update all test files referencing `"../../../migrations"` to use `KERNEL_MIGRATIONS_DIR`:
   - `packages/hub/src/integrationHarness.ts:17`
   - `packages/hub/src/linkifierDerived.test.ts:41`
   - `packages/hub/src/extractorDerived.test.ts:34-35`
   - `packages/hub/src/crash-safety.test.ts:21`
   - `packages/hub/src/derivedStaleness.test.ts:29`
   - `packages/hub/src/wsEndpoint.test.ts:22`

Note: `import.meta.resolve()` returns a URL string, not a file path — do NOT use it for path resolution.

**Post-migration: regenerate bun.lock.** After moving `migrations/` into `packages/kernel/`, run `bun install` to update `bun.lock`. Commit the lock file change with the migration move.

**Exclude common artifacts from tarballs.** The `files` array is an allowlist, but create a root `.npmignore` as defense-in-depth (applies to all packages):
```
.DS_Store
*.swp
*.swo
.idea/
.vscode/
*.log
```

**Acceptance:**
- Each package's `npm pack --dry-run` (or `bun pm pack --dry-run`) lists only intended files
- No `.DS_Store` or editor artifacts in tarballs (verify with `tar -tzf <tarball>`)
- `bun run typecheck` still passes
- `bun test` still passes
- `LICENSE` exists at repo root
- `bun.lock` is regenerated and committed after migrations move

## Gate 2 — Fix workspace:* resolution and verify publishability

`bun publish` resolves `workspace:*` → pinned versions automatically. Verify this works:

1. Run `bun publish --dry-run` from each package dir — confirm it resolves deps and produces valid tarballs
2. Verify binary shebangs: `packages/cli/src/agentlip.ts` and `packages/hub/src/agentlipd.ts` must have `#!/usr/bin/env bun` as first line (npm preserves shebangs and sets executable bit on install)
3. Verify `exports` fields are correct for .ts source shipping:
   - Each package's `exports["."]` should point to `"./src/index.ts"`
   - Hub's additional exports:
     - `"./agentlipd"` → keep; allows programmatic import of the daemon entrypoint (bin field provides CLI usage)
     - `"./test-harness"` → REMOVE (dev-only, not shipped)

**Hub exports cleanup:** The `"./test-harness"` export in `packages/hub/package.json` points to `./src/integrationHarness.ts` which is dev-only and excluded from `files` (Gate 1). Remove `"./test-harness"` from `exports` — leaving a dangling export causes confusing errors for consumers.

**Verify workspace:* resolution explicitly.** After dry-run publish, extract and inspect a tarball:
```bash
cd packages/client && bun publish --dry-run 2>&1 | head -20
# Extract the tarball
tar -xzf *.tgz
cat package/package.json | grep -A5 '"dependencies"'
# Confirm: "@agentlip/protocol": "0.1.0", NOT "workspace:*"
rm -rf package *.tgz
```

**Acceptance:**
- `bun publish --dry-run` succeeds for all 6 packages
- Extracted tarballs show resolved versions (e.g., `"@agentlip/protocol": "0.1.0"`), NOT `workspace:*`
- Binary shebangs present: `head -1 packages/cli/src/agentlip.ts` outputs `#!/usr/bin/env bun`
- Hub's `"./test-harness"` export removed from package.json

## Gate 3 — GitHub Actions publish workflow

Create `.github/workflows/publish.yml`:

- Trigger: push of tags matching `v*` (e.g., `v0.1.0`)
- Steps:
  1. Checkout
  2. Setup Bun (matching CI version)
  3. Install deps
  4. Typecheck
  5. Test (fast matrix — FTS disabled only, for speed)
  6. Publish all 6 packages in dependency order: protocol → kernel → workspace → client → cli → hub
- Uses `NPM_TOKEN` repository secret for auth:
  - Create token with minimal scope: `Automation` type, `publish` permission only
  - Set as repository secret (not environment secret) to limit exposure to Actions
  - Configure via `npm set //registry.npmjs.org/:_authToken=$NPM_TOKEN` or `NODE_AUTH_TOKEN` env var
- Each publish step: `cd packages/<name> && bun publish --access public`
- **Security:** Never echo or log the token; use `--quiet` flag if bun publish supports it
- Add a manual version-bump script: `scripts/bump-version.sh <version>` that updates all 6 package.json files + root

**Dependency order matters** because npm needs the deps to exist before dependents reference them. Protocol and kernel have no `@agentlip/*` deps, so they go first.

Publish order:
1. `protocol` (no @agentlip deps)
2. `kernel` (no @agentlip deps)
3. `workspace` (no @agentlip deps)
4. `client` (deps: protocol, workspace)
5. `cli` (deps: workspace, kernel)
6. `hub` (deps: protocol, workspace, kernel)

**Failure mode: partial publish state.** If package N fails after packages 1..(N-1) succeeded, the registry is in an inconsistent state. Mitigations:
- On failure, the workflow fails and a maintainer must manually resume. Document recovery: run `bun publish` for failed + remaining packages locally, or re-tag
- Each publish step should use `continue-on-error: false` (the default) so subsequent steps don't run on failure

**Failure mode: npm eventual consistency.** Even after `bun publish` succeeds, npm CDN may take seconds to propagate. A dependent publish immediately after may fail to resolve the dep.
- Add `sleep 5` after each `bun publish` to mitigate (simple, sufficient for our low publish frequency)

**Failure mode: version drift.** Maintainer might bump only some packages.
- Add a pre-publish version-consistency check step in the workflow:
  ```bash
  # Verify all packages have the same version as the git tag
  VERSION="${GITHUB_REF_NAME#v}"
  for pkg in protocol kernel workspace client cli hub; do
    PKG_VERSION=$(jq -r .version packages/$pkg/package.json)
    if [ "$PKG_VERSION" != "$VERSION" ]; then
      echo "Version mismatch: packages/$pkg has $PKG_VERSION, expected $VERSION"
      exit 1
    fi
  done
  ```
  Run this check after typecheck, before publishing.

**Recovery procedure: partial publish failure.** Document in README's Publishing section:
1. Identify which packages succeeded (check npmjs.org or `npm view @agentlip/<pkg> version`)
2. For each failed/remaining package, run locally: `cd packages/<pkg> && NPM_TOKEN=... bun publish --access public`
3. If a bad version was published (broken code), you have 72 hours to unpublish: `npm unpublish @agentlip/<pkg>@<version>`
4. After 72 hours, a bad version cannot be unpublished — publish a patch version instead

**Post-publish smoke test in workflow.** After all 6 packages publish, add a verification step:
```bash
# Wait for npm CDN propagation
sleep 30
# Create temp dir, install client, verify import works
TEMP=$(mktemp -d)
cd "$TEMP"
bun init -y
bun add @agentlip/client@${VERSION}
echo 'import { createChannel } from "@agentlip/client"; console.log(typeof createChannel)' > test.ts
bun run test.ts | grep -q 'function' || exit 1
rm -rf "$TEMP"
```
This catches broken exports or missing files before users encounter them.

**Acceptance:**
- Workflow file passes `act` dry-run or manual review
- `scripts/bump-version.sh 0.1.0` updates all 6 package.json versions
- Pre-publish version check fails if any package version doesn't match the tag
- Post-publish smoke test verifies the published packages are installable
- Manual tag push triggers the workflow (verified after npm scope is claimed)

## Gate 4 — Claim scope and first publish

Manual steps (documented in README, not automated):

1. Create npm org or claim scope: `npm login && npm org create agentlip` (or use user scope `@<username>/`)
   - **Scope squatting risk:** Claim `@agentlip` before announcing the project publicly
   - If using org scope, add team members with minimal roles (only maintainers need publish access)
2. Set `NPM_TOKEN` in GitHub repo secrets
3. Bump version: `./scripts/bump-version.sh 0.1.0`
4. Commit, tag, push: `git tag v0.1.0 && git push --tags`
5. Verify: all 6 packages appear on npmjs.org
6. Smoke test: `bun add @agentlip/client` in a fresh project, import and check types

Add a "Publishing" section to README.md documenting the release process.

**Acceptance:**
- All 6 packages live on npmjs.org under `@agentlip/`
- `bun add @agentlip/client` works in a fresh Bun project
- README documents the release workflow
