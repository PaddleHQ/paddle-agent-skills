---
name: paddle-subscription-sync
description: Mirror Paddle subscription and customer state into your database via webhooks — schema, upsert pattern, status semantics, scheduled changes, and access gating.
---

# Sync Paddle subscription state into your database

## When to use this skill

Use this skill when you need a local copy of Paddle subscription and customer state — typically to gate features by subscription status, render account pages without round-tripping to the Paddle API, and report on revenue. This skill defines the table schema, the events to subscribe to, the upsert pattern, how to map your app's users to Paddle customers, status semantics, and how to handle scheduled changes (pauses, cancels effective at end of period).

This skill assumes you already receive verified webhooks. If you don't, do `webhooks` first — that skill covers the route handler and signature verification. The code here lives inside the event handler functions that skill creates.

## Prerequisites

- Working webhook endpoint with signature verification (`webhooks`).
- A database (the examples use Supabase, but any SQL store with `UPSERT` works).
- Subscribed events on your notification destination:
  - `customer.created`, `customer.updated`
  - `subscription.created`, `subscription.updated`, `subscription.canceled`
  - Optionally: `transaction.completed` (for one-off purchases), `subscription.activated` (when a trial converts)
- For the backfill and reconciliation job: an API key with `customer.read` and `subscription.read`. The webhook handler itself doesn't call the API.

## Why mirror state at all?

You could call the Paddle API every time you need to know "is this user on the Pro plan?" — but that's slow compared to checking your own DB.

Mirroring means: webhooks are the source of truth that updates your DB; your app reads its own DB; the API is reserved for write actions (cancel, update, refund) where you need an immediate response.

## Schema

The minimum viable schema, in SQL:

```sql
-- Maps a Paddle customer to your app user (email is the fallback bridge).
CREATE TABLE customers (
  customer_id TEXT PRIMARY KEY,        -- "ctm_01h..."
  email TEXT NOT NULL,
  last_event_at TIMESTAMPTZ,           -- occurredAt of the newest event applied
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX customers_email_idx ON customers(email);

CREATE TABLE subscriptions (
  subscription_id TEXT PRIMARY KEY,    -- "sub_01h..."
  customer_id TEXT NOT NULL REFERENCES customers(customer_id),
  user_id TEXT,                        -- your app's user ID, from checkout customData
  subscription_status TEXT NOT NULL,   -- see "Status semantics" below
  price_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  scheduled_change_action TEXT,        -- 'cancel' | 'pause' | 'resume'; null if nothing is scheduled
  scheduled_change_effective_at TIMESTAMPTZ,
  paddle_created_at TIMESTAMPTZ NOT NULL, -- Paddle's created_at, for ordering
  last_event_at TIMESTAMPTZ,           -- occurredAt of the newest event applied
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX subscriptions_customer_id_idx ON subscriptions(customer_id);
CREATE INDEX subscriptions_user_id_idx ON subscriptions(user_id);
CREATE INDEX subscriptions_status_idx ON subscriptions(subscription_status);
```

This is intentionally lean. Add columns as you need them (e.g. `currency_code`, `next_billed_at`, `discount_id`, `items` as JSONB for multi-item subscriptions). The Paddle data is much richer; only mirror what your UI actually queries.

Paddle doesn't guarantee delivery order: a retry or replay can arrive after a newer event. So writes go through two functions that insert a row, or update it only when the incoming event is newer than `last_event_at`, in one atomic statement:

