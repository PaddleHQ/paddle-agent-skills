---
name: paddle-webhooks
description: Receive and verify Paddle webhooks in a Next.js Route Handler — signature verification, idempotency, retry semantics, and local testing.
---

# Receive Paddle webhooks securely in Next.js

## When to use this skill

Use this skill when building the server-side endpoint that receives Paddle webhook events (subscription changes, transactions, customer updates, payouts, etc.). It covers creating the notification destination in Paddle, writing a Next.js Route Handler that verifies signatures and processes events, handling retries and idempotency, and local testing.

This skill is the foundation for almost every server-side Paddle integration. Pair with:

- `subscription-sync` — turn webhook events into rows in your database.
- `sandbox-testing` — drive your endpoint with the webhook simulator.
- `checkout-web` — the client-side counterpart that triggers the events you'll receive here.

## The delivery contract

Every design choice in this skill follows from these facts about how Paddle delivers webhooks. Read this section first; everything else is mechanics.

- **Only `2xx` within 5 seconds is "delivered."** Any other response — `400`, `401`, `500`, `503`, a redirect, a connection timeout — is treated as a failed delivery and gets retried. There is no status code that means "stop retrying" on the integrator side. Paddle retries any non-2xx response.
- **Retry schedule.** Paddle retries on an exponential backoff schedule. Sandbox: 3 attempts in total, all within about two minutes. Live: up to 60 attempts in total over about two days. Connection timeouts count toward the same budget as non-2xx responses. Don't make your handler depend on exact retry timing.
- **Same `event.eventId` on every retry.** Paddle re-sends the identical payload (modulo a fresh signature timestamp) until you 2xx or the retry budget is exhausted. That id is your dedup key.
- **No ordering guarantee.** A retry or replay can arrive after a newer event. Store `event.occurredAt` and only apply an event that's newer than the last one you applied (Step 5).
- **No redirect following.** A `301` or `302` is treated as a failed delivery, not followed.
- **Failed notifications can be replayed for about 90 days.** Once retries run out, the notification is marked `failed`. Replay it from **Paddle > Events > Notifications** (open the destination, then **Retry** on the notification), or via the Paddle MCP server with `client.notifications.replay("ntf_…")` inside an `execute` call (the notification ID is a positional path param, not a body field). A replay creates a new notification ID for the same event ID and gets one attempt. Events are kept for 90 days: after extended downtime, list what you missed with `GET /events` and its `from`/`to` filters, or query the API for current state.

> The Paddle MCP exposes three tools per server (`search`, `execute`, `report_missing_tool`). Workflow: call `search` to confirm the exact method name and parameter shapes, then call `execute` with an async function that calls `client.<resource>.<operation>(...)`. **Method paths are camelCase** (`client.clientTokens.create`, `client.pricingPreview.preview`). **Body params and response fields are snake_case** (`tax_category`, `product_id`, `unit_price`, `currency_code`). List methods return `{ pagination: { hasMore, estimatedTotal }, <resource>: [...] }`, not `data`. The array's key is the resource's API path segment, so it's kebab-case where the method path is camelCase: `(await client.products.list()).products`, `(await client.clientTokens.list())["client-tokens"]`. Page with `{ after: "<last_id>" }` while `pagination.hasMore` is true, not `.next()`. Lists that aren't paginated, like `client.currencies.list()`, return a plain array. Single-entity methods return the entity. Chain multi-step workflows inside one `execute`; variables don't persist between calls. Hard caps: 50 API calls per execute, 30s timeout, and 32,000 characters of code.

