---
name: paddle-sandbox-testing
description: Test a Paddle integration end-to-end using the sandbox environment, test cards, the webhook simulator, and local tunnels — without taking real money.
---

# Test a Paddle integration in the sandbox

## When to use this skill

Use this skill when verifying a Paddle integration before going live — running real-looking checkouts, triggering webhook events, and exercising subscription state changes without taking real money. Covers sandbox configuration, test card numbers, the webhook simulator (single events and scenarios), local development with public tunnels, and the differences between sandbox and live behavior that bite people in production.

This skill is the safety net for everything else. Apply it alongside `checkout-web`, `webhooks`, and `subscription-sync` whenever you ship — sandbox testing is the cheapest way to catch integration bugs.

## Sandbox vs production at a glance

Paddle gives you two completely separate environments:

|                               | **Sandbox**                           | **Production**             |
| ----------------------------- | ------------------------------------- | -------------------------- |
| Purpose                       | Development and testing               | Real customers, real money |
| API base                      | `sandbox-api.paddle.com`              | `api.paddle.com`           |
| Dashboard                     | `sandbox-vendors.paddle.com`          | `vendors.paddle.com`       |
| API keys                      | Separate set                          | Separate set               |
| Client tokens                 | Separate set                          | Separate set               |
| Notification destinations     | Separate set                          | Separate set               |
| Products / prices / customers | Separate (none synced)                | —                          |
| Cards accepted                | Test cards only (real cards rejected) | Real cards                 |
| Refunds                       | Approved automatically (~10 minutes)  | Most reviewed by Paddle    |
| Tax                           | Calculated but not collected          | Real tax handling          |
| Domain approval               | No approval required (any domain)     | Manual approval per domain |

**Nothing crosses between them.** A sandbox `pri_01h...` does not exist in production. Notification destinations are separate. Customers are separate. This is intentional — it makes "test in sandbox, then promote to live" the safe default.

## Step 1: Configure sandbox