```sql
CREATE OR REPLACE FUNCTION upsert_subscription(
  p_subscription_id TEXT, p_customer_id TEXT, p_user_id TEXT, p_status TEXT,
  p_price_id TEXT, p_product_id TEXT, p_scheduled_change_action TEXT,
  p_scheduled_change_effective_at TIMESTAMPTZ, p_paddle_created_at TIMESTAMPTZ,
  p_last_event_at TIMESTAMPTZ
) RETURNS void LANGUAGE sql AS $$
  INSERT INTO subscriptions AS s (
    subscription_id, customer_id, user_id, subscription_status, price_id, product_id,
    scheduled_change_action, scheduled_change_effective_at, paddle_created_at, last_event_at
  ) VALUES (
    p_subscription_id, p_customer_id, p_user_id, p_status, p_price_id, p_product_id,
    p_scheduled_change_action, p_scheduled_change_effective_at, p_paddle_created_at, p_last_event_at
  )
  ON CONFLICT (subscription_id) DO UPDATE SET
    customer_id = EXCLUDED.customer_id,
    user_id = COALESCE(EXCLUDED.user_id, s.user_id),
    subscription_status = EXCLUDED.subscription_status,
    price_id = EXCLUDED.price_id,
    product_id = EXCLUDED.product_id,
    scheduled_change_action = EXCLUDED.scheduled_change_action,
    scheduled_change_effective_at = EXCLUDED.scheduled_change_effective_at,
    paddle_created_at = EXCLUDED.paddle_created_at,
    last_event_at = EXCLUDED.last_event_at,
    updated_at = NOW()
  WHERE s.last_event_at IS NULL OR s.last_event_at < EXCLUDED.last_event_at;
$$;

CREATE OR REPLACE FUNCTION upsert_customer(
  p_customer_id TEXT, p_email TEXT, p_last_event_at TIMESTAMPTZ
) RETURNS void LANGUAGE sql AS $$
  INSERT INTO customers AS c (customer_id, email, last_event_at)
  VALUES (p_customer_id, p_email, p_last_event_at)
  ON CONFLICT (customer_id) DO UPDATE SET
    email = EXCLUDED.email,
    last_event_at = EXCLUDED.last_event_at,
    updated_at = NOW()
  WHERE c.last_event_at IS NULL OR c.last_event_at < EXCLUDED.last_event_at;
$$;
```

The functions run with the caller's privileges, so Row Level Security still applies; call them with the service-role client. The `IS NULL` check lets the first write land on rows that existed before you added `last_event_at`. Outside Supabase, run the same `INSERT … ON CONFLICT … DO UPDATE … WHERE` statement directly.

## Supabase clients

The examples use two server-side Supabase helpers, matching the Paddle Next.js starter kit. If your app already has equivalents, use those. `createClient` from `@/utils/supabase/server` reads as the signed-in user (anon key, user session cookies):

```ts
// utils/supabase/server.ts
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export async function createClient() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Called from a Server Component; middleware refreshes the session instead.
          }
        },
      },
    },
  );
}
```

```ts
// utils/supabase/server-internal.ts — service role, no user session. Server-only.
import { createServerClient } from "@supabase/ssr";

export async function createClient() {
  // No cookies: with the signed-in user's session attached, requests would run
  // as that user and row-level security (RLS) would still apply.
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { cookies: { getAll: () => [], setAll: () => {} } },
  );
}
```

Import it as `import { createClient as createAdminClient } from "@/utils/supabase/server-internal"` and only use it on the server: in the webhook handler, or in a Server Action after you've checked who the user is. It deliberately skips cookies, so it never picks up a signed-in user's session. If you write your own wrapper, don't name it `createServerClient`, which would shadow the `@supabase/ssr` import.

## Map app users to Paddle customers

The most reliable bridge is **your own user ID**, passed through checkout:

- Open checkout with `customData: { userId: user.id }` (see `checkout-web`).
- Paddle copies the checkout's custom data onto the transaction, and onto the subscription created from it. `subscription.created` arrives with `data.customData.userId`.
- The handler below stores it as `subscriptions.user_id`.

Keep **email** as a fallback, for subscriptions created without that custom data:

- Your app's user table has an email.
- Paddle's customer record has an email.
- Match on email when the user lands on a billing page.

The `customers.email` mirror lets you look up the Paddle `customer_id` from your authenticated user without an API call:

```ts
// utils/paddle/get-customer-id.ts
import { createClient } from "@/utils/supabase/server";

export async function getCustomerId(): Promise<string> {
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  const email = userData?.user?.email;
  if (!email) return "";

  const { data } = await supabase
    .from("customers")
    .select("customer_id")
    .eq("email", email)
    .single();

  return data?.customer_id ?? "";
}
```

If a user signs up in your app and **then** checks out (no Paddle customer yet), `getCustomerId` returns `''`. After their first checkout, the `customer.created` webhook fires, your handler upserts the row, and subsequent calls find them.

## Process subscription events

Inside the route handler from `webhooks`, route to a typed handler:

