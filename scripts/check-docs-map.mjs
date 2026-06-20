#!/usr/bin/env node

/**
 * Checks that the committed docs/docs_map.md is up to date.
 * Exits non-zero if the map is stale.
 *
 * Usage: node scripts/check-docs-map.mjs
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DOCS_DIR = join(process.cwd(), "docs");
const OUTPUT_FILE = join(DOCS_DIR, "docs_map.md");

if (!existsSync(OUTPUT_FILE)) {
  console.error("check-docs-map: docs/docs_map.md does not exist. Run `pnpm docs:map` first.");
  process.exit(1);
}

const current = readFileSync(OUTPUT_FILE, "utf8");

try {
  execFileSync("node", ["scripts/generate-docs-map.mjs"], {
    cwd: process.cwd(),
    stdio: "pipe",
  });
} catch (e) {
  console.error("check-docs-map: generator failed:", e.message);
  process.exit(1);
}

const updated = readFileSync(OUTPUT_FILE, "utf8");

// Restore original
writeFileSync(OUTPUT_FILE, current, "utf8");

if (current !== updated) {
  console.error("check-docs-map: docs/docs_map.md is stale. Run `pnpm docs:map` to regenerate.");
  process.exit(1);
}

console.log("check-docs-map: docs_map.md is up to date.");
