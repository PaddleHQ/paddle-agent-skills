# Paddle agent skills

[Paddle Billing](https://developer.paddle.com/?utm_source=dx&utm_medium=paddle-agent-skills) is the developer-first merchant of record, designed for modern SaaS, AI, mobile app, and digital product businesses. We take care of payments, tax, subscriptions, and metrics with one unified API that does it all.

This repo contains a collection of agent skills that help you implement Paddle in your product. Load them into Claude Code, Codex, Cursor, Gemini CLI, or any agentic coding tool that supports the skills format and your assistant gains step-by-step guidance for the most common Paddle integration tasks.

> **Important:** These skills are written for Paddle Billing. They don't cover Paddle Classic. If you're working with Paddle Classic, see the [Paddle Classic dev docs](https://classic.paddle.com/?utm_source=dx&utm_medium=paddle-agent-skills).

## What's included

Ten skills covering the most common Paddle integration tasks:

- **[`paddle-billing-history`](skills/billing-history/SKILL.md)** — show authenticated customers their past Paddle transactions with invoice download links.
- **[`paddle-catalog-setup`](skills/catalog-setup/SKILL.md)** — create the Paddle products and prices that other skills depend on.
- **[`paddle-checkout-web`](skills/checkout-web/SKILL.md)** — add a Paddle Checkout (overlay or inline) to a Next.js app, with event handling and customer pre-fill.
- **[`paddle-customer-portal`](skills/customer-portal/SKILL.md)** — mint authenticated customer portal sessions so users can self-serve subscriptions, payment methods, and invoices.
- **[`paddle-pricing-pages`](skills/pricing-pages/SKILL.md)** — render country-localized prices using `Paddle.PricePreview()`, with billing frequency toggle and currency formatting.
- **[`paddle-sandbox-testing`](skills/sandbox-testing/SKILL.md)** — exercise the integration end-to-end in the Paddle sandbox: test cards, webhook simulator, local tunnels.
- **[`paddle-subscription-cancel`](skills/subscription-cancel/SKILL.md)** — build a "cancel at end of period" flow with the right ownership checks and webhook reconciliation.
- **[`paddle-subscription-sync`](skills/subscription-sync/SKILL.md)** — mirror Paddle subscription and customer state into your database via webhooks.
- **[`paddle-subscription-update`](skills/subscription-update/SKILL.md)** — upgrade, downgrade, or change subscription items via the API with proration handling.
- **[`paddle-webhooks`](skills/webhooks/SKILL.md)** — receive and verify Paddle webhooks in a Next.js Route Handler, with idempotency and retry handling.

Each skill lives in its own directory under [`skills/`](skills) and ships with a `SKILL.md` containing the skill's frontmatter and instructions. The same skills are mirrored into each provider's plugin folder under [`providers/`](providers) by [`scripts/sync-skills.mjs`](scripts/sync-skills.mjs) — see [CONTRIBUTING.md](CONTRIBUTING.md) for the layout.

## Install as a Claude Code plugin

Inside [Claude Code](https://claude.com/claude-code), run:

```text
/plugin marketplace add PaddleHQ/paddle-agent-skills
/plugin install paddle@paddle-agent-skills
```

Then ask Claude something Paddle-shaped, like "help me verify a Paddle webhook in Next.js," and the relevant skill is selected automatically.

When you enable the plugin, Claude Code prompts for your Paddle sandbox API key and stores it securely in your keychain — no shell environment variables needed. The live MCP server authorizes with OAuth in your browser, so it needs no key. (Requires Claude Code v2.1.207 or later.)

To update later, run `/plugin marketplace update paddle-agent-skills`.

## Install as a Codex plugin

From your terminal, run:

```sh
codex plugin marketplace add PaddleHQ/paddle-agent-skills
```

Then install the `paddle` plugin from the Codex plugin directory.

## Install as a Cursor plugin

Cursor doesn't have a `/plugin install` style command yet, so install via the skills CLI (which adds skill files to your project) and the Cursor MCP deeplinks (which wire up the Paddle MCP servers).

```sh
pnpm dlx skills add https://developer.paddle.com/
```

See the [Cursor setup guide](https://developer.paddle.com/get-started/ai/cursor) for the MCP deeplinks and a Paddle rules file.

## Install as a Gemini CLI extension

From your terminal, run:

```sh
gemini extensions install PaddleHQ/paddle-agent-skills
```

Gemini auto-discovers the bundled [`skills/`](skills) directory at the extension root and wires up the docs and Paddle MCP servers via [`gemini-extension.json`](gemini-extension.json). Export `PADDLE_SANDBOX_API_KEY` for the sandbox server (see [Connect the Paddle MCP servers](#connect-the-paddle-mcp-servers)); the live server authorizes with OAuth.

## Connect the Paddle MCP servers

All of the plugins wire up the same three MCP servers. How you authenticate depends on the environment:

| MCP server       | URL                                  | Authentication                    |
| ---------------- | ------------------------------------ | --------------------------------- |
| `paddle-docs`    | `https://paddlehq.mcp.kapa.ai`       | _(none required)_                 |
| `paddle-sandbox` | `https://sandbox-mcp.paddle.com/mcp` | Sandbox API key                   |
| `paddle-live`    | `https://mcp.paddle.com/mcp`         | OAuth (authorize in your browser) |

You only need the environments you use. The skills default to sandbox unless you've explicitly opted into live, so the sandbox key is the one to set up first.

### Sandbox: set an API key

`paddle-sandbox` authenticates with a sandbox API key. Generate one at **Paddle > Developer tools > Authentication** in the [sandbox dashboard](https://sandbox-vendors.paddle.com/authentication-v2) (keys are prefixed `pdl_sdbx_`), granting the permissions you want the agent to use.

How you supply it depends on the tool:

- **Claude Code** — prompts you for the key when you enable the plugin and stores it in your OS keychain. No shell setup. (See [Install as a Claude Code plugin](#install-as-a-claude-code-plugin).)
- **Codex** and **Gemini CLI** — read the key from the process environment of whatever launches your editor. Set it in your shell profile:

  ```sh
  export PADDLE_SANDBOX_API_KEY=pdl_sdbx_...
  ```

  Restart your editor afterwards so the MCP server picks it up.

- **Cursor** — you paste the key into the install deeplink. (See the [Cursor setup guide](https://developer.paddle.com/get-started/ai/cursor).)

See [`.env.example`](./.env.example) for the full list of variables and inline guidance.

### Live: authorize with OAuth

`paddle-live` authorizes with OAuth, so there's no key to create or store. The first time your agent uses the server, your client opens a browser window to sign in to Paddle and approve access. Depending on the client you may need to trigger this manually — Claude Code and Gemini CLI use `/mcp`, Codex uses `codex mcp login paddle-live`.

An OAuth connection has whatever access your Paddle user's role permits. You can review, adjust, or revoke connections under **Paddle > Connectors > MCP**.

If a browser sign-in isn't practical (an automated environment, for example), `paddle-live` also accepts a live API key as a Bearer token. See the [Paddle MCP server docs](https://developer.paddle.com/sdks/ai/paddle-mcp) for that configuration.

### Picking the right MCP at runtime

With both servers connected, the agent sees two parallel toolsets. Be explicit in your prompts about which environment you mean. For example, "create a product in sandbox" routes to `paddle-sandbox`; "create the equivalent product in live" routes to `paddle-live`. Sandbox keys only authenticate against the sandbox URL, so a mismatch surfaces as an auth failure.

## Use the skills outside a plugin

Skills also work in any agentic tool that supports the agent-skills format. Use the [`skills` CLI](https://github.com/vercel-labs/agent-skills) to add them to your project:

```sh
pnpm dlx skills add https://developer.paddle.com/
```

You can also add skills manually by copying the contents of a skill's directory into your project's `.agent/skills/` directory, or a global `~/.agent/skills/` directory to share across projects.

## Contributing

Found a bug or want to suggest an improvement? See [CONTRIBUTING.md](CONTRIBUTING.md) and open an issue.

## Get help

For help with your Paddle integration, contact our support team at [sellers@paddle.com](mailto:sellers@paddle.com).

For feedback about Paddle's developer experience or these skills specifically, contact the Paddle DX team at [team-dx@paddle.com](mailto:team-dx@paddle.com).

## Learn more

- [Paddle developer docs](https://developer.paddle.com/?utm_source=dx&utm_medium=paddle-agent-skills)
- [Paddle agent skills](https://developer.paddle.com/sdks/ai/agent-skills?utm_source=dx&utm_medium=paddle-agent-skills)
- [Paddle docs MCP server](https://developer.paddle.com/sdks/ai/docs-mcp?utm_source=dx&utm_medium=paddle-agent-skills)
- [Paddle MCP server](https://developer.paddle.com/sdks/ai/paddle-mcp?utm_source=dx&utm_medium=paddle-agent-skills)
- [Sign up for Paddle Billing](https://login.paddle.com/signup?utm_source=dx&utm_medium=paddle-agent-skills)