```ts
// utils/paddle/process-webhook.ts
import {
  EventName,
  type Customer,
  type CustomerCreatedEvent,
  type CustomerUpdatedEvent,
  type EventEntity,
  type Subscription,
  type SubscriptionCanceledEvent,
  type SubscriptionCreatedEvent,
  type SubscriptionUpdatedEvent,
} from "@paddle/paddle-node-sdk";
import { createClient as createAdminClient } from "@/utils/supabase/server-internal";

type SubscriptionEvent =
  | SubscriptionCreatedEvent
  | SubscriptionUpdatedEvent
  | SubscriptionCanceledEvent;
type CustomerEvent = CustomerCreatedEvent | CustomerUpdatedEvent;

export async function processEvent(event: EventEntity) {
  switch (event.eventType) {
    case EventName.SubscriptionCreated:
    case EventName.SubscriptionUpdated:
    case EventName.SubscriptionCanceled:
      return saveSubscription(event.data, event.occurredAt);
    case EventName.CustomerCreated:
    case EventName.CustomerUpdated:
      return saveCustomer(event.data, event.occurredAt);
  }
}

// eventAt is the event's occurredAt (or the entity's updatedAt when reconciling).
// The SQL function ignores the write if the row already has a newer one.
export async function saveSubscription(
  sub: SubscriptionEvent["data"] | Subscription,
  eventAt: string,
) {
  const admin = await createAdminClient();
  const userId = sub.customData?.userId;

  const { error } = await admin.rpc("upsert_subscription", {
    p_subscription_id: sub.id,
    p_customer_id: sub.customerId,
    p_user_id: typeof userId === "string" ? userId : null,
    p_status: sub.status,
    p_price_id: sub.items[0]?.price?.id ?? "",
    p_product_id: sub.items[0]?.price?.productId ?? "",
    p_scheduled_change_action: sub.scheduledChange?.action ?? null,
    p_scheduled_change_effective_at: sub.scheduledChange?.effectiveAt ?? null,
    p_paddle_created_at: sub.createdAt,
    p_last_event_at: eventAt,
  });
  if (error) throw error;
}

export async function saveCustomer(customer: CustomerEvent["data"] | Customer, eventAt: string) {
  const admin = await createAdminClient();
  const { error } = await admin.rpc("upsert_customer", {
    p_customer_id: customer.id,
    p_email: customer.email,
    p_last_event_at: eventAt,
  });
  if (error) throw error;
}
```

A few notes:

- The webhook handler must use a Supabase client with the **service role key** (`createAdminClient`), not the anon key — webhooks don't run as a logged-in user, and your RLS policies will block writes from anon. Keep the service-role client in its own file (`server-internal.ts`) so it's never imported into client code.
- Ordering: a retried or replayed older event can arrive after a newer one. Because the functions only write when `occurredAt` is newer than `last_event_at`, late and repeated deliveries change nothing. Keep deduping on `event.eventId` for side effects that aren't state writes, like sending emails (see `webhooks`).
- The `items` array can have multiple line items for hybrid subscriptions. The example only stores the first; for multi-item subscriptions, store the whole array as JSONB.

## Status semantics

`subscription.status` is the field your access-gating logic should read. Values:

| Status     | Meaning                                                                                                        | Should the user have access? |
| ---------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `active`   | Paying, current.                                                                                               | Yes                          |
| `trialing` | In a trial period (free or paid).                                                                              | Yes                          |
| `past_due` | Payment is overdue. Automatic collection: Paddle retries (dunning). Manual collection (invoices): not retried. | Yes, with a banner           |
| `paused`   | Subscription is paused; no billing, no service.                                                                | No (typically)               |
| `canceled` | Cancellation has taken effect.                                                                                 | No                           |

`canceled` is the **terminal state** — it means the subscription has actually ended. If a user cancels but their billing period hasn't run out yet, the status doesn't change (it stays `active`, `trialing` or `past_due`) and `scheduled_change_action` is `cancel`. The status only flips to `canceled` when `scheduled_change_effective_at` arrives.

A reasonable access gate:

```ts
function hasActiveSubscription(sub: Subscription | null): boolean {
  if (!sub) return false;
  return ["active", "trialing", "past_due"].includes(sub.subscription_status);
}
```

During `past_due`, keep access but show a banner asking the user to update their payment method (or pay the invoice, for manual collection).

## Handling scheduled changes

When a user cancels mid-period, or schedules a pause, Paddle sends a `subscription.updated` event with:

```json
{
  "data": {
    "id": "sub_01h...",
    "status": "active",
    "scheduled_change": {
      "action": "cancel",
      "effective_at": "2026-05-12T00:00:00Z"
    }
  }
}
```

