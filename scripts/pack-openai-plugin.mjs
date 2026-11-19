#!/usr/bin/env node
// Builds the ZIP to upload to the OpenAI plugin directory from the Codex
// plugin in `providers/codex/plugin/`.
//
// The ZIP differs from the self-hosted Codex plugin in one way: its
// `.mcp.json` declares only `paddle-live`, the server connected for review.
// Only files tracked by git are packed.
//
// Requires the `zip` command (preinstalled on macOS and most Linux distros).
//
// Usage: node scripts/pack-openai-plugin.mjs

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const pluginDir = resolve(repoRoot, "providers/codex/plugin");
const outFile = resolve(repoRoot, "dist/paddle-openai-plugin.zip");
const reviewedServer = "paddle-live";

const tracked = execFileSync("git", ["ls-files", "-z", "--", relative(repoRoot, pluginDir)], {
  cwd: repoRoot,
  encoding: "utf8",
})
  .split("\0")
  .filter(Boolean);

if (tracked.length === 0) {
  console.error(`No tracked files in ${relative(repoRoot, pluginDir)}`);
  process.exit(1);
}

const stageDir = mkdtempSync(join(tmpdir(), "paddle-openai-plugin-"));

try {
  for (const file of tracked) {
    const dest = join(stageDir, relative(pluginDir, resolve(repoRoot, file)));
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(resolve(repoRoot, file), dest);
  }

  const mcpPath = join(stageDir, ".mcp.json");
  const mcp = JSON.parse(readFileSync(mcpPath, "utf8"));
  if (!mcp.mcpServers?.[reviewedServer]) {
    console.error(`${reviewedServer} not found in .mcp.json`);
    process.exit(1);
  }
  mcp.mcpServers = { [reviewedServer]: mcp.mcpServers[reviewedServer] };
  writeFileSync(mcpPath, JSON.stringify(mcp, null, 2) + "\n");

  mkdirSync(dirname(outFile), { recursive: true });
  rmSync(outFile, { force: true });
  execFileSync("zip", ["-qr", outFile, "."], { cwd: stageDir, stdio: "inherit" });

  console.log(`Packed ${tracked.length} file(s) → ${relative(repoRoot, outFile)}`);
} finally {
  rmSync(stageDir, { recursive: true, force: true });
}