Sign up for the sandbox at [sandbox-login.paddle.com/signup](https://sandbox-login.paddle.com/signup) (separate signup from production). Then:

1. Set up at least one **product** with one **price** — see `catalog-setup` if you haven't done this yet.
2. Go to **Paddle > My account > Settings > Authentication** and create:
   - A **client-side token** (on the **Client-side tokens** tab) for use in `Paddle.js`.
   - A **server-side API key** (on the **API keys** tab) for the Node SDK. Give it the permissions this skill's API and MCP calls use: `notification_simulation.write` and `notification_simulation.read` (simulator), `notification.read` and `notification.write` (notification logs and replays), and `client_token.write` if you create client-side tokens by API.
3. Set a **default payment link** in **Paddle > Checkout > Checkout configuration** — the page that opens your checkout. In sandbox, a `localhost` URL is fine.
4. Note the IDs and set them in your local env:

```bash
# .env.local — sandbox values
NEXT_PUBLIC_PADDLE_ENV=sandbox
NEXT_PUBLIC_PADDLE_CLIENT_TOKEN=test_...
PADDLE_API_KEY=pdl_sdbx_apikey_...
PADDLE_NOTIFICATION_WEBHOOK_SECRET=pdl_ntfset_...
```

The `PADDLE_API_KEY` for sandbox is prefixed `pdl_sdbx_apikey_` — production keys are prefixed `pdl_live_apikey_`. Glance at the prefix anytime you're not sure which environment you're hitting.

## Step 2: Use test cards

In sandbox, **only test cards work**. Real cards are rejected. The standard test card:

```
Card number: 4242 4242 4242 4242
Expiry:      any future month/year
CVC:         any 3 digits
ZIP/Postal:  any value
Name:        any value
```

Other test cards trigger specific scenarios:

| Card number           | Result                                                 |
| --------------------- | ------------------------------------------------------ |
| `4242 4242 4242 4242` | Valid card without 3DS                                 |
| `4000 0038 0000 0446` | Valid card with 3DS                                    |
| `4000 0566 5566 5556` | Valid Visa debit card                                  |
| `4000 0000 0000 0002` | Declined card                                          |
| `4000 0027 6000 3184` | Initial success, subsequent renewals decline (dunning) |

Full list at [developer.paddle.com/sdks/sandbox#test-cards](https://developer.paddle.com/sdks/sandbox#test-cards). Use the failure cards to confirm your `checkout.payment.failed` handling (it fires on each failed payment attempt), dunning flow, and `subscription.past_due` handling work end-to-end. `checkout.payment.error` is different: it means no payment methods are available.

## Step 3: The webhook simulator

The simulator sends **fake-but-correctly-signed** webhook events to one of your notification destinations without going through a real flow. Simulated events don't change any real data in your account. Two modes:

**Single event.** Pick one event type (e.g. `subscription.canceled`) — the simulation `type` is the event name. Edit the JSON payload or let Paddle fill in a demo example, then run it. Paddle signs it with the destination's secret and POSTs it to the destination's URL. Use this to test specific handlers in isolation — e.g. "what does my UI do when `subscription.paused` arrives?"

**Scenario.** A pre-defined sequence of events that mirrors a real flow:

| Scenario `type`             | Events (default options)                                                                                                                                                                                                                                                         |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subscription_creation`     | `transaction.created`, `customer.created`, `address.created`, `transaction.ready`, `transaction.paid`, `subscription.created`, `subscription.activated` (or `subscription.trialing`), `transaction.completed`, `payment_method.saved` — with `transaction.updated` between steps |
| `subscription_renewal`      | `subscription.updated`, `transaction.created`, `transaction.billed`, `transaction.updated`, `transaction.paid`, `transaction.updated`, `transaction.completed`                                                                                                                   |
| `subscription_pause`        | `subscription.updated`, `subscription.paused`                                                                                                                                                                                                                                    |
| `subscription_resume`       | `subscription.updated`, `subscription.resumed`, `transaction.created`, `transaction.billed`, then the same payment events as a renewal                                                                                                                                           |
| `subscription_cancellation` | `subscription.updated`, `subscription.canceled`                                                                                                                                                                                                                                  |

Options change the sequence. Pause and cancellation default to `effective_from: "immediately"`; `"next_billing_period"` adds a `subscription.updated` with `scheduled_change` first. Renewal and resume take a `payment_outcome` — `"failed"` swaps the payment events for `transaction.payment_failed`, `transaction.past_due` and `subscription.past_due`. Add real sandbox entities (e.g. a `subscription_id`) to fill payloads with their details; the entities themselves aren't changed, but the API key needs read permission for them (e.g. `subscription.read`).

Find the simulator at **Paddle > Events > Simulations**. If a Paddle MCP server is available to you, you can drive the simulator programmatically inside one `execute` call instead of using the dashboard — create the simulation, then create a run against it:

```js
async (client) => {
  const sim = await client.simulations.create({
    name: "Subscription created flow",
    type: "subscription_creation",
    // Required: the destination that receives the simulated events.
    notification_setting_id: "ntfset_...",
  });
  const run = await client.simulations.runs.create(sim.id);
  return { simulation_id: sim.id, run_id: run.id };
};
```

Note `client.simulations.runs.create` is nested under `simulations` (not a top-level `client.simulationRuns`), and the simulation ID is a positional path param. Scenario options go in `config`, keyed by the scenario type — e.g. `config: { subscription_cancellation: { entities: { subscription_id: "sub_..." }, options: { effective_from: "next_billing_period" } } }`.

> The Paddle MCP exposes three tools per server (`search`, `execute`, `report_missing_tool`). Workflow: call `search` to confirm the exact method name and parameter shapes, then call `execute` with an async function that calls `client.<resource>.<operation>(...)`. **Method paths are camelCase** (`client.clientTokens.create`, `client.pricingPreview.preview`). **Body params and response fields are snake_case** (`tax_category`, `product_id`, `unit_price`, `currency_code`). List methods return `{ pagination: { hasMore, estimatedTotal }, <resource>: [...] }`, not `data`. The array's key is the resource's API path segment, so it's kebab-case where the method path is camelCase: `(await client.products.list()).products`, `(await client.clientTokens.list())["client-tokens"]`. Page with `{ after: "<last_id>" }` while `pagination.hasMore` is true, not `.next()`. Lists that aren't paginated, like `client.currencies.list()`, return a plain array. Single-entity methods return the entity. Chain multi-step workflows inside one `execute`; variables don't persist between calls. Hard caps: 50 API calls per execute, 30s timeout, and 32,000 characters of code.

To use the simulator:

1. In the dashboard, go to **Paddle > Events > Simulations**.
2. Pick a scenario or single event.
3. Choose the notification destination to send to. You pick an existing destination rather than typing a URL, so point that destination at your tunnelled local URL or a deployed preview URL first.
4. (Optional) For a single event, edit the payload JSON to use specific IDs (e.g. a `customer_id` you've already created in your DB). For a scenario, add real sandbox entities.
5. (Optional) Configure your simulation (e.g. set the payment outcome to `failed` to simulate a failed payment).
6. Run it. Watch your local server logs.

The destination must have **Usage type** "Simulation" or "Both" (`traffic_source: "simulation"` or `"all"`) — "Platform" destinations can't be used. It must also be active and subscribed to each event type in the simulation; any event it can't receive is marked `aborted` and not sent. A "Simulation" destination gets no real events, so use "Both" for a local destination you also use for real checkouts.

Each simulated event gets **one delivery attempt, with no retries**. Check results on the run in **Paddle > Events > Simulations**, or with `client.simulations.runsEvents.list(simulationId, runId)` — each event has a `status` (`success`, `failed`, `aborted`, `pending`) plus the request and response. Resend one with `client.simulations.runsEvents.replay(simulationId, runId, eventId)`.

The signature on a simulated event uses the **destination's secret**, so your normal verification code works without changes. If verification fails, the secret you've set in `PADDLE_NOTIFICATION_WEBHOOK_SECRET` doesn't match the destination you're simulating against.

## Step 4: Tunnel localhost for real events

The simulator covers most testing. For real flows (e.g. completing an actual sandbox checkout to verify the full chain), Paddle needs to reach your local machine. Use a tunnel:

**Hookdeck** (recommended):

```bash
# Install: brew install hookdeck
hookdeck listen 3000 paddle --path /api/webhook
# Copy the source URL it prints ("Requests to → https://...")
```

`paddle` is the Hookdeck source name and `--path` is your webhook route. Point a sandbox notification destination at the source URL, with Usage type "Both" so it gets real and simulated events. The source URL stays the same when you restart the CLI, so you only set it once. Hookdeck keeps your event history between sessions, so if events arrived while the CLI was stopped, replay them from Hookdeck or Paddle.

**Debug delivery.** For real events, open the notification in **Paddle > Events > Notifications**, or use `client.notifications.logs.list("ntf_...")` to see each delivery attempt and `client.notifications.replay("ntf_...")` to send it again. For simulated events, check the simulation run's events (see Step 3).

## Step 5: A typical end-to-end test

Here's the loop for verifying a fresh integration:

1. **Tunnel** localhost: `hookdeck listen 3000 paddle --path /api/webhook`.
2. **Point the sandbox destination** at the tunnel's source URL (once — it doesn't change between restarts).
3. **Open** your pricing page → click Subscribe.
4. **Pay** with `4242 4242 4242 4242`.
5. **Confirm**:
   - Browser lands on your `successUrl`.
   - Server logs show all events
   - Your DB has the new customer and subscription rows (if you've wired `subscription-sync`).
   - The dashboard shows the transaction under **Transactions**.
6. **Cancel** the subscription, one of two ways:
   - **Real:** cancel the sandbox subscription you just created, using the API or the customer portal (see `subscription-cancel`).
   - **Simulated:** run a `subscription_cancellation` simulation with that subscription's ID in `entities.subscription_id` and `effective_from: "next_billing_period"`. This only sends events whose payloads use the subscription's details — the real subscription stays active, so your DB and Paddle will disagree afterwards.
7. **Confirm**:
   - Real, `effective_from: "next_billing_period"`: a `subscription.updated` event arrives with `scheduled_change.action: "cancel"` and status still `active`. `subscription.canceled` only arrives when the billing period ends.
   - Real, `effective_from: "immediately"`: a `subscription.canceled` event arrives with status `canceled`; your row should flip to `canceled`.
   - Simulated: a `subscription.updated` with `scheduled_change`, then `subscription.updated` and `subscription.canceled` with status `canceled`, all in the same run.

## Sandbox vs live: differences that may catch you out

These behave differently in sandbox and live.

| **Behavior**                      | **Sandbox**                                                                                                                      | **Live**                                                                                                                                                                                | **Why it matters**                                                                                                                                        |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Adjustments (refunds/credits)** | Refunds are created `pending_approval` and approved automatically within about 10 minutes. Credits are `approved` straight away. | Most refunds stay `pending_approval` until Paddle reviews them. Credits are `approved` straight away.                                                                                   | Don't treat a refund as done on `adjustment.created` — handle `adjustment.updated` moving `status` from `pending_approval` to `approved` (or `rejected`). |
| **Webhook retries**               | 3 retries within 15 minutes                                                                                                      | 60 retries within 3 days                                                                                                                                                                | A failing sandbox handler stops being retried after 15 minutes — fix it, then replay the event.                                                           |
| **Payouts**                       | No payouts                                                                                                                       | Real money to your bank                                                                                                                                                                 | Test payout webhook handling against simulated payouts only.                                                                                              |
| **Domain approval**               | Not needed — domains are approved automatically, and `localhost` works                                                           | Approve each domain in **Paddle > My account > Settings > Website approval**. Your default payment link (**Paddle > Checkout > Checkout configuration**) must be on an approved domain. | Forgetting domain approval means production checkout fails to load.                                                                                       |
| **Checkout "test mode" flag**     | Shown on checkouts                                                                                                               | Not shown                                                                                                                                                                               | A quick visual check of which environment a checkout is using.                                                                                            |
| **Dunning (Retain)**              | Not available                                                                                                                    | Available                                                                                                                                                                               | Retain handles canceling or pausing past due subscriptions.                                                                                               |
| **Email delivery**                | Only sent to addresses on your account email's domain. Emails to other addresses go to your account email instead.               | Sent to the email on the customer record (real)                                                                                                                                         | You receive the emails for every test customer, so check your own inbox.                                                                                  |

## Common pitfalls

- **Mixing sandbox and live keys.** Always confirm `PADDLE_API_KEY` and `NEXT_PUBLIC_PADDLE_ENV` are for the correct environment.
- **Sandbox environment param in production.** Always confirm the environment parameter is set to `production` when initializing Paddle.js in production.
- **Tunnel URL changed after a restart.** Tunnels that hand out a new URL each time (e.g. a free ngrok URL) need the destination URL updated after every restart. Symptoms: events fire on Paddle's side but never reach your code. A Hookdeck source URL stays the same.
- **Simulated events marked `aborted`.** The destination's Usage type isn't "Simulation" or "Both", it's inactive, or it isn't subscribed to that event type.
- **Testing with a real card "just to be sure"**. Sandbox rejects them. Production accepts them and charges them.
- **Not testing the failure path.** Use `4000 0000 0000 0002` to confirm `checkout.payment.failed` handling, then use the simulator to test a failed subscription renewal (`payment_outcome: "failed"`).
- **Using the same notification destination secret in code for both environments.** They are not the same. Each environment, each destination, has its own secret.
- **Testing only the happy path.** Real users may hit weird states — declined cards, expired trials, immediate cancellations. Use the simulator to fire each edge case and watch your code respond.

## Related docs

- [Sandbox overview](https://developer.paddle.com/sdks/sandbox.md)
- [Test cards](https://developer.paddle.com/sdks/sandbox.md#test-cards)
- [Test webhooks with the simulator](https://developer.paddle.com/webhooks/simulator/test-webhooks.md)
- [Simulator scenarios reference](https://developer.paddle.com/webhooks/simulator.md)
- [Go-live checklist](https://developer.paddle.com/build/go-live-checklist.md)
- [API authentication](https://developer.paddle.com/api-reference/about/authentication.md)