The status doesn't change (here `active`; it can also be `trialing` or `past_due`) — they keep service until `effective_at`. Then Paddle sends another event flipping status to `canceled` (or `paused`) and clearing `scheduled_change`. A paused subscription with a resume date has a `resume` scheduled change.

Store `scheduled_change.action` and `scheduled_change.effective_at` as `scheduled_change_action` and `scheduled_change_effective_at`. In your UI, the action decides the message, like "Your subscription will cancel on May 12" instead of "Subscribe". Here's a typical pattern:

```ts
function getSubscriptionUiState(sub: Subscription | null) {
  if (!sub) return "no-subscription";
  switch (sub.scheduled_change_action) {
    case "cancel":
      return "cancel-scheduled";
    case "pause":
      return "pause-scheduled";
    case "resume":
      return "resume-scheduled";
    default:
      return sub.subscription_status; // 'active' | 'trialing' | 'past_due' | 'paused' | 'canceled'
  }
}
```

## Querying mirrored state

Once you mirror, you can read everything from your DB without API calls:

```ts
// utils/db/get-user-subscription.ts
"use server";

import { createClient } from "@/utils/supabase/server";
import { getCustomerId } from "@/utils/paddle/get-customer-id";

export async function getUserSubscription() {
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;
  if (!userId) return null;

  // Match the user ID from checkout customData, or fall back to the email-matched customer.
  const customerId = await getCustomerId();
  const match = customerId
    ? `user_id.eq.${userId},customer_id.eq.${customerId}`
    : `user_id.eq.${userId}`;

  const { data } = await supabase
    .from("subscriptions")
    .select("*")
    .or(match)
    .order("paddle_created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return data;
}
```

This returns the newest subscription by Paddle's `created_at`. Don't order by your own `created_at`: that's when the row was written, which backfills and out-of-order events scramble. If a user can hold several subscriptions, filter on `subscription_status` (e.g. `.in("subscription_status", ["active", "trialing", "past_due"])`) or return them all.

Use the Paddle API only for **mutations**: cancel, pause, resume, upgrade, refund. Reads should hit your DB.

## Initial backfill

Adding subscription sync to an existing app (with existing Paddle data) means you need to backfill before relying on the mirror.

> The Paddle MCP exposes three tools per server (`search`, `execute`, `report_missing_tool`). Workflow: call `search` to confirm the exact method name and parameter shapes, then call `execute` with an async function that calls `client.<resource>.<operation>(...)`. **Method paths are camelCase** (`client.clientTokens.create`, `client.pricingPreview.preview`). **Body params and response fields are snake_case** (`tax_category`, `product_id`, `unit_price`, `currency_code`). List methods return `{ pagination: { hasMore, estimatedTotal }, <resource>: [...] }`, not `data`. The array's key is the resource's API path segment, so it's kebab-case where the method path is camelCase: `(await client.products.list()).products`, `(await client.clientTokens.list())["client-tokens"]`. Page with `{ after: "<last_id>" }` while `pagination.hasMore` is true, not `.next()`. Lists that aren't paginated, like `client.currencies.list()`, return a plain array. Single-entity methods return the entity. Chain multi-step workflows inside one `execute`; variables don't persist between calls. Hard caps: 50 API calls per execute, 30s timeout, and 32,000 characters of code.

If a Paddle MCP server is available to you, paginate explicitly inside one `execute` call:

```js
async (client) => {
  const customers = [];
  let after;
  do {
    const page = await client.customers.list({
      after,
      per_page: 200,
      status: ["active", "archived"],
    });
    customers.push(...page.customers);
    after = page.pagination.hasMore ? page.customers.at(-1).id : undefined;
  } while (after);
  return customers;
};
```

Listing customers returns only `active` ones by default; include `archived` so older subscriptions still find their customer row. Page through `client.subscriptions.list()` the same way (`page.subscriptions`); it returns every status by default.

**The 50-call cap matters here.** With `per_page: 200` that's a ceiling of ~10,000 customers per `execute` invocation. If the user's account fits in one execute, this is fine. If not, split across multiple `execute` calls — pass the last seen ID back in as the starting `after` cursor each time — or fall back to the SDK job below, which has no such cap.

