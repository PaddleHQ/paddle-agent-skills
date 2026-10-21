---
name: paddle-onboarding
description: Check a Paddle account's onboarding status in sandbox or live — audit settings, credentials, notification destinations, catalog, domains, and verification, report what's done and missing against the go-live checklist, then fix the gaps the API allows with the user's approval.
---

# Check and complete Paddle account onboarding

## When to use this skill

Use this skill when the user wants to know where their Paddle account stands — "is my Paddle account ready to go live?", "what's left to set up?", "why can't I take live payments yet?" — or before switching an integration from sandbox to live. It audits account state through the Paddle API, reports each item as done, missing, or can't tell against the [go-live checklist](https://developer.paddle.com/build/go-live-checklist.md), and offers to fix the gaps the API can fix.

It checks account state, not code. Pair it with:

- `catalog-setup` when products or prices are missing.
- `checkout-web` and `webhooks` for the code that uses the client-side token, default payment link, and notification destination.
- `sandbox-testing` once sandbox setup is complete.

The code-side go-live steps — live IDs and `api.paddle.com`, removing the sandbox environment from Paddle.js, passing `pwCustomer`, allowlisting Paddle IPs — aren't visible to the API. If the user's codebase is open, check them against the checklist too; otherwise list them as can't tell.

## Before you start