> The Paddle CLI (`paddle`, v0.2.0 or later) runs Paddle API operations from the terminal with the user's saved login. Resource commands mirror the API reference: `paddle products create` is "create a product". Run `paddle <resource> --help` to find a command, add `--schema` to a create or update command to see its request body, and use `paddle api <path>` for an endpoint without a command. **It starts in the live account**, so pass `--environment sandbox` unless the user is working in live. When an agent runs it, it returns the API's JSON (`data`, `meta`), and `meta.environment` names the account it used. Cancel and delete commands need `--confirm <id>`. Add it only after the user has agreed to that specific cancel or delete, and never use it to work around a refusal. `paddle api` writes aren't checked at all, so treat them the same way. Exit code `5` is a `403`: a missing permission, or a login for the other account. Exit code `7` is a validation error. If `paddle whoami` shows no login, ask the user to run `paddle login` themselves (sandbox takes an API key: `paddle login --environment sandbox --api-key …`), and never ask for a key in the chat. A live login with OAuth can change anything the user's Paddle role allows, so name each live change and wait for a yes before you run it. For CI/CD, set a live API key with only the permissions it needs as `PADDLE_API_KEY`. To install it, see [Paddle CLI](https://developer.paddle.com/sdks/cli.md).

## Prerequisites

You need:

- A Paddle account with a configured product and price (sandbox is fine for development) — see `catalog-setup` if you don't have one yet.
- A publicly reachable URL for your dev environment if you want real Paddle events to hit local code (see "Local testing" below).
- Three environment variables:

```bash
NEXT_PUBLIC_PADDLE_ENV=sandbox             # or "production"
PADDLE_API_KEY=pdl_sdbx_apikey_...         # server-side; never expose to the browser
PADDLE_NOTIFICATION_WEBHOOK_SECRET=pdl_ntfset_...  # secret for THIS notification destination
```

Verifying webhooks doesn't call the API, so the route handler needs no API key permissions. Managing webhooks through the API or the Paddle MCP does: `notification_setting.write` to create or update destinations (`notification_setting.read` to list them or read a secret), `notification.read` for notifications, logs and events, `notification.write` to replay, and `notification_simulation.write` to run simulations (`notification_simulation.read` to check results). Create API keys under **Paddle > My account > Settings > Authentication**.

Install the server SDK:

```bash
npm install @paddle/paddle-node-sdk
```

## Step 1: Create a notification destination

A notification destination tells Paddle "send these events to this URL." Each destination has its own secret — sandbox and production should be separate destinations with separate secrets, never shared.

1. In the Paddle dashboard, go to **Paddle > Events > Notifications**.
2. Click **New destination**.
3. Set:
   - **Notification type**: `Webhook`.
   - **URL**: your endpoint (e.g. `https://your-app.com/api/webhook` or your tunnelled local URL).
   - **Description**: `Local dev` (or `Production`).
   - **Usage type**: `Both` for a dev destination, so it receives real sandbox events and simulator events. `Platform` (real events only) suits production.
   - **Events**: select the events you need. Start with `transaction.completed`, `subscription.created`, `subscription.updated`, `subscription.canceled`, `customer.created`, `customer.updated`. You can subscribe to more later.
4. Save, then copy the destination's **Secret key** into `PADDLE_NOTIFICATION_WEBHOOK_SECRET`. You can copy it again later from the destination's edit view, or read it as `endpoint_secret_key` from `GET /notification-settings/{id}`.

When your tunnel URL changes, edit the existing destination's URL rather than creating a new destination, so the secret stays the same.

If a Paddle MCP server is available to you, create the destination inside an `execute` call instead of using the dashboard (camelCase resource, snake_case body; see conventions above):

```js
async (client) =>
  client.notificationSettings.create({
    description: "Local dev", // required
    destination: "https://abc123.ngrok.app/api/webhook",
    type: "url",
    subscribed_events: ["transaction.completed", "subscription.created", "subscription.updated"],
    traffic_source: "all", // also receive simulator events; defaults to "platform"
  });
```

The response includes `endpoint_secret_key`. A 409 `notification_setting_cannot_be_duplicate` means a destination with that URL already exists: find it in `(await client.notificationSettings.list())["notification-settings"]` and reuse it, or change it with `client.notificationSettings.update("ntfset_…", { ... })`, instead of creating another. A 400 `notification_maximum_active_settings_reached` means the account has reached its limit of active destinations: reuse one of the user's own destinations, or ask them which one to deactivate.

With the Paddle CLI, send the same body to `paddle notification-settings create`. Append the secret straight to `.env.local` so it isn't printed in the terminal or the chat:

```bash
paddle --environment sandbox notification-settings create \
  --jq '"PADDLE_NOTIFICATION_WEBHOOK_SECRET=" + .data.endpoint_secret_key' \
  --json '{
    "description": "Local dev",
    "destination": "https://abc123.ngrok.app/api/webhook",
    "type": "url",
    "subscribed_events": ["transaction.completed", "subscription.created", "subscription.updated"],
    "traffic_source": "all"
  }' >> .env.local
```

Find the new destination's ID with `paddle --environment sandbox notification-settings list --jq '.data[] | {id, destination}'`, and change it later with `paddle notification-settings update ntfset_… --json '{ ... }'`.

## Step 2: Create a Paddle SDK helper

Create a single instance of the Node SDK so you don't initialize it on every request.

```ts
// utils/paddle/get-paddle-instance.ts
import { Environment, LogLevel, Paddle, type PaddleOptions } from "@paddle/paddle-node-sdk";

export function getPaddleInstance() {
  const options: PaddleOptions = {
    environment: (process.env.NEXT_PUBLIC_PADDLE_ENV as Environment) ?? Environment.sandbox,
    logLevel: LogLevel.error,
  };
  if (!process.env.PADDLE_API_KEY) {
    throw new Error("PADDLE_API_KEY is not set");
  }
  return new Paddle(process.env.PADDLE_API_KEY, options);
}
```

## Step 3: Write the Route Handler

Two rules. Pre-validate inputs you can check cheaply (return `400`). Wrap everything else in a single try/catch that returns a non-2xx on any throw — including signature failures — so Paddle retries. Any non-2xx works (this skill uses `500`; `401` is equally valid); the only response that loses the event is a `2xx`.

```ts
// app/api/webhook/route.ts
import { NextRequest } from "next/server";
import { getPaddleInstance } from "@/utils/paddle/get-paddle-instance";
import { processEvent } from "@/utils/paddle/process-webhook";

export async function POST(request: NextRequest) {
  const signature = request.headers.get("paddle-signature") ?? "";
  const rawBody = await request.text();
  const secret = process.env.PADDLE_NOTIFICATION_WEBHOOK_SECRET ?? "";

  // Pre-validation: a request with no signature header or empty body
  // can't be verified or processed. 400 is fine here — Paddle will still
  // retry, but that's okay; this is a "you sent us nothing" case.
  if (!signature || !rawBody) {
    return Response.json({ error: "Missing signature or body" }, { status: 400 });
  }

  try {
    const paddle = getPaddleInstance();
    // Throws on signature mismatch, expired timestamp, or malformed event.
    const eventData = await paddle.webhooks.unmarshal(rawBody, secret, signature);

    if (eventData) {
      await processEvent(eventData);
    }

    // Acknowledge fast. Heavy work belongs in a queue (see Step 6).
    return Response.json({ received: true });
  } catch (e) {
    console.error("Webhook error:", e);
    // Any non-2xx tells Paddle to retry — 401 and 500 are equally fine here;
    // only a 2xx would mark the event delivered and lose it. A thrown
    // unmarshal could be a tampered request OR a rotated secret that hasn't
    // been redeployed — they're indistinguishable, so retrying recovers the
    // second case automatically and the first is harmless. We return 500.
    return Response.json({ error: "Internal error" }, { status: 500 });
  }
}
```

`paddle.webhooks.unmarshal()` does three things in one call:

1. Verifies the HMAC signature in the `paddle-signature` header against the raw body using your secret.
2. Throws if the signature is invalid, the timestamp is too old, or the payload is malformed.
3. Returns a typed `EventEntity` with the deserialized payload.

Why a single catch returning one non-2xx, even for signature failures? A thrown `unmarshal` doesn't tell you _why_ it threw — a tampered request, a wrong/rotated secret, an expired timestamp, and a malformed event all surface as the same generic error. Every non-2xx is retried on the same budget, so `401` and `500` are equally event-safe: a rotated secret recovers automatically once you redeploy, whichever you pick. Don't try to split them (`401` for "forged", `500` for "transient") — you can't tell those cases apart, so choose one non-2xx and use it for the whole catch. The only choice that loses events is returning `2xx` on a failure.

## Step 4: Route the event to handlers

Keep the route handler thin. Move event-specific logic into a separate function and switch on `eventType` using the `EventName` enum. TypeScript narrows `event.data` in each case:

```ts
// utils/paddle/process-webhook.ts
import {
  type EventEntity,
  EventName,
  type SubscriptionCreatedEvent,
  type SubscriptionUpdatedEvent,
  type SubscriptionCanceledEvent,
  type TransactionCompletedEvent,
  type CustomerCreatedEvent,
  type CustomerUpdatedEvent,
} from "@paddle/paddle-node-sdk";

/**
 * Paddle delivers at-least-once and in no guaranteed order. The same
 * event.eventId arrives on every retry, so every handler below MUST be
 * idempotent: UPSERT keyed on the Paddle resource id and guarded by
 * event.occurredAt (Step 5), or dedupe on event.eventId before non-DB
 * side effects.
 */
export async function processEvent(event: EventEntity) {
  // Idempotency: handlers may run multiple times for the same event.eventId.
  switch (event.eventType) {
    case EventName.SubscriptionCreated:
    case EventName.SubscriptionUpdated:
    case EventName.SubscriptionCanceled:
      return handleSubscription(event);
    case EventName.TransactionCompleted:
      return handleTransactionCompleted(event);
    case EventName.CustomerCreated:
    case EventName.CustomerUpdated:
      return handleCustomer(event);
    default:
      // Subscribed to events you don't handle yet? No-op. Better than throwing.
      return;
  }
}

async function handleSubscription(
  event: SubscriptionCreatedEvent | SubscriptionUpdatedEvent | SubscriptionCanceledEvent,
) {
  // TODO: UPSERT keyed on event.data.id, applied only if event.occurredAt is
  // newer than the stored value. See Step 5 and subscription-sync.
}

async function handleTransactionCompleted(event: TransactionCompletedEvent) {
  // TODO: idempotent UPSERT keyed on event.data.id, OR dedupe on event.eventId
  // before non-DB side effects (sending receipts, granting credits).
}

async function handleCustomer(event: CustomerCreatedEvent | CustomerUpdatedEvent) {
  // TODO: idempotent UPSERT keyed on event.data.id.
}
```

The Node SDK exports `EventName` (the string discriminator) and a typed event for each, so TypeScript narrows `event.data` when you switch on `eventType`. String literal comparisons like `event.eventType === "subscription.created"` narrow too; `EventName` is easier to read and safer to refactor.

## Step 5: Make handlers idempotent and order-safe

The default path: write handlers in an UPSERT shape keyed on the Paddle resource id, and store the event's `occurredAt` with the row. Paddle doesn't guarantee delivery order, so a retried or replayed older event can arrive after a newer one; only apply an event when its `occurredAt` is newer than the stored value. Do the check and the write in one atomic statement so concurrent deliveries can't interleave:

```ts
async function handleSubscription(
  event: SubscriptionCreatedEvent | SubscriptionUpdatedEvent | SubscriptionCanceledEvent,
) {
  // Insert, or update only if this event is newer than the last one applied.
  await db.query(
    `INSERT INTO subscriptions (id, status, next_billed_at, last_event_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET
       status = EXCLUDED.status,
       next_billed_at = EXCLUDED.next_billed_at,
       last_event_at = EXCLUDED.last_event_at
     WHERE subscriptions.last_event_at IS NULL
        OR subscriptions.last_event_at < EXCLUDED.last_event_at`,
    [event.data.id, event.data.status, event.data.nextBilledAt, event.occurredAt],
  );
}
```

`last_event_at` is a `TIMESTAMPTZ` column; `event.occurredAt` is an ISO 8601 string. Compare against when the event happened, not when you received it. Duplicate and late deliveries then change nothing, with no extra bookkeeping. Most webhook work fits this shape — subscription state, customer records, transaction records all have stable Paddle ids you can key on. See `subscription-sync` for a Supabase version.

### When UPSERT isn't enough: an event-id ledger

Some side effects aren't naturally idempotent — sending a receipt email, granting one-time credits, calling a third-party API that bills per request. For those, dedupe explicitly on `event.eventId`:

```ts
import { db } from "@/lib/db";

export async function processEvent(event: EventEntity) {
  const seen = await db.processedWebhooks.findUnique({
    where: { eventId: event.eventId },
  });
  if (seen) return; // Already handled — return 200 from the route.

  await db.$transaction(async (tx) => {
    await routeEvent(event, tx);
    await tx.processedWebhooks.create({ data: { eventId: event.eventId } });
  });
}
```

The minimal table:

```sql
CREATE TABLE processed_webhooks (
  event_id TEXT PRIMARY KEY,
  processed_at TIMESTAMP NOT NULL DEFAULT NOW()
);
```

Use the ledger only when UPSERT-shaping doesn't cover the side effect. For most subscription/customer/transaction sync work, the guarded UPSERT is enough.

## Step 6: Acknowledge fast — queue heavy work

The 5-second timeout is real. If your handler takes longer, Paddle treats it as a connection timeout, marks the delivery as timed out, and counts the attempt against your retry budget.

Pattern:

1. Verify the signature.
2. Record `event.eventId` (or upsert the resource synchronously if it's cheap).
3. Push anything heavier — sending emails, calling third-party APIs, fetching from `paddle.transactions.list()`, generating PDFs — onto a background queue.
4. Return `200`.

Concretely: don't run `paddle.transactions.list()` inline inside a webhook handler. Don't send an email inline. Don't call Stripe or any other third-party from inside the route handler. Verify, queue, ack.

If you don't have a queue yet, a Vercel Queue, AWS SQS, or even a simple "insert into a `pending_jobs` table and process from a cron" is enough.

## Local testing

Two patterns:

**A. Tunnel a public URL to localhost.** Use `ngrok`, `cloudflared`, or `vercel dev --listen 0.0.0.0` then set up a tunnel.

```bash
ngrok http 3000
# Use the https URL as your notification destination URL: https://abc123.ngrok.app/api/webhook
```

Real Paddle events from the sandbox will then hit your local route handler. To resend one after you change your handler, find it with `paddle --environment sandbox notifications list --notification-setting-id ntfset_…` and run `paddle --environment sandbox notifications replay ntf_…`.

**B. Use the webhook simulator.** The simulator sends to a notification destination, so localhost still needs a tunnel:

1. Tunnel to localhost and point a destination at it. Its **Usage type** must be `Simulation` or `Both`, and it must be subscribed to the events you simulate; otherwise the simulated event is marked `aborted` and not sent.
2. In the dashboard, go to **Paddle > Events > Simulations**.
3. Pick a single event, named like the event type (`subscription.created`, `transaction.paid`), or a scenario: `subscription_creation`, `subscription_renewal`, `subscription_pause`, `subscription_resume`, `subscription_cancellation`.
4. Paddle constructs a payload, signs it with your destination's secret, and POSTs it to your URL once. Simulated events aren't retried and don't appear in notification logs; check the simulation run's events instead, where you can replay them.

See `sandbox-testing` for the full sandbox + simulator workflow.

## Common pitfalls

- **Returning `2xx` on a failed verification.** This is the one status mistake that loses events: Paddle considers only 2xx responses as delivered, so a `2xx` on a failed `unmarshal` marks the event delivered and it's never retried. Every non-2xx — `400`, `401`, `500`, `503` — is retried on the same budget, so returning `401` on a signature failure does **not** lose events (a rotated secret still gets the full retry window to recover). The only status that stops retries from the integrator side is `2xx`. If you have actual abuse to fend off, do it at the edge with rate limits, not inside the handler.
- **Splitting the catch into "signature failure → 401" and "handler error → 500."** `unmarshal` throws indistinguishably for a tampered request, a wrong/rotated secret, an expired timestamp, and a malformed event, so the split is illusory — you can't actually tell which case you're in. Pick one non-2xx and use it for the whole catch. One catch, one status, one operational story.
- **Parsing the body before verification.** If you read JSON with `request.json()`, then re-serialize to verify, the byte sequence won't match what Paddle signed. Always use `await request.text()` and pass the raw string to `unmarshal()`.
- **Wrong secret.** Each notification destination has its own secret. Mixing the sandbox secret with a production destination (or vice versa) results in `unmarshal` throwing on every delivery. `PADDLE_NOTIFICATION_WEBHOOK_SECRET` must match the destination you're targeting — and is _not_ the same value as `PADDLE_API_KEY`.
- **Slow handlers.** 30 seconds of work in the route handler will time out at 5 seconds, count as a failed delivery, and burn a retry attempt. Verify, queue, ack.
- **Treating webhooks as ordered.** They aren't. `subscription.updated` can arrive before the corresponding `subscription.created` if the first delivery is being retried, and a retried or replayed older event can land after a newer one. A plain UPSERT lets that older event overwrite newer state. Store `event.occurredAt` and only apply newer events (Step 5); dedupe on `event.eventId` for side effects.
- **Missing events after extended downtime.** Live delivery attempts stop after about two days (sandbox: about two minutes). After that, replay failed notifications (up to about 90 days old) from **Paddle > Events > Notifications** or with `client.notifications.replay`, list missed events with `GET /events` (`from`/`to`), or query the API for current state.
- **Clock skew.** The SDK rejects a signature whose `ts` is more than 5 seconds old, so a server clock that runs ahead makes every `unmarshal` throw. Keep server clocks in sync (NTP).
- **IP allowlisting.** If your firewall only admits known sources, allowlist the addresses from `GET /ips`. Sandbox and live return different lists, so fetch each from its own API base URL. Still verify signatures.
- **Forgetting to subscribe to the right events.** A destination only sends what you've ticked in the dashboard. Adding a new handler in code without ticking the matching event will leave it silently never firing.
- **Body parsing on Pages Router.** Pages Router examples disabled `bodyParser` to access the raw body. App Router Route Handlers don't need this — `request.text()` always returns raw bytes.

## Verify the integration

1. Add a `console.log(event.eventType, event.eventId)` at the top of `processEvent`.
2. Tunnel localhost (`ngrok http 3000`) and update the destination URL to the tunnel. The destination's **Usage type** must be `Simulation` or `Both`.
3. In the dashboard, go to **Paddle > Events > Simulations** and run a `subscription.created` simulation against your destination.
4. Confirm:
   - The route handler logs the event type.
   - The simulation run's event shows a 200 response. Simulated events get one attempt and don't appear in notification logs. (If a Paddle MCP server is available, `client.simulations.runsEvents.list("ntfsim_…", "ntfsimrun_…")` returns the run's `events`, each with its status, request and response.)
5. Deliberately tamper with the secret in `.env.local` and replay the simulated event. Confirm:
   - The handler returns a non-2xx (this skill's handler returns 500).
   - The run's event shows the failed delivery. Simulated events aren't retried.
   - Restore the correct secret, then replay the event again (in the dashboard, or with `client.simulations.runsEvents.replay(simulationId, runId, eventId)`). It should succeed.
6. Trigger a real flow: complete a sandbox checkout (see `checkout-web`) and confirm the resulting `transaction.completed` and `subscription.created` events arrive. Real deliveries show under **Paddle > Events > Notifications**: open your destination, then **View Logs** on a notification. (With the Paddle MCP: find notification IDs with `client.notifications.list({ notification_setting_id: ["ntfset_…"] })`, then `client.notifications.logs.list("ntf_…", { per_page: 50 })`, which returns `{ pagination, logs }`. Logs are nested under `notifications`, and the notification ID is a positional path param.)

## Related docs

- [Webhooks overview](https://developer.paddle.com/webhooks.md)
- [Signature verification](https://developer.paddle.com/webhooks/about/signature-verification.md)
- [Notification destinations](https://developer.paddle.com/webhooks/about/notification-destinations.md)
- [Respond to webhooks (retry semantics)](https://developer.paddle.com/webhooks/about/respond-to-webhooks.md)
- [Test webhooks with the simulator](https://developer.paddle.com/webhooks/simulator/test-webhooks.md)
- [Subscription event reference](https://developer.paddle.com/webhooks/subscriptions/subscription-created.md)
- [Node SDK reference](https://developer.paddle.com/sdks/libraries/node.md)
- Reference implementation: [paddle-nextjs-starter-kit](https://github.com/PaddleHQ/paddle-nextjs-starter-kit) — see `src/app/api/webhook/route.ts` and `src/utils/paddle/process-webhook.ts`.