Otherwise (or for larger backfills), use the SDK. Writing through the same `saveCustomer`/`saveSubscription` helpers keeps the ordering guard: each entity's `updatedAt` stands in for the event time, so the job never overwrites a newer webhook write. Run it inside your Next.js app so it reuses those helpers, for example as a cron-triggered Route Handler:

```ts
// app/api/cron/reconcile-paddle/route.ts
import { getPaddleInstance } from "@/utils/paddle/get-paddle-instance";
import { saveCustomer, saveSubscription } from "@/utils/paddle/process-webhook";

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const paddle = getPaddleInstance();
  for await (const customer of paddle.customers.list({ status: ["active", "archived"] })) {
    await saveCustomer(customer, customer.updatedAt);
  }
  for await (const sub of paddle.subscriptions.list()) {
    await saveSubscription(sub, sub.updatedAt);
  }
  return Response.json({ ok: true });
}
```

Run it once before flipping access gating to read from your DB. Then keep running it on a schedule (for example nightly, from your platform's cron) as a reconciliation job that repairs anything a missed webhook left stale. On large accounts, split the work to stay within your platform's function time limit.

## Common pitfalls

- **Using a Supabase anon key in the webhook handler.** RLS policies block the writes. Use the service role key in a server-internal client (`createAdminClient`).
- **Mapping users by `customer_id` before checkout.** A new app user has no Paddle customer until they complete a checkout. Pass your user ID in checkout `customData`, and fall back to matching on email.
- **Treating `canceled` as "just hit cancel".** It's the terminal state. The "user pressed cancel" event is `subscription.updated` with a non-null `scheduled_change.action: 'cancel'`, unless you allow users to cancel immediately. Don't revoke access until status flips to `canceled`.
- **Reading status from a stale row.** If your handler is queued (which it should be for slow ops), the DB row is updated _after_ the queue worker runs. Latency between webhook receipt and row update is typically sub-second, but if you need read-after-write within the route handler itself, do the upsert synchronously.
- **Storing only one item from `subscription.items`.** If you sell hybrid plans (a base subscription + addons), store the whole array. Otherwise the UI shows the first item only.
- **No backfill before flipping reads to your DB.** Existing customers will look like "no subscription" until their next webhook — which might be when they cancel. Always backfill first, then keep reconciling on a schedule.
- **Forgetting `customer.updated`.** If a customer changes their email in Paddle, you won't be able to look them up via `getCustomerId` until you sync the new email. Subscribe to `customer.updated` from day one.
- **Out-of-order events.** Paddle doesn't guarantee delivery order. `subscription.updated` can arrive before its `subscription.created`, and a retried or replayed older event can land after a newer one. A plain UPSERT lets that older event overwrite newer state. Write through the `last_event_at` guard above, and dedupe side effects on `event.eventId`.

## Verify the integration

1. Create a sandbox subscription via your checkout flow, passing your user ID in `customData`.
2. Check your `customers` and `subscriptions` tables — both should have the new rows within a second of `checkout.completed`, with `user_id` set on the subscription.
3. Cancel the subscription via your customer portal.
4. Confirm the `subscriptions` row keeps its status (`active`, or `trialing` during a trial) with `scheduled_change_action: 'cancel'` and `scheduled_change_effective_at` set.
5. There's no test clock in sandbox, so don't wait for the period to end. Either cancel a sandbox subscription with `effective_from: "immediately"` (see `subscription-cancel`), or run a simulator `subscription_cancellation` scenario (see `sandbox-testing`); it defaults to effective immediately. The simulator only sends webhooks, so enter your sandbox subscription's ID to get its real IDs in the payloads, and use a destination with **Usage type** `Simulation` or `Both`. Confirm the row flips to `canceled` and the scheduled change columns clear.
6. Run a `subscription_pause` scenario the same way and confirm your UI handles `paused`.

## Related docs

- [Provision access via webhooks](https://developer.paddle.com/build/subscriptions/provision-access-webhooks.md)
- [Cancel subscriptions](https://developer.paddle.com/build/subscriptions/cancel-subscriptions.md)
- [Pause subscriptions](https://developer.paddle.com/build/subscriptions/pause-subscriptions.md)
- Reference implementation: [paddle-nextjs-starter-kit](https://github.com/PaddleHQ/paddle-nextjs-starter-kit) — see `src/utils/paddle/process-webhook.ts` and `src/utils/paddle/get-customer-id.ts`.
