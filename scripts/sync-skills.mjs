#!/usr/bin/env node
// Copies SKILL.md files from the source-of-truth `skills/` directory
// into each provider's plugin folder. Run after editing anything under
// `skills/`. CI runs this and fails if the provider folders are out of sync
// (see .github/workflows/sync-check.yml).
//
// Usage: node scripts/sync-skills.mjs

import { cpSync, existsSync, readdirSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const sourceDir = resolve(repoRoot, "skills");
const targetDirs = [
  resolve(repoRoot, "providers/claude/plugin/skills"),
  resolve(repoRoot, "providers/cursor/plugin/skills"),
  resolve(repoRoot, "providers/codex/plugin/skills"),
];

if (!existsSync(sourceDir)) {
  console.error(`Source not found: ${sourceDir}`);
  process.exit(1);
}

const skillCount = readdirSync(sourceDir, { withFileTypes: true }).filter((d) =>
  d.isDirectory(),
).length;

for (const target of targetDirs) {
  rmSync(target, { recursive: true, force: true });
  cpSync(sourceDir, target, { recursive: true });
  console.log(`  Synced ${skillCount} skill(s) → ${target.replace(repoRoot + "/", "")}`);
}

console.log(`\nDone. Source: skills/ → ${targetDirs.length} provider folders.`);
