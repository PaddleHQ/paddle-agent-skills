---
name: paddle-subscription-update
description: Change a Paddle subscription's plan from a Next.js Server Action — auth, ownership check, `prorationBillingMode`, items-array replace semantics, preview-before-commit, and `on_payment_failure` handling.
---

# Update a Paddle subscription's plan from Next.js

## When to use this skill

Use this skill when building "Upgrade plan," "Switch tier," or "Change subscription" actions in your authenticated user's billing UI. It covers a Next.js 15 (App Router) Server Action that calls `paddle.subscriptions.update()`, the five `prorationBillingMode` choices and when to pick each, the _replace not append_ semantics of the items array, and the security checks every plan-change action needs.

This is the _initiating_ side of subscription changes. Pair it with:

- `subscription-sync` — your webhook handler will get a `subscription.updated` event after the change. Your DB mirror picks up the new plan, status, and pricing.
- `subscription-cancel` — same auth/ownership shape; if you're building both, share the helpers.

## Prerequisites

- A Paddle account with **at least two prices** the user can switch between (e.g. monthly Starter and monthly Pro). Sandbox is fine.
- Server-side `PADDLE_API_KEY` available — Server Action only. The key needs the `subscription.write` permission (for `update` and `activate`). `previewUpdate` only needs `subscription.read`, which `write` includes.
- Customer + subscription state mirrored from webhooks (see `subscription-sync`).
- An auth system. Examples use Supabase.

```bash
NEXT_PUBLIC_PADDLE_ENV=sandbox             # or "production"
PADDLE_API_KEY=pdl_sdbx_apikey_...

NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...              # or SUPABASE_SECRET_KEY (new opaque sb_secret_*)
```

### Supabase helpers

