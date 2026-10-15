---
name: paddle-usage-based-billing
description: Add Paddle usage-based billing (early access) to a Next.js app — early access check, usage balance units, meters, price allowances, usage events, balance gating, and `usage_balance.depleted`, using the Paddle API directly.
---

# Add usage-based billing to a Next.js app (early access)

## When to use this skill

Use this skill when the user wants subscription plans that include prepaid usage — like 10,000 API calls, 1 million tokens, or 500 document exports a month — and wants to report usage to Paddle and restrict features when customers run out.

Pair with:

- `catalog-setup` — create the product. Create prices with allowances using this skill's API helper instead of its seed script, and don't reuse its trial price: prices with allowances can't have a trial period.
- `checkout-web` — customers subscribe to a plan with an allowance using a normal checkout.
- `subscription-sync` — map your users to Paddle customer IDs, which usage events need.
- `webhooks` — receive and verify `usage_balance.depleted`, and queue work instead of doing it in the handler.
- `subscription-update` — plan changes. This skill overrides its proration defaults (see "Renewals and plan changes").
- `sandbox-testing` — test cards and checkout in a sandbox account.

## Early access (beta) status and tooling

Read this first. These facts change how you build the integration.

- **Get the latest version of this skill before you start.** Early access (beta) changes often, so this copy might be out of date. Fetch the latest version and follow it instead if it's different. If you can't, continue with this copy, and suggest the user updates their Paddle plugin or skills.
- **Usage-based billing is in early access (beta).** Only accounts in the early access program can use it, and fields and behavior may change before general release. Accounts apply at [Set up usage-based billing](https://developer.paddle.com/build/usage-based-billing).
- **The Paddle MCP servers don't include usage-based billing operations during early access (beta).** Don't `search` the MCP for meter, usage event, or usage balance tools, and don't fake metering with custom items or one-time charges. Call the Paddle API with `fetch`, as shown below.
- **The Paddle Node SDK doesn't support usage-based billing yet.** It has no `paddle.meters` or `paddle.usageEvents`, and its price types don't include `allowances`: TypeScript rejects the field on `paddle.prices.create()`, and the SDK's `Price` objects leave it out of responses. Use `fetch` for every call in this skill. Use the SDK only to verify webhooks.
- **Paddle never blocks usage during early access (beta).** When a balance runs out, Paddle keeps recording usage as overage and doesn't bill for it. Your app decides what customers can do.

## How usage-based billing works

1. **Usage balance units** (`ubu_`) are what customers hold a balance of, like API calls or credits.
2. **Meters** (`mtr_`) turn usage into drawdown. Each meter links an `action`, like `api_call`, to one usage balance unit, at a `rate`. A usage event draws down `quantity × rate` from the customer's balance of that unit. Several meters can draw down the same unit, for example `chat_message` at `"1"` and `report_export` at `"25"` from one "Credits" unit.
3. **Allowances** on recurring prices grant an amount of a unit each billing period, multiplied by the item quantity.
4. **Usage balances** (`ubl_`) hold what a customer has used and has left. Paddle creates one for each customer and unit in the background when a subscription with an allowance activates. They belong to the customer, not the subscription: allowances from several subscriptions for the same unit combine into one balance.
5. **Usage events** report usage. Paddle accepts them straight away and draws down balances shortly after.

Across a billing period:

- **`remaining` counts down to `"0"`** and never goes negative. After that, usage is recorded as `overage`, which Paddle doesn't bill during early access (beta).
- **`used` doesn't include overage**, so the allowance is `used.total` + `remaining.total`. The `subscription` amount in each breakdown always equals `total` during early access (beta), so don't build UI around the split.
- **At renewal**, unused usage expires, Paddle grants the full allowance again, and clears overage. Unused usage doesn't roll over.
- **`usage_balance.depleted` occurs when usage draws `remaining` to `"0"`.** There's no event when usage is replenished.

## Decide with the user first

Confirm these before writing code. Do not guess:

1. **What's metered.** Each metered feature needs an `action`, like `api_call` or `document_export`.
2. **What customers hold a balance of.** One unit per balance, with a plural name like `calls`. If several features should draw down one balance, like a shared pool of credits, use one unit with a meter for each feature and a `rate` for each.
3. **The allowance for each plan.** For each plan's price, how much of each unit it includes per billing period.
4. **Quantities.** Whole numbers or decimals, and whether any meter converts usage with a `rate` other than `"1"` (for example, `"0.001"` for one credit per 1,000 tokens).
5. **What happens at zero.** Block the feature, allow it and prompt an upgrade, or allow it quietly (overage isn't billed during early access (beta)).

## What your app stores

- **Config**: usage balance unit IDs, meter actions, and the price IDs for plans with allowances.
- **Paddle customer ID for each user**, from `subscription-sync`.
- **A usage event outbox**, so usage is never lost or double-counted (Step 5).
- **A cached balance** for each customer and unit, in a table keyed on both or a store like Redis, so you don't call Paddle on every request (Step 6).

```ts
// utils/paddle/usage-config.ts
export const USAGE = {
  apiCalls: {
    usageBalanceUnitId: "ubu_...", // from Step 3
    action: "api_call",
    rate: 1, // matches the meter's rate
  },
} as const;
```

```sql
CREATE TABLE usage_events (
  event_key TEXT PRIMARY KEY,           -- your ID for this usage, sent to Paddle as event_key
  customer_id TEXT NOT NULL,            -- "ctm_01h..."
  action TEXT NOT NULL,
  quantity TEXT NOT NULL,               -- decimal string, like "1" or "2.5"
  occurred_at TEXT NOT NULL,            -- RFC 3339 UTC, captured once
  status TEXT NOT NULL DEFAULT 'pending', -- pending | sent | failed
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX usage_events_pending_idx ON usage_events(status) WHERE status = 'pending';
```

## Prerequisites

You need:

- A Paddle account in usage-based billing early access. Step 2 checks this.
- An API key with these permissions: `usage_balance_unit.write`, `meter.write`, `price.write`, `usage_event.write`, and `usage_balance.read`. Each `write` permission includes `read`.
- `@paddle/paddle-node-sdk` 2.5 or later (v3 recommended) for webhooks. Earlier versions return `null` for event types they don't know, so `usage_balance.depleted` is silently lost.

```bash
NEXT_PUBLIC_PADDLE_ENV=sandbox             # or "production"
PADDLE_API_KEY=pdl_sdbx_apikey_...         # server-side only; never expose to the browser
PADDLE_NOTIFICATION_WEBHOOK_SECRET=pdl_ntfset_...
```

Run the one-off scripts in this skill with `node --env-file=.env.local --import tsx scripts/<name>.ts`. `tsx` on its own doesn't load `.env.local`.

## Step 1: Create an API helper

Every call in this skill goes through one server-side helper. Sandbox and live use different base URLs, and a sandbox key only works against the sandbox API.

```ts
// utils/paddle/api.ts
// Server-side only. Never import this from a client component.

const BASE_URL =
  process.env.NEXT_PUBLIC_PADDLE_ENV === "production"
    ? "https://api.paddle.com"
    : "https://sandbox-api.paddle.com";

export class PaddleApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public requestId?: string,
    public retryAfterSeconds?: number, // set on 429 responses
  ) {
    super(message);
  }
}

export async function paddleApi<T>(
  path: string,
  options: { method?: "GET" | "POST" | "PATCH"; body?: unknown } = {},
): Promise<T> {
  const apiKey = process.env.PADDLE_API_KEY;
  if (!apiKey) throw new Error("PADDLE_API_KEY is not set");

  const response = await fetch(`${BASE_URL}${path}`, {
    method: options.method ?? "GET",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    cache: "no-store",
  });

  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const retryAfter = Number(response.headers.get("Retry-After"));
    throw new PaddleApiError(
      response.status,
      json?.error?.code ?? "unknown",
      json?.error?.detail ?? response.statusText,
      json?.meta?.request_id,
      retryAfter > 0 ? retryAfter : undefined,
    );
  }
  return json as T;
}
```

## Step 2: Check early access

Before building anything, call `GET /meters`. The usage-based billing API key permissions only appear in the Paddle dashboard for accounts in early access, so this call tells you whether the account and the key are set up. Paddle returns `403` for both permission and authentication problems, so branch on the error `code`:

```ts
// scripts/check-usage-billing-access.ts
import { paddleApi, PaddleApiError } from "@/utils/paddle/api";

const AUTH_ERRORS = [
  "invalid_token",
  "authentication_missing",
  "authentication_malformed",
  "expired_token",
];

async function main() {
  try {
    await paddleApi("/meters?per_page=1");
    console.log("Usage-based billing is available for this account and API key.");
  } catch (error) {
    if (!(error instanceof PaddleApiError)) throw error;

    if (error.code === "forbidden") {
      console.log(
        "Missing usage-based billing permissions. Add them to the key in Paddle > Developer tools > " +
          "Authentication. If they aren't listed, apply for early access at " +
          "https://developer.paddle.com/build/usage-based-billing",
      );
    } else if (AUTH_ERRORS.includes(error.code)) {
      console.log("Invalid API key, or it doesn't match NEXT_PUBLIC_PADDLE_ENV.");
    } else {
      throw error;
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

If the account isn't in early access, tell the user to apply using the tutorial, and stop there.

## Step 3: Create a unit, meter, and price

This is one-time setup. Create prices with allowances using the API helper, not the SDK or `catalog-setup`'s seed script. Create the unit first, then the meter and price that use it:

```ts
// scripts/setup-usage-billing.ts
import { paddleApi } from "@/utils/paddle/api";

type Entity = { data: { id: string } };

async function main() {
  const unit = await paddleApi<Entity>("/usage-balance-units", {
    method: "POST",
    body: { name: "API calls", unit_name: "calls" }, // plural: what customers hold a balance of
  });

  const meter = await paddleApi<Entity>("/meters", {
    method: "POST",
    body: {
      usage_balance_unit_id: unit.data.id,
      name: "API calls",
      action: "api_call", // what you send with usage events
      unit_name: "call", // singular: what the meter measures
      rate: "1", // how much of the unit each unit of usage draws down
    },
  });

  // Prices with allowances can't have a trial_period.
  const price = await paddleApi<{ data: { id: string; allowances: unknown[] } }>("/prices", {
    method: "POST",
    body: {
      product_id: "pro_...",
      description: "Pro plan (monthly), including 10,000 API calls",
      name: "Pro",
      unit_price: { amount: "2000", currency_code: "USD" },
      billing_cycle: { interval: "month", frequency: 1 },
      allowances: [{ usage_balance_unit_id: unit.data.id, amount: "10000" }],
    },
  });

  // Save the IDs in utils/paddle/usage-config.ts, and check allowances isn't empty.
  console.log({
    usageBalanceUnitId: unit.data.id,
    meterId: meter.data.id,
    priceId: price.data.id,
    allowances: price.data.allowances,
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

- **`action`** must match `^[a-z][a-z0-9_]*$` and be 2–64 characters. `rate` is a decimal string greater than zero, and `aggregation` defaults to `sum`, the only option during early access (beta).
- **Meters are hard to change.** You can't change `usage_balance_unit_id` or `aggregation`, and two meters can't share the same `action` and unit (`meter_action_usage_balance_unit_duplicate`), even if one is archived. There's no delete: archive with `PATCH` and `status: "archived"`, though archived meters still draw down usage balances.
- **Changing `rate` or `action` only affects new usage.** Paddle doesn't recalculate usage it already recorded. After you change `action`, events sent with the old action no longer draw down this meter's unit, so update `usage-config.ts` at the same time.
- **Allowances need a recurring price without a trial** (`price_allowance_not_allowed_for_trial_price`, `price_allowance_not_allowed_for_one_off_price`). A price can have up to 20, one for each unit, and Paddle multiplies each by the item quantity. An `amount` of `"0"` gives an empty balance, so all usage is recorded as overage.
- **`PATCH /prices/{price_id}` replaces `allowances` in full**, so send every allowance you want to keep. A price without allowances never creates a usage balance.

## Step 4: Confirm the usage balance after checkout

Open a checkout for the price as normal — see `checkout-web`. Subscriptions and transactions with these prices must be collected automatically. Manually-collected (invoiced) ones are rejected.

These prices can't have trials, so `subscription.created` arrives with `status: active`. That's your signal that Paddle is creating the usage balance. It happens in the background, so don't poll for it inside the webhook handler. Queue a job (see `webhooks`), and have the job check with backoff:

```ts
// utils/paddle/usage.ts
import { paddleApi, PaddleApiError } from "@/utils/paddle/api";

export type UsageBalance = {
  id: string;
  usage_balance_unit_id: string;
  balance: {
    used: { total: string };
    remaining: { total: string };
    overage: { total: string; started_at?: string };
  };
};

// Returns null if the customer has no usage balance for this unit. One page is enough:
// customers have one usage balance for each unit.
export async function getUsageBalance(customerId: string, usageBalanceUnitId: string) {
  const result = await paddleApi<{ data: UsageBalance[] }>(
    `/customers/${customerId}/usage-balances?per_page=200`,
  );
  return result.data.find((b) => b.usage_balance_unit_id === usageBalanceUnitId) ?? null;
}

// Run from a queued job after subscription.created. Retries with backoff.
export async function confirmUsageBalance(customerId: string, usageBalanceUnitId: string) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const usageBalance = await getUsageBalance(customerId, usageBalanceUnitId);
    if (usageBalance) return usageBalance;
    await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 1000));
  }
  throw new Error(`No usage balance for ${customerId} and ${usageBalanceUnitId}`);
}
```

For a customer's first subscription with this unit, `remaining.total` should equal the allowance `amount` multiplied by the item quantity, and `used.total` should be `"0"`. If the balance never appears:

- **The price has no allowances.** Get it with `GET /prices/{price_id}` and check `allowances` isn't empty.
- **You're looking up the wrong customer or account.** Balances belong to the subscription's Paddle customer, in the same sandbox or live account.

## Step 5: Record usage with an outbox

Don't call Paddle in the middle of the customer's request. Instead:

1. **Write an outbox row in the same database transaction as the metered work**, with `event_key` set to your own ID for the usage and `occurred_at` captured once, when the usage happened. If the work rolls back, so does the usage.
2. **Send pending rows from a worker**, like a cron-triggered route handler, one event per request. Run it often, and alert if rows stay `pending`, since Paddle rejects events more than 60 days old.
3. **Update each row from the result.** Mark `accepted` events `sent`. Retry network errors, `5xx` responses, `429` responses, and events rejected with `internal_error`, with the same `event_key` and `occurred_at`. Mark other rejections `failed`, with the error code, for review.
4. **Stop the run on a `429`.** Paddle [rate limits API requests](https://developer.paddle.com/api-reference/about/rate-limiting) by IP address and blocks further requests until `Retry-After` passes, so leave the remaining rows `pending` and resume after `retryAfterSeconds`.

Next.js `after()` on its own isn't durable: if the process stops, the usage is lost. Use it to trigger the worker sooner, not instead of the outbox.

```ts
// utils/paddle/usage.ts (continued)
type UsageEventRow = {
  eventKey: string;
  customerId: string;
  action: string;
  quantity: string; // decimal string, like "1" or "2.5"
  occurredAt: string;
};

type UsageEventResponse = {
  data: {
    events: Array<{ event_key: string; status: "accepted" | "rejected"; error?: { code: string } }>;
  };
};

type SendResult = {
  outcome: "sent" | "retry" | "failed";
  code?: string;
  retryAfterSeconds?: number; // set when rate limited: stop the run until it passes
};

const QUANTITY = /^(0|[1-9]\d{0,34})(\.\d{1,9})?$/;

export async function sendUsageEvent(row: UsageEventRow): Promise<SendResult> {
  // Quantities must be greater than zero, with up to 9 decimal places and no leading zeros.
  // Don't build them with String(number): 0.1 + 0.2 becomes "0.30000000000000004", which
  // Paddle rejects.
  if (!QUANTITY.test(row.quantity) || Number(row.quantity) <= 0) {
    return { outcome: "failed", code: "invalid_quantity" };
  }

  try {
    const result = await paddleApi<UsageEventResponse>("/usage-events", {
      method: "POST",
      body: {
        // One event per request during early access (beta). More than one returns a 400.
        events: [
          {
            event_key: row.eventKey,
            customer_id: row.customerId,
            action: row.action,
            quantity: row.quantity,
            occurred_at: row.occurredAt,
          },
        ],
      },
    });
    const [event] = result.data.events;
    if (event.status === "accepted") return { outcome: "sent" };
    const code = event.error?.code ?? "rejected";
    return { outcome: code === "internal_error" ? "retry" : "failed", code };
  } catch (error) {
    if (error instanceof PaddleApiError && error.status === 429) {
      return {
        outcome: "retry",
        code: error.code,
        retryAfterSeconds: error.retryAfterSeconds ?? 60,
      };
    }
    if (error instanceof PaddleApiError && error.status < 500) {
      return { outcome: "failed", code: error.code };
    }
    return { outcome: "retry" }; // network error or 5xx: resend unchanged
  }
}
```

- **Paddle counts an event once for each `event_key` and `occurred_at`**, for a customer and action, which is why the outbox stores both.
- **`occurred_at` can't be more than 60 days in the past or 24 hours in the future.** Paddle rejects events outside this window with `usage_event_timestamp_too_old` or `usage_event_future_timestamp`. Retries are rejected once they're more than 60 days old too, but if Paddle accepted an earlier attempt, it still counts.
- **Each event is its own request during early access (beta).** If customers use a metered feature many times a second, add up usage in your app and send one event for each customer and action per short window, like a minute, with the total `quantity` and an `event_key` for that window. This keeps the worker under the rate limit.

## Step 6: Gate features on the balance

Read the balance from your cache, and refresh it from Paddle when it's stale:

```ts
// utils/paddle/usage.ts (continued)
export interface BalanceCache {
  get(
    customerId: string,
    unitId: string,
  ): Promise<{ remaining: number | null; fetchedAt: number } | null>;
  set(customerId: string, unitId: string, remaining: number | null): Promise<void>;
  decrement(customerId: string, unitId: string, amount: number): Promise<void>;
}

const CACHE_TTL_MS = 60_000;

// Returns null if the customer has no usage balance for this unit.
export async function getRemaining(cache: BalanceCache, customerId: string, unitId: string) {
  const cached = await cache.get(customerId, unitId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.remaining;

  const usageBalance = await getUsageBalance(customerId, unitId);
  const remaining = usageBalance ? Number(usageBalance.balance.remaining.total) : null;
  await cache.set(customerId, unitId, remaining);
  return remaining;
}
```

- **Before the metered action**, call `getRemaining()`. `null` means the customer isn't subscribed to a plan with this unit. `0` or less means they've used their allowance, so do what you agreed with the user.
- **When you write an outbox row**, call `cache.decrement()` with `quantity × rate`, so the cache stays close between refreshes. If an action has meters for more than one unit, decrement each unit's balance.
- **Refresh the cache** when it's older than the TTL, when `usage_balance.depleted` arrives, and after a subscription renews or changes.
- **To show usage**, the allowance is `used.total` + `remaining.total`. Show `overage.total` separately.

## Step 7: Handle `usage_balance.depleted`

Subscribe your notification destination to `usage_balance.depleted`. It's only listed for accounts in early access.

The SDK's `EventName` enum doesn't include this event, so `unmarshal()` returns it as a generic event, with camelCase `data`. Compare the event type as a string before the `webhooks` skill's `switch`. Keep `processEvent`'s `EventEntity` parameter, so the `switch` still narrows the typed events:

```ts
// utils/paddle/process-webhook.ts
import { type EventEntity, EventName } from "@paddle/paddle-node-sdk";

export async function processEvent(event: EventEntity) {
  // Not in the SDK's EventName enum yet, so compare the string.
  const eventType: string = event.eventType;
  if (eventType === "usage_balance.depleted") {
    const data = event.data as unknown as {
      id: string;
      customerId: string;
      usageBalanceUnitId: string;
      balance: { remaining: { total: string } };
    };
    // No subscription ID in the payload: match on the customer and unit.
    // Keep this fast: update the cache and queue anything heavier.
    await markBalanceDepleted(data.customerId, data.usageBalanceUnitId); // your function
    return;
  }

  switch (event.eventType) {
    // ...cases from the webhooks skill
    default:
      return;
  }
}
```

- **It doesn't occur when usage expires** at the end of a billing period.
- **It can occur again** after a renewal or plan change grants more usage and the customer runs out again. Dedupe on `event.eventId`.
- **There's no "replenished" event.** When `subscription.updated` arrives for a renewal or plan change, queue a job to refresh the cached balance. Paddle grants the new allowance in the background too.

## Renewals and plan changes

| When                            | What happens to the usage balance                                                                                                             |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Subscription renews             | Unused usage expires. Paddle grants the full allowance for the new period and clears overage.                                                 |
| Customer upgrades or downgrades | The old allowance expires and the new price's full allowance is granted straight away, with no proration. Overage carries over until renewal. |
| Quantity changes                | Paddle grants the allowance again for the new quantity.                                                                                       |
| Subscription is canceled        | When the cancellation takes effect, that subscription's unused usage expires. Further usage is recorded as overage.                           |
| Subscription is paused          | The balance doesn't change, and Paddle still records usage.                                                                                   |
| Subscription resumes            | Resuming with a new billing period grants the full allowance. Continuing the existing period doesn't change the balance.                      |
| Customer gets a refund          | The balance doesn't change.                                                                                                                   |

**This overrides `subscription-update`'s proration defaults.** Before choosing `prorationBillingMode`, check whether any item's price has `allowances` (get it with this skill's API helper, since the SDK leaves the field out). If it does, prorated modes are rejected (`subscription_prorated_billing_not_allowed_for_allowance`):

- **Upgrades**: use `full_immediately`.
- **Downgrades**: use `full_next_billing_period`, and warn the customer that the change applies straight away, so they lose what's left of their current allowance.

## Early access (beta) limitations

Not available during early access (beta), so don't build for them: trials, one-time prices, or manually-collected subscriptions with allowances; top-ups; overage billing; rollover or custom expiry; webhooks for other thresholds, like 80% used; and usage reports. To warn customers before they run out, compare `remaining.total` with the allowance in your app.

## Common pitfalls

- **A typo in `action`.** Paddle accepts events for actions that don't match a meter, but they don't draw down any balance, and there's no error. Keep actions in `usage-config.ts`, and check them against `GET /meters`.
- **Regenerating `occurred_at` on retry.** Paddle counts the retry as new usage, so the same usage draws down the balance twice. Don't do it to get a `usage_event_timestamp_too_old` rejection accepted either.
- **Treating `202` as "balance updated."** It means Paddle accepted the event. The drawdown happens shortly after.
- **Reading allowances through the SDK.** The SDK's `Price` objects don't include `allowances`, so a correct price looks like it has none. Use the API helper.

## Verify the integration

1. Run the access check from Step 2 and confirm `GET /meters` succeeds.
2. In a sandbox account, create a unit, a meter, and a price with an allowance of `"3"`, so it's quick to use up. Complete a checkout with a test card (see `sandbox-testing`).
3. Confirm the job from Step 4 finds the usage balance, with `remaining.total` of `"3"` and `used.total` of `"0"`.
4. Record one event with `quantity: "1"`. After a few seconds, confirm `remaining.total` is `"2"`.
5. Send the same row again, with the same `event_key` and `occurred_at`. Confirm `remaining.total` doesn't change.
6. Record two more events. Confirm `usage_balance.depleted` arrives at your webhook endpoint and your app applies what you agreed for zero.
7. Record one more event. Confirm `remaining.total` stays `"0"` and `overage.total` is `"1"`.

## Related docs

- [Set up usage-based billing](https://developer.paddle.com/build/usage-based-billing.md) — the end-to-end tutorial, early access limitations, and the form to apply for access.
- [Meters](https://developer.paddle.com/api-reference/meters), [Usage balance units](https://developer.paddle.com/api-reference/usage-balance-units), [Usage balances](https://developer.paddle.com/api-reference/usage-balances), and [Usage events](https://developer.paddle.com/api-reference/usage-events) — API reference.
- [`usage_balance.depleted`](https://developer.paddle.com/webhooks/usage-balances/usage-balance-depleted) — webhook reference.
- [API key permissions](https://developer.paddle.com/api-reference/about/permissions.md)
- [Rate limiting](https://developer.paddle.com/api-reference/about/rate-limiting.md)
- [Signature verification](https://developer.paddle.com/webhooks/about/signature-verification.md)
- [Notification destinations](https://developer.paddle.com/webhooks/about/notification-destinations.md)
