## Contributing

If you've spotted a problem with one of these skills or have a new feature request, please open an issue.

For help with the Paddle API or building your integration, contact our support team at [sellers@paddle.com](mailto:sellers@paddle.com).

## Repo layout

The repo ships one set of skills to four agent platforms (Claude Code, Codex, Cursor, Gemini CLI). To accommodate each platform's expected plugin shape, the layout is:

```
paddle-agent-skills/
├── skills/                             # SOURCE OF TRUTH for SKILL.md files
├── providers/
│   ├── claude/plugin/                  # Claude Code plugin
│   ├── cursor/plugin/                  # Cursor plugin
│   └── codex/plugin/                   # Codex plugin
├── gemini-extension.json               # Gemini CLI extension (MCP config; skills/ is auto-discovered)
├── .claude-plugin/marketplace.json     # → providers/claude/plugin/
├── .cursor-plugin/marketplace.json     # → providers/cursor/plugin/
├── .agents/plugins/marketplace.json    # → providers/codex/plugin/  (Codex)
└── scripts/sync-skills.mjs             # copies skills/ → providers/*/plugin/skills/
```

The marketplace files at the repo root point at the matching provider folder. Each provider folder contains the manifest and MCP config in the exact shape that platform expects:

- Claude Code: `.claude-plugin/plugin.json` + `.mcp.json` (with leading dot, auto-discovered)
- Cursor: `.cursor-plugin/plugin.json` + `mcp.json` (no leading dot, auto-discovered) + `rules/`
- Codex: `.codex-plugin/plugin.json` + `.mcp.json` + `assets/paddle-logo.svg`

## Submitting to the OpenAI plugin directory

The Codex plugin is also the package for the plugin directory that ChatGPT and Codex share. The listing, review test cases, and release notes live under `interface` and `extensions.com.openai` in [`providers/codex/plugin/.codex-plugin/plugin.json`](providers/codex/plugin/.codex-plugin/plugin.json). Only `paddle-live` is connected for review, and its OAuth settings are under its `extensions.com.openai.auth` entry in [`providers/codex/plugin/.mcp.json`](providers/codex/plugin/.mcp.json).

To build the ZIP for upload, run:

```sh
pnpm run pack:openai
```

This syncs the skills, then writes `dist/paddle-openai-plugin.zip` from the files tracked in `providers/codex/plugin/`. The ZIP's `.mcp.json` declares only `paddle-live`. The script needs the `zip` command.

Upload the ZIP at [platform.openai.com/plugins](https://platform.openai.com/plugins). Before you upload:

- Your OpenAI organization must be verified, and you need to be its owner or have the Apps Management Write role.
- The MCP server's domain must be verified by serving OpenAI's challenge token at `https://mcp.paddle.com/.well-known/openai-apps-challenge`.

Reviewer credentials go in the dashboard's review details form, never in the package. The demo video URL is required for review. Add it in the dashboard or as `review.demo_recording_url`.

When you change the listing, review metadata, or skills, bump `version` in `plugin.json` and upload a new ZIP. Changes to the MCP server's tools are picked up from the server without a new upload.

## Editing skills

Always edit files in [`skills/`](skills) at the repo root. Never edit the copies under `providers/*/plugin/skills/` — they're derived artifacts.

After editing anything in `skills/`, run the sync to refresh the provider copies:

```sh
pnpm run sync-skills
```

CI runs the same script and fails if the provider folders are out of sync — see [`.github/workflows/sync-check.yml`](.github/workflows/sync-check.yml).

## Naming convention for skills

Each skill has **two names** that intentionally differ:

| Where                         | Format              | Example               | Why                                                                                                                                                                                                                                                         |
| ----------------------------- | ------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Folder under `skills/`        | no `paddle-` prefix | `checkout-web/`       | The folder name becomes the [Claude Code plugin](https://docs.claude.com/en/docs/claude-code/plugins) skill namespace, e.g. `/paddle:checkout-web`. The `paddle:` prefix already comes from the plugin name.                                                |
| `SKILL.md` frontmatter `name` | `paddle-` prefixed  | `paddle-checkout-web` | The frontmatter name is what surfaces in the [developer.paddle.com skill listing](https://developer.paddle.com/sdks/ai/agent-skills) and the skills CLI install path. The `paddle-` prefix keeps the branding visible for users outside the plugin context. |

When we mirror to developer.paddle.com, each skill is published under its `paddle-` prefixed name, e.g. `/.well-known/skills/paddle-checkout-web/SKILL.md`, and listed by its frontmatter `name`.

When adding a new skill, follow the same pattern: `skills/<name>/SKILL.md` for the folder, `name: paddle-<name>` in the frontmatter. Then run `pnpm run sync-skills` to mirror it into each provider folder.