The action uses two server-side Supabase clients. These match the [Paddle Next.js starter kit](https://github.com/PaddleHQ/paddle-nextjs-starter-kit); if your project already has equivalent helpers, use those instead.

```ts
// src/utils/supabase/server.ts — the signed-in user's session (anon key + cookies)
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Called from a Server Component. Safe to ignore if middleware refreshes sessions.
          }
        },
      },
    },
  );
}
```

```ts
// src/utils/supabase/server-internal.ts — service role, no user session. Server-only.
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

The service-role client bypasses RLS, so only use it on the server, after you've checked who the user is. It deliberately skips cookies, so it never picks up a signed-in user's session. If you write your own helpers, don't name the wrapper `createServerClient` — that's the `@supabase/ssr` function it calls.

## Choose your `prorationBillingMode`

This is the one parameter most people get wrong. Paddle's `subscriptions.update` accepts five values; for a typical "Upgrade to Pro" flow on an active subscription the right choice is **`prorated_immediately`**.

| Value                          | What happens                                                                                                                         | When to use                                                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `prorated_immediately`         | Bill the prorated difference between old and new plan **now** (a downgrade produces a credit instead). Switch effective immediately. | "Upgrade plan" — user expects access to the new plan + a charge now.                                                                |
| `prorated_next_billing_period` | Calculate the prorated amount but bill it on the next renewal. Plan switch is immediate.                                             | "Switch plan, but bill me later" — rare, but legitimate.                                                                            |
| `full_immediately`             | Charge the **full new-plan price** now. Plan switch is immediate.                                                                    | Not often. Over-charges the user for a partial period.                                                                              |
| `full_next_billing_period`     | Added items are charged in full at renewal; removed items get no credit. Plan switch is immediate.                                   | Rare. It isn't a free trial of the new plan — the full charge is only deferred.                                                     |
| `do_not_bill`                  | Switch plans now. Don't bill anything.                                                                                               | Required for `trialing` and `paused` subscriptions. Otherwise internal/team upgrades and customer service comps, not self-serve UX. |

There is no default. You must pass one of the five values. Whichever you pick, the new items replace the old ones **immediately** — the mode only decides what's billed and when.

## Upgrade, downgrade, or term change?

`subscriptions.update` is one endpoint covering several distinct user-visible flows. The right `prorationBillingMode` depends on which:

| Flow                       | Example                   | Typical `prorationBillingMode`                                                                                                                                                                                                                 |
| -------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Tier upgrade**           | Starter → Pro (same term) | `prorated_immediately` — user expects the better plan now and pays the difference now.                                                                                                                                                         |
| **Tier downgrade**         | Pro → Starter (same term) | `prorated_immediately` or `prorated_next_billing_period`. Starter replaces Pro now in both. Unused Pro time becomes a **credit, never a card refund** — applied now (any excess goes to the customer's credit balance) or at the next renewal. |
| **Term switch (longer)**   | Pro monthly → Pro annual  | `prorated_immediately` — annual is a much larger payment; charging now is correct.                                                                                                                                                             |
| **Term switch (shorter)**  | Pro annual → Pro monthly  | `prorated_immediately` — interval changes don't accept `*_next_billing_period`. Unused annual time is credited against the new plan, with any excess going to the customer's credit balance, not back to the card.                             |
| **Plan change in a trial** | Starter trial → Pro trial | `do_not_bill` — the only mode a `trialing` subscription accepts for item changes, paid trials included. To charge now, end the trial first with `paddle.subscriptions.activate(subscriptionId)`.                                               |

### Same-billing-interval rule for items

A subscription's items must all share the same billing interval. So if the user has a **Pro monthly** plan **plus a monthly addon** and switches to **Pro annual**, the addon must also become annual at the same time — it cannot stay monthly. Practically:

- If you sell tier + addons, your `items` array on the update must include the new addon price IDs that match the new term.
- If you sell tier-only, this doesn't affect you.

This is a constraint on what you submit to the SDK, not just a UX consideration. The API rejects mixed-interval `items` arrays.

Changing the interval has two more rules: you must replace **every** item, and `prorationBillingMode` must be `prorated_immediately`, `full_immediately`, or `do_not_bill` (only `do_not_bill` while trialing). Breaking any of these rules returns `subscription_new_items_not_valid`; the `errors` array on the error says which rule failed.

## Check the subscription's status

What `subscriptions.update` accepts depends on the subscription's current `status`:

| Status     | What `update` accepts                                                                                                                                                                                                                                                               |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `active`   | Everything in this skill.                                                                                                                                                                                                                                                           |
| `trialing` | Item changes with `do_not_bill` only, paid trials included (otherwise `subscription_trialing_items_update_invalid_options`). To end the trial and charge now, call `paddle.subscriptions.activate(subscriptionId)` first; it needs automatic collection and a saved payment method. |
| `past_due` | Only `{ scheduledChange: null }`, which removes a scheduled change. Anything else returns `subscription_update_when_past_due` — ask the user to update their payment method first.                                                                                                  |
| `paused`   | Item changes only, with `do_not_bill`.                                                                                                                                                                                                                                              |
| `canceled` | Nothing (`subscription_update_when_canceled`). The user needs a new checkout.                                                                                                                                                                                                       |

Also plan for:

- **The renewal lock.** Within 30 minutes of the next renewal, updates return 409 `subscription_locked_renewal`. Ask the user to try again after the renewal.
- **Rate limits.** Changes that charge immediately can return 429. Back off and retry later.
- **Scheduled changes.** If the subscription has a scheduled cancel, pause, or resume, `*_next_billing_period` modes fail with `subscription_invalid_billing_mode_for_scheduled_change`.

## Preview before committing

For non-trivial flows — especially term changes, anything where the prorated amount isn't obvious, or anything you're going to ask the user to confirm — show the preview before committing. Paddle's `subscriptions.previewUpdate` takes the same request body as `update` but doesn't apply anything:

```ts
const preview = await paddle.subscriptions.previewUpdate(subscriptionId, {
  items: [{ priceId: newPriceId, quantity: 1 }],
  prorationBillingMode: "prorated_immediately",
});

// preview.immediateTransaction        — the prorated charge details (if any)
// preview.recurringTransactionDetails — the new ongoing price
// preview.nextBilledAt                — when the next renewal will hit
// preview.updateSummary               — credit, charge, and the net result of the change
```

Render those numbers on a confirm screen ("You'll be charged $X today, then $Y/year starting <date>"). For a one-line confirmation, use `preview.updateSummary.result`: `action` is `"charge"` or `"credit"`, and `amount` is the net amount in `currencyCode` (a string in the currency's lowest unit). When the user confirms, run the same body through `subscriptions.update`. **Don't try to compute the prorated amount yourself** — the preview is the source of truth, and the math accounts for tax, currency, and existing credit balances you may not be aware of.

For simple "Upgrade to Pro" flows where the price difference is small and obvious, you can skip the preview and trust the user to know what they're agreeing to from the button label. For everything else, the preview pays for itself in support tickets you don't get.

## How `paddle.subscriptions.update` handles items

The `items` field on the update is a **full replacement** of the subscription's line items, not an append:

```ts
// BEFORE: subscription has items: [{ priceId: 'pri_starter_monthly', quantity: 1 }]

await paddle.subscriptions.update(subscriptionId, {
  items: [{ priceId: "pri_pro_monthly", quantity: 1 }],
  prorationBillingMode: "prorated_immediately",
});

// AFTER: subscription has items: [{ priceId: 'pri_pro_monthly', quantity: 1 }]
//        the Starter item is gone — replaced by Pro.
```

For a single-item plan change, that's exactly what you want. **Do not** fetch the existing items and concat the new one — you'd end up with a subscription that's billed for both plans simultaneously.

For multi-item subscriptions (a base plan + addons), you do need to think about which items you're keeping. In that case, fetch the current subscription, modify the items array carefully, and pass the modified array back.

## The full Server Action

```ts
// src/actions/subscription.ts
"use server";

import { revalidatePath } from "next/cache";
import { ApiError } from "@paddle/paddle-node-sdk";
import { getPaddleInstance } from "@/utils/paddle/get-paddle-instance";
import { createClient } from "@/utils/supabase/server";
import { createClient as createAdminClient } from "@/utils/supabase/server-internal";

// Messages for the Paddle API errors this action expects to see.
const UPDATE_ERRORS: Record<string, string> = {
  subscription_payment_declined: "Your payment was declined. Update your payment method and retry.",
  subscription_locked_renewal: "Your subscription is about to renew. Try again after it renews.",
  subscription_update_when_past_due: "Update your payment method before changing plan.",
};

export async function updateSubscription(subscriptionId: string, newPriceId: string) {
  // 1. Authenticate. Reject anonymous requests before any DB query or SDK call.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !user.email) {
    return { error: "Not authenticated" };
  }

  // 2. Verify the authenticated user owns this subscriptionId. Same email-bridge
  //    pattern as subscription-cancel.
  const admin = await createAdminClient();

  const { data: customerRow } = await admin
    .from("customers")
    .select("customer_id")
    .eq("email", user.email)
    .single();
  if (!customerRow) return { error: "No Paddle customer" };

  const { data: subRow } = await admin
    .from("subscriptions")
    .select("customer_id, subscription_status")
    .eq("subscription_id", subscriptionId)
    .single();
  if (!subRow || subRow.customer_id !== customerRow.customer_id) {
    return { error: "Forbidden" };
  }

  // 3. Apply the plan change. Replace items with the single new item. Trialing
  //    subscriptions (paid trials too) only accept `do_not_bill`; otherwise bill
  //    the prorated difference now (the right call for an "Upgrade" button).
  //    The default behaviour on payment failure is `prevent_change` — the
  //    upgrade only applies if the prorated charge succeeds. That's the safe
  //    choice for self-serve. See "Handling payment failure" below for when
  //    'apply_change' is the right override.
  const prorationBillingMode =
    subRow.subscription_status === "trialing" ? "do_not_bill" : "prorated_immediately";

  try {
    const paddle = getPaddleInstance();
    const subscription = await paddle.subscriptions.update(subscriptionId, {
      items: [{ priceId: newPriceId, quantity: 1 }],
      prorationBillingMode,
    });

    // 4. Refresh cached UI.
    revalidatePath("/dashboard/subscriptions");

    // 5. Slim DTO — don't leak the raw Subscription.
    return {
      success: true,
      priceId: subscription.items[0]?.price?.id ?? null,
      status: subscription.status,
    };
  } catch (error) {
    // 6. Turn Paddle API errors into a message the UI can show; rethrow anything else.
    if (error instanceof ApiError) {
      return { error: UPDATE_ERRORS[error.code] ?? "Couldn't change your plan. Please try again." };
    }
    throw error;
  }
}
```

## What the user sees vs what gets billed

A `prorated_immediately` upgrade triggers Paddle to:

1. Generate a **transaction** for the prorated difference between the old and new plan, billed against the customer's existing payment method.
2. Send a `transaction.created` (then `transaction.completed` if the charge succeeds, or `transaction.payment_failed` if it doesn't).
3. Send a `subscription.updated` reflecting the new items and `next_billed_at` recalculated for the new plan.

If the prorated charge **fails** (declined card, expired method), what happens depends on `onPaymentFailure` — see the next section.

## Handling payment failure

When you pick an immediate proration mode (`prorated_immediately` or `full_immediately`), Paddle attempts to charge the customer **synchronously** during the update call. If that charge fails, the `onPaymentFailure` field decides whether the plan change still applies:

| Value                      | What happens on payment failure                                                                                                                                                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prevent_change` (default) | The plan change is **not applied**. The subscription stays on its old plan. The API returns `subscription_payment_declined` so the UI can surface a clear "payment failed, please retry" state.                                                                     |
| `apply_change`             | The plan change **is applied** anyway. The subscription stays `active`; only the transaction is left `past_due`, so you can collect the prorated amount later. The _subscription itself_ doesn't enter dunning — because the user explicitly accepted this outcome. |