- **Pick the environment.** Sandbox and live are separate, with separate settings, credentials, catalogs, and notification destinations — auditing one tells you nothing about the other. Use `paddle-sandbox` while the user is building and `paddle-live` when they're going live. If it's unclear, ask. When going live with both servers connected, read sandbox too: it's the reference for what live should mirror.
- **Read before you write.** Run the whole audit with reads only, report, then propose fixes one at a time. Never change anything during the audit.
- **Expect read-only live access.** `paddle-live` connected with OAuth starts with read access, so a live audit works straight away but live fixes need write permission. The Paddle CLI logged in to live with OAuth can write straight away. See [Permissions and `forbidden`](#permissions-and-forbidden).

## Choose your method

Pick the highest-ranked method that's available to you:

1. **Paddle MCP server** — if `search` and `execute` tools from `paddle-sandbox` or `paddle-live` are in your toolset, use them. **Always prefer this.**
2. **Paddle CLI** — if MCP isn't available but `paddle` is installed, run the audit with it yourself (see [With the CLI](#with-the-cli)).
3. **Direct API requests** — if neither is available but the user has a `PADDLE_API_KEY` in their environment, give them commands to run (see [With direct API requests](#with-direct-api-requests)). Never ask the user to paste an API key into the chat.
4. **Dashboard (manual)** — if none of these works, walk the user through the [go-live checklist](https://developer.paddle.com/build/go-live-checklist.md) and ask them to tell you what they see.

If the user doesn't have a Paddle MCP server installed, surface it as a suggestion — point them at the [Paddle MCP server install guide](https://developer.paddle.com/sdks/ai/paddle-mcp.md).

> The Paddle MCP exposes three tools per server (`search`, `execute`, `report_missing_tool`). Workflow: call `search` to confirm the exact method name and parameter shapes, then call `execute` with an async function that calls `client.<resource>.<operation>(...)`. **Method paths are camelCase** (`client.clientTokens.create`, `client.pricingPreview.preview`). **Body params and response fields are snake_case** (`tax_category`, `product_id`, `unit_price`, `currency_code`). List methods return `{ pagination: { hasMore, estimatedTotal }, <resource>: [...] }`, not `data`. The array's key is the resource's API path segment, so it's kebab-case where the method path is camelCase: `(await client.products.list()).products`, `(await client.clientTokens.list())["client-tokens"]`. Page with `{ after: "<last_id>" }` while `pagination.hasMore` is true, not `.next()`. Lists that aren't paginated, like `client.currencies.list()`, return a plain array. Single-entity methods return the entity. Chain multi-step workflows inside one `execute`; variables don't persist between calls. Hard caps: 50 API calls per execute, 30s timeout, and 32,000 characters of code.

> The Paddle CLI (`paddle`, v0.2.0 or later) runs Paddle API operations from the terminal with the user's saved login. Resource commands mirror the API reference: `paddle products create` is "create a product". Run `paddle <resource> --help` to find a command, add `--schema` to a create or update command to see its request body, and use `paddle api <path>` for an endpoint without a command. **It starts in the live account**, so pass `--environment sandbox` unless the user is working in live. When an agent runs it, it returns the API's JSON (`data`, `meta`), and `meta.environment` names the account it used. Cancel and delete commands need `--confirm <id>`. Add it only after the user has agreed to that specific cancel or delete, and never use it to work around a refusal. `paddle api` writes aren't checked at all, so treat them the same way. Exit code `5` is a `403`: a missing permission, or a login for the other account. Exit code `7` is a validation error. If `paddle whoami` shows no login, ask the user to run `paddle login` themselves (sandbox takes an API key: `paddle login --environment sandbox --api-key …`), and never ask for a key in the chat. A live login with OAuth can change anything the user's Paddle role allows, so name each live change and wait for a yes before you run it. For CI/CD, set a live API key with only the permissions it needs as `PADDLE_API_KEY`. To install it, see [Paddle CLI](https://developer.paddle.com/sdks/cli.md).

## Step 1: Audit the account (read-only)

Each check is one API read. Skip the live-only checks in sandbox: sandbox approves every domain automatically, and verification only applies to live accounts.

| Check                    | Operation (MCP method)                                                                  | Read permission              | Done when                                                                                                                                | Environment |
| ------------------------ | --------------------------------------------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| API access               | `GET /` (`client.apiRoot.get`)                                                          | —                            | `caller.account` isn't `null`. Note `api.environment` and `caller.permissions` for the report                                            | Both        |
| Account details          | `GET /account` (`client.account.get`)                                                   | `account.read`               | `legal_name` and `email` are set                                                                                                         | Both        |
| Catalog                  | `GET /products?status=active&include=prices` (`client.products.list`)                   | `product.read`, `price.read` | At least one active product has an active price                                                                                          | Both        |
| Client-side token        | `GET /client-tokens?status=active` (`client.clientTokens.list`)                         | `client_token.read`          | At least one active token                                                                                                                | Both        |
| Default payment link     | `GET /settings/checkout-url` (`client.settings.checkoutUrl.get`)                        | `checkout_settings.read`     | `default_url` isn't `null`. In live, it isn't `localhost` and its domain is approved                                                     | Both        |
| Payment methods          | `GET /settings/checkout-payment-methods` (`client.settings.checkoutPaymentMethods.get`) | `checkout_settings.read`     | The user confirms the methods offered — those with `enabled` and `available` both `true`                                                 | Both        |
| Sales tax                | `GET /settings/tax` (`client.settings.tax.get`)                                         | `tax_settings.read`          | `default_tax_mode` is set and the user confirms it                                                                                       | Both        |
| Balance currency         | `GET /settings/balance-currency` (`client.settings.balanceCurrency.get`)                | `balance_currency.read`      | The user confirms `preferred`                                                                                                            | Both        |
| Notification destination | `GET /notification-settings` (`client.notificationSettings.list`)                       | `notification_setting.read`  | At least one `active` `url` destination gets real events (`traffic_source` isn't `simulation`). In live, it's a public URL, not a tunnel | Both        |
| Website approval         | `GET /checkout-domains` (`client.checkoutDomains.list`)                                 | `checkout_domain.read`       | Every domain the user sells from is `approved`                                                                                           | Live only   |
| Verification             | `GET /verifications?verification_type=onboarding` (`client.verifications.list`)         | `verification.read`          | The `onboarding` verification's `status` is `completed`                                                                                  | Live only   |

Run them in one `execute`. Usually you let `execute` handle errors, but wrap each read here, as below, so one missing permission doesn't stop the rest of the audit. Keep each error message. Most start with the Paddle error code, like `not_found: …`. A missing permission starts `Not authorized:` and names the permission the method needs. If one read fails with a different authorization error while the others succeed, the key itself works: treat it as a missing permission for that read, and name the permission from the table above.

<!-- prettier-ignore -->
```js
async (client) => {
  const check = async (fn) => {
    try {
      return { ok: true, value: await fn() };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  };
  // List results hold their array next to `pagination`, keyed by resource name.
  const rows = (res) =>
    Array.isArray(res) ? res : (Object.values(res ?? {}).find(Array.isArray) ?? []);

  return {
    api_access: await check(async () => {
      const { api, caller } = await client.apiRoot.get();
      return {
        environment: api.environment,
        account: caller.account,
        permissions: caller.permissions,
      };
    }),
    account: await check(() => client.account.get()),
    catalog: await check(async () =>
      rows(await client.products.list({ status: ["active"], include: ["prices"] })).map((p) => ({
        id: p.id,
        name: p.name,
        active_prices: (p.prices ?? []).filter((pr) => pr.status === "active").length,
      })),
    ),
    client_tokens: await check(async () =>
      rows(await client.clientTokens.list({ status: ["active"] })).map(({ id, name }) => ({
        id,
        name,
      })),
    ),
    checkout_url: await check(() => client.settings.checkoutUrl.get()),
    payment_methods: await check(() => client.settings.checkoutPaymentMethods.get()),
    tax: await check(() => client.settings.tax.get()),
    balance_currency: await check(() => client.settings.balanceCurrency.get()),
    // Pick fields: never return endpoint_secret_key, the webhook signing secret.
    destinations: await check(async () =>
      rows(await client.notificationSettings.list()).map((d) => ({
        id: d.id,
        description: d.description,
        type: d.type,
        destination: d.destination,
        active: d.active,
        traffic_source: d.traffic_source,
        events: (d.subscribed_events ?? []).map((e) => e.name),
      })),
    ),
    // Live only — ignore these two in sandbox.
    checkout_domains: await check(async () =>
      rows(await client.checkoutDomains.list()).map(({ domain, status }) => ({ domain, status })),
    ),
    onboarding_verification: await check(async () =>
      rows(await client.verifications.list({ verification_type: "onboarding" })).map((v) => ({
        id: v.id,
        status: v.status,
        open_steps: (v.steps ?? [])
          .filter((s) => !["completed", "canceled"].includes(s.status))
          .map(({ key, status }) => ({ key, status })),
      })),
    ),
  };
}
```

Optional reads, not on the checklist and never go-live blockers (all need only `checkout_settings.read` or `statement_descriptor.read`):

- `GET /settings/statement-descriptor` (`client.settings.statementDescriptor.get`) — what customers see on their bank or card statement. A `statement_descriptor_not_found` error means none is set yet, not a failure.
- `GET /settings/checkout-features` (`client.settings.checkoutFeatures.get`) — discount codes, marketing consent, saved payment methods.
- `GET /settings/checkout-recovery` (`client.settings.checkoutRecovery.get`) — whether Paddle emails customers who abandon a checkout (`enabled`), and the discount that email offers (`discount`, or `null` for none). Report whether it's on; if it's off, mention it as an option rather than a gap. If the user wants it on, it's `PATCH /settings/checkout-recovery` with `{ enabled: true }` (`checkout_settings.write`) — ask first, like any other write.

Report the first two only if they're relevant — for example, the user has discounts but `discounts_enabled` is `false`.

### With the CLI

Run the same reads yourself, one command each, so a failed read doesn't stop the rest. Set `ENV` to the environment you're auditing. The `--jq` filter drops `endpoint_secret_key` so the signing secret doesn't end up in the output:

```bash
ENV=sandbox # live: production
p() {
  echo "== paddle $*"
  paddle --environment "$ENV" "$@" \
    --jq 'walk(if type == "object" then del(.endpoint_secret_key) else . end)'
}
p whoami
p account get
p products list --status active --include prices
p client-tokens list --status active
p settings checkout-url get
p settings checkout-payment-methods get
p settings tax get
p settings balance-currency get
p notification-settings list
p checkout-domains list
p verifications list --verification-type onboarding
```

`paddle whoami` covers the API access check: it shows the account and the login's permissions. A read that fails prints a JSON error with the Paddle error `code`, and exit code `5` means the login lacks that permission.

### With direct API requests

Give the user these reads to run with their own key. The `jq` filter drops `endpoint_secret_key` so the signing secret doesn't end up in the terminal or the chat:

```bash
BASE=https://sandbox-api.paddle.com # live: https://api.paddle.com
for path in / /account "/products?status=active&include=prices" \
  "/client-tokens?status=active" /settings/checkout-url /settings/checkout-payment-methods \
  /settings/tax /settings/balance-currency /notification-settings \
  /checkout-domains "/verifications?verification_type=onboarding"; do
  echo "== $path"
  curl -s "$BASE$path" -H "Authorization: Bearer $PADDLE_API_KEY" |
    jq 'walk(if type == "object" then del(.endpoint_secret_key) else . end)'
done
```

Ask them to share the output, then report as below. A `403` with `"code": "forbidden"` means the key lacks that permission.

### Reading the results

- **A failed read is can't tell, not missing.** If a check returns `ok: false`, or `search` doesn't return its method, report that item as can't tell with the error and any permission it names, and carry on.
- **Verification.** Only `status: completed` on the `onboarding` verification means the account is ready for live payments. `pending`, `in_progress`, and `in_review` mean Paddle is working on it. If the `account_setup` step isn't `completed`, the user still needs to complete account setup in the dashboard. If the verification has an `automated_review` step and it's `pending`, it may be waiting for a domain to be approved, so point to the website approval result. `action_required` means the account holder needs to do something in the dashboard — use `open_steps` to say which part is outstanding, but treat steps as context, not the verdict. `failed` means the user should check their email for details from Paddle. `canceled` means it won't continue, so send the user to Paddle support.
- **No onboarding verification.** Accounts created before April 2024 may not have one. Report can't tell and ask the user to confirm in the dashboard that their account is verified. Never treat an empty list as verified or as unverified.
- **Website approval.** Statuses are `pending_review`, `in_review`, `action_required`, `approved`, and `rejected`. In live, compare the host of `default_url` with the approved domains. If you can't tell whether the default payment link's domain is covered, say so and ask the user to check **Paddle > My account > Settings > Website approval**.
- **Account details.** These come from signup and verification. Only `email` can be changed through the API (`PATCH /account`, needs `account.write`); the legal name, display name, and website need Paddle support. Treat gaps here as part of verification. `display_name` and `website` are optional, so `null` isn't a gap. Approved checkout domains, not `website`, are what checkout needs. If `display_name` is `null`, mention that customers see it on invoices, receipts, and in the customer portal, and that Paddle support can set it.

## Step 2: Report

Report one row per check, grouped by checklist step, with a status of **Done**, **Missing**, or **Can't tell**. Link each row to its checklist step at `https://developer.paddle.com/build/go-live-checklist#<anchor>`:

| Item                                                                                  | Sandbox step                                                                   | Live step                                              |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------ |
| API access                                                                            | Before you begin (`#before-you-begin`)                                         | Set up your live account (`#set-up-your-live-account`) |
| Catalog                                                                               | Create your catalog (`#create-your-catalog`)                                   | Set up your live account                               |
| Client-side token, default payment link, payment methods, sales tax, balance currency | Build your pricing page and checkout (`#build-your-pricing-page-and-checkout`) | Set up your live account                               |
| Notification destination                                                              | Handle fulfillment and provisioning (`#handle-fulfillment-and-provisioning`)   | Set up your live account                               |
| Website approval, live API key, payouts, Retain dunning                               | —                                                                              | Set up your live account                               |
| Verification, account details                                                         | —                                                                              | Verify your account (`#verify-your-account`)           |

For example, in live:

| Status     | Item                 | What you found                                      | Checklist step                                                                                            |
| ---------- | -------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Done       | Catalog              | 2 active products, 4 active prices                  | [Set up your live account](https://developer.paddle.com/build/go-live-checklist#set-up-your-live-account) |
| Missing    | Default payment link | `default_url` is `null`                             | [Set up your live account](https://developer.paddle.com/build/go-live-checklist#set-up-your-live-account) |
| Missing    | Website approval     | `app.example.com` is `pending_review`               | [Set up your live account](https://developer.paddle.com/build/go-live-checklist#set-up-your-live-account) |
| Can't tell | Payouts              | Not available through the API — check the dashboard | [Set up your live account](https://developer.paddle.com/build/go-live-checklist#set-up-your-live-account) |
| Missing    | Verification         | `onboarding` verification is `action_required`      | [Verify your account](https://developer.paddle.com/build/go-live-checklist#verify-your-account)           |

End with the next step. When everything for the environment is done, point to [Test your integration](https://developer.paddle.com/build/go-live-checklist#test-your-integration) (and `sandbox-testing`) for sandbox, or [Test and go live](https://developer.paddle.com/build/go-live-checklist#test-and-go-live) for live.

## Step 3: Offer fixes the API allows

For each gap you can fix, name the operation, show the current and proposed values, and wait for a clear yes before writing. Make one change at a time, then re-read it and report the result. In live, say explicitly that you're about to change the live account.

Don't make business decisions for the user. Tax mode, balance currency, and payment methods change what customers pay or how the user gets paid — present the current value and the options, and let the user choose. When going live, offer to mirror the sandbox values, but ask first.

| Gap                      | Operation (MCP method)                                                                                                                             | Write permission             | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Default payment link     | `PATCH /settings/checkout-url` (`client.settings.checkoutUrl.update`) with `{ default_url }`                                                       | `checkout_settings.write`    | Must use `https`. In live, its host must be an approved domain, or that domain with `www.`, or the call fails with `checkout_url_domain_not_approved`; a subdomain needs its own approval. Sandbox doesn't need an approved domain. If a sandbox call returns that error, have the user add the domain under **Paddle > My account > Settings > Website approval**, where sandbox approves it straight away, then retry. Use the user's own domain, not `localhost`, in both environments, and in live use the real checkout page. The page must load Paddle.js, which reads `_ptxn` and opens checkout. |
| Payment methods          | `PATCH /settings/checkout-payment-methods` (`client.settings.checkoutPaymentMethods.update`) with `{ payment_methods: { <method>: { enabled } } }` | `checkout_settings.write`    | Send only the methods you're changing. Paddle controls `available`: enabling a method with `available: false` fails with `checkout_payment_method_not_available`, so check `available` first.                                                                                                                                                                                                                                                                                                                                                                                                            |
| Sales tax                | `PATCH /settings/tax` (`client.settings.tax.update`) with `{ default_tax_mode }`                                                                   | `tax_settings.write`         | `exclusive`, `inclusive`, or `location`. Applies to prices with `tax_mode: account_setting`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Balance currency         | `PATCH /settings/balance-currency` (`client.settings.balanceCurrency.update`) with `{ preferred }`                                                 | `balance_currency.write`     | Only `preferred` is writable; choose from `enabled`. `primary` follows either immediately or after the next payout.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Client-side token        | `POST /client-tokens` (`client.clientTokens.create`) with `{ name }`                                                                               | `client_token.write`         | Returns a `test_…` token in sandbox and a `live_…` token in live. Safe for frontend code; store it in an env var.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Notification destination | `POST /notification-settings` (`client.notificationSettings.create`) with `{ description, type: "url", destination, subscribed_events }`           | `notification_setting.write` | Only create one if none exists. Have the user store `endpoint_secret_key` in an env var without printing it. See `webhooks`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

Example — set the default payment link after the user has approved the value:

<!-- prettier-ignore -->
```js
async (client) => {
  const before = await client.settings.checkoutUrl.get();
  const after = await client.settings.checkoutUrl.update({
    default_url: "https://example.com/checkout",
  });
  return { before: before.default_url, after: after.default_url };
}
```

With the CLI, each fix is the matching `update` command with the same body, like `paddle settings checkout-url update --json '{"default_url": "https://example.com/checkout"}'`. Run `paddle settings checkout-url get` first and afterwards to show the before and after values.

If a write returns `forbidden` and the user doesn't want to grant the permission, or the method isn't available, send them to the dashboard instead:

- Default payment link and payment methods — **Paddle > Checkout > Checkout configuration**.
- Sales tax — **Paddle > My account > Settings > Sales tax**.
- Balance currency — **Paddle > My account > Settings > Currencies**.
- Client-side token — **Paddle > My account > Settings > Authentication**.
- Notification destination — **Paddle > Events > Notifications**.

## Step 4: Hand off dashboard-only steps

These have no public API. Give the user the dashboard location and the checklist link, then re-run the matching read to confirm where one exists.

- **Submit domains for website approval** (live) — **Paddle > My account > Settings > Website approval**. Before submitting, check that the site has public terms of service, privacy policy, and refund policy pages, prices that match the Paddle catalog, and a contact email or form reachable from the homepage, and that what it sells meets the [Paddle Acceptable Use Policy](https://www.paddle.com/help/start/intro-to-paddle/what-am-i-not-allowed-to-sell-on-paddle). Track progress with `GET /checkout-domains`.
- **Create an API key or change its permissions** — **Paddle > My account > Settings > Authentication**. A key is only visible once, so the user stores it in an env var straight away. You can't list API keys through the API, so a live API key for the user's server is can't tell unless their code is open.
- **Add payout details** (live) — **Paddle > Business account > Payouts > Payout settings**. Not visible to the API, so it's always can't tell.
- **Set dunning and recovery settings** (live) — **Paddle > Retain**. Not visible to the API.
- **Complete verification** (live) — an account administrator completes account setup under **Paddle > Get started**, which also shows what's needed when `status` is `action_required`. If the verification has an `automated_review` step, it stays `pending` until a domain is approved, so submit domains first. Re-check with `GET /verifications?verification_type=onboarding`. See [Verify your account](https://developer.paddle.com/build/go-live-checklist#verify-your-account).
- **Change the legal name, display name, or website** — contact Paddle support.

## Permissions and `forbidden`

The MCP server acts with the permissions of whatever it authenticated with. Through the MCP, a missing permission comes back as an error starting `Not authorized:` that names the permission; through the API, it's a `403` with the code `forbidden`. If a `Not authorized:` error names a field and says it isn't due to a missing permission, only Paddle can change that field, so don't ask the user to grant anything.

- **`paddle-sandbox`** authenticates with an API key. Ask the user to add the permission to the key under **Paddle > My account > Settings > Authentication**, or to create a key that has it.
- **`paddle-live`** connected with OAuth starts read-only, so a `forbidden` on a write is expected until the user grants write access under **Paddle > Connectors > MCPs**. Permissions there are capped by their Paddle user's role. If `paddle-live` uses a live API key instead, it works like sandbox.
- **The Paddle CLI** uses the user's saved login, and a missing permission is a `403` with exit code `5`. A sandbox login is an API key, so fix it like `paddle-sandbox`. A live login with OAuth has everything the user's Paddle role allows, including writes, so a live fix won't fail on permissions: the confirmation in [Step 3](#step-3-offer-fixes-the-api-allows) is the only check, so never skip it. A live login with an API key works like sandbox.
- **During the audit**, a `forbidden` read is can't tell, not missing. Name the permission in the report.
- **If the user won't grant a permission**, give them the dashboard location for that change instead (see [Step 3](#step-3-offer-fixes-the-api-allows)).

Fixes need `checkout_settings.write` (default payment link, payment methods), `tax_settings.write`, `balance_currency.write`, `client_token.write`, or `notification_setting.write`.

## Guardrails

- **Never delete, archive, revoke, or recreate live entities** — products, prices, discounts, client-side tokens, notification destinations, or checkout domains — and don't offer to as cleanup. Live entities may have real customers attached. Recreating a notification destination rotates its signing secret and breaks webhook verification. If a fix seems to need it, stop, name the entity and the change, and ask.
- **Leave sandbox alone while going live.** It's the reference for what live should look like.
- **Keep environments apart.** Changing a sandbox setting doesn't change live, and the reverse. Never copy sandbox-only values, like sandbox IDs or tokens, into live.
- **Never print, log, or commit secrets** — API keys or `endpoint_secret_key`. Client-side tokens are safe to expose but still belong in env vars.
- **Only call verification complete when the `onboarding` verification's `status` is `completed`.**

## Common pitfalls

- **Auditing the wrong environment.** Each MCP server only sees its own environment. If you're unsure which you're connected to, `GET /` returns `api.environment`.
- **Reading an empty verifications list as a verdict.** Older accounts may have no `onboarding` verification. Ask the user to confirm in the dashboard.
- **Using the first result of an unfiltered verifications list.** Results are newest first, so it's often a `domain` verification. Always filter by `verification_type=onboarding`.
- **Setting the live default payment link before the domain is approved.** The call fails with `checkout_url_domain_not_approved`. The user submits the domain in the dashboard first and you wait for `approved`.
- **Using `localhost` for the default payment link.** Live rejects it, the dashboard doesn't accept a host without a dot, and links in customer emails would point at `localhost`. Ask the user for a page on their own domain, in sandbox too. If `default_url` is already `https://localhost/`, live checkouts fail until it's changed.
- **Turning on a payment method that isn't available.** The update fails with `checkout_payment_method_not_available` while `available` is `false` — Paddle controls availability.
- **Expecting the balance currency to change straight away.** `preferred` changes immediately; `primary` can lag until the next payout.
- **Trusting the API root's status code as an auth check.** A request to `GET /` with no API key still gets a `200`, with `caller.account: null`. Check that `caller.account` isn't `null` rather than relying on the status code.

## Related docs

- [Go-live checklist](https://developer.paddle.com/build/go-live-checklist.md)
- [Settings API reference](https://developer.paddle.com/api-reference/settings.md)
- [Account API reference](https://developer.paddle.com/api-reference/account.md)
- [Verifications API reference](https://developer.paddle.com/api-reference/verifications.md)
- [Checkout domains API reference](https://developer.paddle.com/api-reference/checkout-domains.md)
- [API permissions](https://developer.paddle.com/api-reference/about/permissions.md)
- [Default payment link](https://developer.paddle.com/build/transactions/default-payment-link.md)
- [Paddle MCP server install guide](https://developer.paddle.com/sdks/ai/paddle-mcp.md)
