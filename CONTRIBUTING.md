## Contributing

If you've spotted a problem with one of these skills or have a new feature request, please open an issue.

For help with the Paddle API or building your integration, contact our support team at [sellers@paddle.com](mailto:sellers@paddle.com).

## Naming convention for skills

Each skill has **two names** that intentionally differ:

| Where                         | Format              | Example               | Why                                                                                                                                                                                                                                                         |
| ----------------------------- | ------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Folder under `skills/`        | no `paddle-` prefix | `checkout-web/`       | The folder name becomes the [Claude Code plugin](https://docs.claude.com/en/docs/claude-code/plugins) skill namespace, e.g. `/paddle:checkout-web`. The `paddle:` prefix already comes from the plugin name.                                                |
| `SKILL.md` frontmatter `name` | `paddle-` prefixed  | `paddle-checkout-web` | The frontmatter name is what surfaces in the [developer.paddle.com skill listing](https://developer.paddle.com/sdks/ai/agent-skills) and the skills CLI install path. The `paddle-` prefix keeps the branding visible for users outside the plugin context. |

When we mirror to developer.paddle.com, the folder name becomes the skill namespace, e.g. `/paddle:checkout-web`.

When adding a new skill, follow the same pattern: `skills/<name>/SKILL.md` for the folder, `name: paddle-<name>` in the frontmatter.
