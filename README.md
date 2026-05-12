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

The fastest way to use these skills inside [Claude Code](https://claude.com/claude-code) is to install them as a plugin. The plugin also wires up the [Paddle docs MCP server](https://developer.paddle.com/sdks/ai/docs-mcp), so the agent can pull from the latest Paddle docs while it works.

Inside Claude Code, run:

```text
/plugin marketplace add PaddleHQ/paddle-agent-skills
/plugin install paddle@paddle-agent-skills
```

Then ask Claude something Paddle-shaped, like "help me verify a Paddle webhook in Next.js," and the relevant skill is selected automatically.

To update later, run `/plugin marketplace update paddle-agent-skills`.

## Use the skills outside Claude Code

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
- [Sign up for Paddle Billing](https://login.paddle.com/signup?utm_source=dx&utm_medium=paddle-agent-skills)
