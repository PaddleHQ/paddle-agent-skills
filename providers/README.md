# Providers

Each subdirectory here is the packaged plugin for one agent platform. They differ in shape because each platform expects its own manifest filename, MCP config filename, and supporting files:

| Provider    | Plugin root                         | Manifest                                                             | MCP config                           |
| ----------- | ----------------------------------- | -------------------------------------------------------------------- | ------------------------------------ |
| Claude Code | [`claude/plugin/`](./claude/plugin) | `.claude-plugin/plugin.json`                                         | `.mcp.json` (auto-discovered)        |
| Cursor      | [`cursor/plugin/`](./cursor/plugin) | `.cursor-plugin/plugin.json`                                         | `mcp.json` (no dot, auto-discovered) |
| Codex       | [`codex/plugin/`](./codex/plugin)   | `.codex-plugin/plugin.json` (richer manifest with `interface` block) | `.mcp.json` (referenced by manifest) |

Gemini CLI uses a single root-level [`gemini-extension.json`](../gemini-extension.json) instead. Gemini extensions install from the repo root, so there's no `providers/gemini/` folder.

## Skills are synced, not authored here

Don't edit skills here. The `skills/` directory inside each provider plugin is a derived copy of the top-level [`skills/`](../skills) directory. Edit only the top-level files, then run:

```sh
pnpm run sync-skills
```

CI verifies the copies stay in sync, see [`.github/workflows/sync-check.yml`](../.github/workflows/sync-check.yml).

Other per-provider files (manifest, MCP config, rules, assets) are hand-maintained per provider because each platform's contract differs slightly. For details, see [CONTRIBUTING.md](../CONTRIBUTING.md).
