# Paddle agent skills

[Paddle Billing](https://developer.paddle.com/?utm_source=dx&utm_medium=paddle-agent-skills) is the developer-first merchant of record, designed for modern SaaS, AI, mobile app, and digital product businesses. We take care of payments, tax, subscriptions, and metrics with one unified API that does it all.

This repo contains a collection of agent skills that help you implement Paddle in your product. Load them into Claude Code, Cursor, or any agentic coding tool that supports the skills format and your assistant gains step-by-step guidance for the most common Paddle integration tasks.

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

Each skill lives in its own directory under [`skills/`](skills) and ships with a `SKILL.md` containing the skill's frontmatter and instructions.

## Install as a Claude Code plugin

The fastest way to use these skills inside [Claude Code](https://claude.com/claude-code) is to install them as a plugin. The plugin also wires up the [Paddle docs MCP server](https://developer.paddle.com/sdks/ai/docs-mcp) and [Paddle MCP servers](https://developer.paddle.com/sdks/ai/paddle-mcp).

Inside Claude Code, run:

```text
/plugin marketplace add PaddleHQ/paddle-agent-skills
/plugin install paddle@paddle-agent-skills
```

Then ask Claude something Paddle-shaped, like "help me verify a Paddle webhook in Next.js," and the relevant skill is selected automatically.

To update later, run `/plugin marketplace update paddle-agent-skills`.

### Connect the Paddle MCP servers

The plugin also wires up the [Paddle MCP server](https://developer.paddle.com/sdks/ai/paddle-mcp), which lets the agent call the Paddle API directly to do things like create products and prices, mint client-side tokens, and simulate webhooks. Several skills (`paddle-catalog-setup`, `paddle-checkout-web`, `paddle-sandbox-testing`, `paddle-subscription-sync`, `paddle-webhooks`) lean on it.

Paddle has an endpoint for each environment and the plugin wires both, so the agent can work in either or port state from one to the other (for example, recreating a sandbox catalog in live).

| MCP server | URL | API key env var |
| --- | --- | --- |
| `paddle-live` | `https://mcp.paddle.com/mcp` | `PADDLE_LIVE_API_KEY` |
| `paddle-sandbox` | `https://sandbox-mcp.paddle.com/mcp` | `PADDLE_SANDBOX_API_KEY` |

You only need to set the key(s) for the environment(s) you use. The unset one will fail to authenticate at editor startup and Claude Code logs the failure but otherwise carries on. The skills default to sandbox unless you've explicitly opted into live, so `PADDLE_SANDBOX_API_KEY` is the one to start with during development.

#### 1. Get a Paddle API key

Generate keys at **Paddle > Developer tools > Authentication**:

- Sandbox: [sandbox dashboard](https://sandbox-vendors.paddle.com/authentication-v2) (keys prefixed `pdl_sdbx_`)
- Live: [live dashboard](https://vendors.paddle.com/authentication-v2)

Grant the permissions you want the agent to use.

#### 2. Export the keys in your shell

The plugin reads the keys from the process environment of whatever launches your editor. Set them in your shell profile:

```sh
export PADDLE_SANDBOX_API_KEY=pdl_sdbx_...
export PADDLE_LIVE_API_KEY=...  # only if you also want the live MCP
```

See [`.env.example`](./.env.example) for the full list of variables and inline guidance.

> Restart your editor after setting the variables so the MCP servers pick them up.

#### Picking the right MCP at runtime

With both servers connected, the agent sees two parallel toolsets. Be explicit in your prompts about which environment you mean. For example, "create a product in sandbox" routes to `paddle-sandbox`; "create the equivalent product in live" routes to `paddle-live`. Sandbox keys only authenticate against the sandbox URL and live keys only against the live URL, so a mismatch surfaces as an auth failure.

## Install as a Codex plugin

If you're using [Codex](https://developers.openai.com/codex), you can install the plugin from the Codex plugin directory. As with the Claude Code plugin, it also wires up the [docs MCP server](https://developer.paddle.com/sdks/ai/docs-mcp) and [Paddle MCP servers](https://developer.paddle.com/sdks/ai/paddle-mcp).

From your terminal, run:

```sh
codex plugin marketplace add PaddleHQ/paddle-agent-skills
```

Then install the `paddle` plugin from the Codex plugin directory.

After, follow the instructions in the [Connect the Paddle MCP servers](#connect-the-paddle-mcp-servers) section above to set up the Paddle MCP servers.

## Use the skills outside Claude Code or Codex

Skills also work in any agentic tool that supports the agent-skills format. Use the [`skills` CLI](https://github.com/vercel-labs/agent-skills) to add them to your project:

```sh
pnpm dlx skills add https://developer.paddle.com/
```

```sh
npx skills add https://developer.paddle.com/
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