Pick based on the flow:

- **Default `prevent_change`** is appropriate for most self-serve UX: the user clicks Upgrade, the card declines, they see "Payment failed" and can update their card and retry. Every step is explicit. You don't need to set it explicitly — leaving it out gives you this behaviour.
- **`apply_change`** is appropriate for admin-driven flows (a CS rep upgrading a customer whose card is temporarily failing) or for "switch tier first, collect later" patterns. The customer immediately gets the new plan; you collect the past-due transaction asynchronously. **Don't pick this without thinking about your collections process** — you've effectively extended credit.

For the admin-driven case, set `onPaymentFailure` explicitly:

```ts
// Admin-driven upgrade: apply the change even if the card fails. The customer
// gets the new plan; the prorated charge sits in past_due until you collect.
await paddle.subscriptions.update(subscriptionId, {
  items: [{ priceId: newPriceId, quantity: 1 }],
  prorationBillingMode: "prorated_immediately",
  onPaymentFailure: "apply_change",
});
```

The Node SDK uses camelCase (`onPaymentFailure`); the wire format is `on_payment_failure`.

## Common pitfalls

- **Wrong `prorationBillingMode`.** The defaults table is the heart of this skill. `do_not_bill` for a self-serve upgrade on an active subscription is a billing-accounting hole; `full_immediately` overcharges; `prorated_next_billing_period` surprises users who expected a charge. For "Upgrade to Pro" UX on an active subscription, **use `prorated_immediately`**. Trialing and paused subscriptions are the exception: they only accept `do_not_bill`.
- **Appending instead of replacing items.** Pulling `subscription.items` from the mirror, concatenating the new item, and sending the combined array results in a subscription billed for two plans. The endpoint replaces — pass only what you want.
- **No ownership check.** Same as `subscription-cancel`: trusting the `subscriptionId` input lets any authenticated user upgrade any subscription's plan.
- **No auth check.** Server Actions are callable from anywhere — anonymous, scripted, or via direct POST. Always verify the session.
- **Optimistic UI based on the action's return with `apply_change`.** With the default `prevent_change`, `{ success: true }` from an immediate mode means the prorated charge went through. With `apply_change`, it only means the plan changed — the charge may be sitting in `past_due`. Wait for `transaction.completed` (via webhook) before granting features that depend on payment success.
- **Missing `revalidatePath`.** UI shows the old plan until manual refresh.
- **Returning the raw `Subscription`.** Same as cancel — the SDK's instance is large; slim it.
- **Skipping the preview step on a non-trivial change.** For term changes especially, the prorated calculation isn't obvious — Paddle may credit existing balances, apply tax, or convert currency in ways your back-of-envelope estimate misses. Showing the user a confirm screen with the actual numbers from `previewUpdate` before they commit avoids "wait, why was I charged this much?" tickets. Skip the preview only when the price impact is small and obvious.
- **Not knowing `onPaymentFailure` exists.** The default (`prevent_change`) is correct for self-serve and you don't need to override it. The trap is _not realizing the option exists_ when you have a flow where you do need `apply_change` — e.g. a CS rep upgrading a customer with a temporarily-failing card. If you don't know the field is there, you'll work around the limitation in clumsier ways.
- **Mixed billing intervals on items.** If you sell tier + addons and let users switch between monthly and annual, the addons must move with the tier. Submitting `[{ priceId: 'pri_pro_annual' }, { priceId: 'pri_addon_monthly' }]` will fail — Paddle rejects mixed-interval `items` arrays. When designing your "switch term" flow, plan for swapping addon price IDs alongside the tier.
- **Expecting a refund on downgrade.** No mode refunds the card. Unused time on the old plan becomes credit — applied now with `prorated_immediately` (any excess goes to the customer's credit balance) or at renewal with `prorated_next_billing_period`. And the items switch immediately in every mode: `*_next_billing_period` defers the charge, not the plan change.

## Verify the integration

1. Have a sandbox subscription on the cheaper of two plans (e.g. Starter monthly).
2. Call `paddle.subscriptions.previewUpdate` with the upgrade body. Confirm the returned numbers (immediate transaction, recurring details, next-billed-at, update summary) match what you'd expect.
3. Click "Upgrade to Pro." The action should return `{ success: true, priceId: 'pri_pro_monthly', status: 'active' }`.
4. In the Paddle dashboard:
   - Subscription's items are now Pro only (Starter is gone).
   - A new transaction with the prorated difference appears, and matches the preview from step 2.
5. Check your DB mirror after the `subscription.updated` webhook fires: the row has the new `price_id` and `product_id`.
6. Switch your sandbox card to a [test card that declines](https://developer.paddle.com/sdks/sandbox#test-cards) and retry the upgrade. With `onPaymentFailure: 'prevent_change'`, confirm the subscription stays on the old plan and your action returns the declined-payment error. Switch to `onPaymentFailure: 'apply_change'` and confirm the subscription flips to the new plan, stays `active`, and a `past_due` transaction appears.
7. On a trialing subscription, confirm your action sends `do_not_bill` and the change applies without a charge.
8. Try the action with a `newPriceId` you don't actually offer. Confirm Paddle rejects it (or — better — your action validates the `newPriceId` against your `PricingTier` constant before calling the SDK).
9. Try the action while logged out, or with a forged `subscriptionId` belonging to a different user. Confirm both are rejected before the SDK is called.

## Related docs

- [Upgrade or downgrade a subscription](https://developer.paddle.com/build/subscriptions/replace-products-prices-upgrade-downgrade.md)
- [Proration billing modes](https://developer.paddle.com/concepts/subscriptions/proration.md)
- [Update a subscription - API](https://developer.paddle.com/api-reference/subscriptions/update-subscription.md)
- [Preview an update to a subscription - API](https://developer.paddle.com/api-reference/subscriptions/preview-subscription-update.md)
- [Activate a trialing subscription - API](https://developer.paddle.com/api-reference/subscriptions/activate-subscription.md)
