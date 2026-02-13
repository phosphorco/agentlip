#!/usr/bin/env bun
/**
 * CI stale-check for hub-ui embedded assets.
 * 
 * Regenerates uiAssets.generated.ts and fails if it changed.
 * This ensures commits include fresh generated assets.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "../../..");
const GENERATED_FILE = "packages/hub/src/uiAssets.generated.ts";

function main(): void {
  console.log("Checking if hub-ui assets are stale...");
  console.log("");

  const generatedPath = join(REPO_ROOT, GENERATED_FILE);
  if (!existsSync(generatedPath)) {
    console.error("❌ STALE ASSETS DETECTED");
    console.error("");
    console.error(`${GENERATED_FILE} is missing.`);
    console.error("");
    console.error("To fix:");
    console.error("  1. Run: bun run --cwd packages/hub ui:embed");
    console.error("  2. Commit the generated file");
    process.exit(1);
  }

  // Capture current state
  const beforeHash = getFileHash(GENERATED_FILE);
  console.log(`Before: ${GENERATED_FILE} hash = ${beforeHash.slice(0, 12)}...`);

  // Regenerate
  console.log("");
  console.log("Regenerating assets...");
  execSync("bun run --cwd packages/hub ui:embed", {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });

  // Check if changed
  const afterHash = getFileHash(GENERATED_FILE);
  console.log("");
  console.log(`After:  ${GENERATED_FILE} hash = ${afterHash.slice(0, 12)}...`);

  if (beforeHash !== afterHash) {
    console.error("");
    console.error("❌ STALE ASSETS DETECTED");
    console.error("");
    console.error(`${GENERATED_FILE} changed after regeneration.`);
    console.error("");
    console.error("To fix:");
    console.error("  1. Run: bun run --cwd packages/hub ui:embed");
    console.error("  2. Commit the updated file");
    console.error("");
    process.exit(1);
  }

  console.log("");
  console.log("✓ Assets are fresh");
}

/**
 * Get SHA-256 hash of a file.
 */
function getFileHash(path: string): string {
  const fullPath = join(REPO_ROOT, path);
  const content = readFileSync(fullPath);
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(content);
  return hasher.digest("hex");
}

main();
