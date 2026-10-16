---
name: paddle-billing-history
description: Render the authenticated user's billing history in Next.js — listing transactions via the Paddle Node SDK, the mandatory customer-id filter, pagination via `.next()`/`.hasMore`, status filtering, on-demand invoice PDF links, and formatting raw transaction totals (lowest-unit conversion + Intl.NumberFormat, with the zero-decimal currency special case for JPY/KRW/VND/CLP).
---

# Render the user's billing history in Next.js

## When to use this skill

Use this skill when adding a "Billing history" or "Invoices" section to the authenticated user's account page. The user expects to see their past transactions with dates, amounts, and the ability to download invoices. This skill covers a Next.js 15 (App Router) Server Action that lists transactions for the authenticated customer with proper pagination, status filtering, and currency display.

This is the _read_ side of transaction data. Pair it with:

- `subscription-sync` — provides the `customers` table you join on to find the user's Paddle `customer_id`.
- `webhooks` — populates the `customers` table from `customer.created` events.
- `customer-portal` — an alternative if you want Paddle to host the entire billing UI (see "Should you build this yourself?" below).

## Should you build this yourself?

The Paddle customer portal already provides a hosted billing-history view (see `customer-portal`). Build your own when:

- You want the billing surface to live inside your dashboard, with consistent navigation and styling.
- You want to combine billing data with app-specific context (e.g. usage details, custom invoice fields).
- You want to control what gets shown — the portal shows everything; a custom view can omit, group, or relabel transactions for your audience.

If none of those apply, send users to the portal and skip this skill.

## Prerequisites

- A Paddle account with at least one customer that has transactions (sandbox is fine).
- Server-side `PADDLE_API_KEY` with the `transaction.read` permission, which covers listing transactions and fetching invoice PDFs. These actions run as Server Actions, never in the browser.
- A `customers` table mirrored from webhooks (see `subscription-sync`). You'll look up the authenticated user's Paddle `customer_id` here via the email bridge.
- An auth system. Examples use Supabase.

```bash
NEXT_PUBLIC_PADDLE_ENV=sandbox             # or "production"
PADDLE_API_KEY=pdl_sdbx_apikey_...

NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...              # or SUPABASE_SECRET_KEY (new opaque sb_secret_*)
```

### Supabase helpers

The examples import two server-side helpers that match the [Paddle Next.js starter kit](https://github.com/PaddleHQ/paddle-nextjs-starter-kit). If the project already has equivalents, use those. If you write your own, don't name the wrapper `createServerClient` — that's the `@supabase/ssr` function it wraps.

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

Import it as `{ createClient as createAdminClient }`. The service-role client bypasses RLS, so only use it on the server, after you've checked who the user is. It deliberately skips cookies, so it never picks up a signed-in user's session.

## How `paddle.transactions.list` works

```ts
const collection = paddle.transactions.list({
  customerId: ["ctm_01h..."], // REQUIRED — without this, returns ALL transactions
  status: ["billed", "paid", "past_due", "completed", "canceled"],
  perPage: 10, // default and maximum: 30
  after: undefined, // cursor for "load more"
});

const items = await collection.next(); // one page
const more = collection.hasMore; // boolean — drive "Load more" from this
const total = collection.estimatedTotal; // exact up to 100,000; 100001 above that; -1 if not counted
```

A few things to internalize:

- **`paddle.transactions.list(...)` returns a `TransactionCollection`, not an array.** You call `.next()` to get one page. Treating the collection like an array (or assuming it's fully populated) gets you nothing or stale data.
- **The `customerId` filter is mandatory in practice.** The API doesn't _require_ it (you can list all transactions in your account without one — useful for admin views), but for a _customer-facing_ page, omitting it leaks every customer's history to whoever's logged in. Always pass it.
- **Status filter: string literals.** `TransactionStatus` is a type-only union in the Node SDK, not an enum with members — pass string literals like `"completed"`, typed as `TransactionStatus[]` if you like. The skill covers what to include below.
- **Pagination is cursor-based.** Each call to `.next()` advances the cursor. If you want to support "Load more," surface the cursor (`after` from the last item, or use the SDK's built-in handling) and re-issue. Use `hasMore`, not `estimatedTotal`, to decide whether there's another page — `estimatedTotal` is capped at `100001` and can be `-1`.

## The full Server Action

```ts
// src/actions/billing-history.ts
"use server";

import { headers } from "next/headers";
import { ApiError, type TransactionStatus } from "@paddle/paddle-node-sdk";
import { getPaddleInstance } from "@/utils/paddle/get-paddle-instance";
import { createClient } from "@/utils/supabase/server";
import { createClient as createAdminClient } from "@/utils/supabase/server-internal";
import { getDecimalPlaces, parseMoney } from "@/utils/parse-money";

export type BillingHistoryItem = {
  id: string;
  billedAt: string | null;
  status: TransactionStatus;
  amount: string; // formatted grandTotal: what was charged, after credits
  tax: string; // formatted grandTotalTax: the tax within amount
  invoiceAvailable: boolean;
};

const VISIBLE_STATUSES: TransactionStatus[] = [
  "billed",
  "paid",
  "past_due",
  "completed",
  "canceled",
];

// Resolve the signed-in user's Paddle customer ID server-side. Never accept it
// from the client.
async function getSignedInCustomerId() {
  // 1. Authenticate. Reject anonymous requests before any DB or SDK call.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email) return { error: "Not authenticated" } as const;

  // 2. Look up the Paddle customer_id via the email bridge. No row means no
  //    Paddle customer yet — not an error, just nothing to show.
  const admin = await createAdminClient();
  const { data: customerRow } = await admin
    .from("customers")
    .select("customer_id")
    .eq("email", user.email)
    .single();

  return { customerId: (customerRow?.customer_id as string | undefined) ?? null };
}

export async function getBillingHistory(after?: string) {
  const customer = await getSignedInCustomerId();
  if ("error" in customer) return { error: customer.error };
  if (!customer.customerId) return { items: [], hasMore: false };

  // 3. Format for the user's locale. This runs on the server, where
  //    `navigator` (Node 21+) reports the server's locale, so read the
  //    browser's Accept-Language from the request instead.
  const format = {
    locale: (await headers()).get("accept-language")?.split(/[,;]/)[0] || "en-US",
    decimalPlaces: await getDecimalPlaces(),
  };

  try {
    // 4. List transactions, scoped to the authenticated customer. The
    //    customerId filter is the security guarantee — without it, the SDK
    //    returns every customer's transactions in your account.
    const collection = getPaddleInstance().transactions.list({
      customerId: [customer.customerId],
      status: VISIBLE_STATUSES,
      perPage: 10,
      after,
    });

    // 5. Fetch one page. Don't loop over hasMore — the UI will call this
    //    again with a cursor for "Load more."
    const transactions = await collection.next();

    // 6. Slim each transaction down to what the UI renders. Totals are
    //    strings in lowest currency units with no pre-formatted version, so
    //    format them here (see "Display: format the raw amount" below).
    const items: BillingHistoryItem[] = transactions.map((t) => {
      const totals = t.details?.totals;
      return {
        id: t.id,
        billedAt: t.billedAt,
        status: t.status,
        amount: parseMoney(totals?.grandTotal, t.currencyCode, format),
        tax: parseMoney(totals?.grandTotalTax, t.currencyCode, format),
        // Invoice PDFs exist for completed transactions, and for billed
        // manually-collected ones, but never for zero-value transactions.
        invoiceAvailable:
          Number(totals?.subtotal) > 0 &&
          (t.status === "completed" || (t.status === "billed" && t.collectionMode === "manual")),
      };
    });

    return { items, hasMore: collection.hasMore };
  } catch (error) {
    if (error instanceof ApiError) return { error: error.code };
    throw error;
  }
}
```

## Invoice PDFs — fetch on demand

Don't put invoice URLs in the list DTO. Each one costs an API call, and the URL expires after an hour. Expose a separate action that the UI calls when the user clicks **Invoice**, and check that the transaction belongs to the signed-in customer before fetching it — the ID comes from the client.

```ts
// src/actions/billing-history.ts (continued)
export async function getInvoiceUrl(transactionId: string) {
  const customer = await getSignedInCustomerId();
  if ("error" in customer) return { error: customer.error };
  if (!customer.customerId) return { error: "No Paddle customer" };

  try {
    const paddle = getPaddleInstance();
    const transaction = await paddle.transactions.get(transactionId);
    if (transaction.customerId !== customer.customerId) return { error: "Forbidden" };

    const { url } = await paddle.transactions.getInvoicePDF(transactionId, {
      disposition: "attachment", // or "inline" to open the PDF in the browser
    });
    return { url }; // valid for 1 hour
  } catch (error) {
    if (error instanceof ApiError) return { error: error.code };
    throw error;
  }
}
```

Invoice PDFs are available for:

- **Automatically-collected transactions** (checkout and subscription renewals) once they're `completed`.
- **Manually-collected transactions** (invoices) once they're `billed` or `completed`.

They're never available for zero-value transactions, such as the $0 transaction that starts a free trial.

## Status filter — what to include

`paddle.transactions.list` accepts a `status: TransactionStatus[]` filter of string literals. The values you'll typically pass for a billing-history view:

| Status      | Include in billing history? | Meaning                                                                                                                                                                                                           |
| ----------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `billed`    | Yes                         | An invoice has been issued but not paid yet. Billed transactions have an invoice number and are a legal record. Typical for manually-collected invoices.                                                          |
| `paid`      | Yes                         | Fully paid, but not yet processed by Paddle.                                                                                                                                                                      |
| `completed` | Yes                         | Fully paid and processed.                                                                                                                                                                                         |
| `past_due`  | Yes                         | Payment is overdue: an automatically-collected payment failed and the subscription is in dunning, or an invoice is still unpaid 24 hours after its due date. Show it so the user can update their payment method. |
| `canceled`  | Yes                         | Canceled. If it was an invoice, it's no longer due.                                                                                                                                                               |
| `draft`     | **No**                      | Missing required fields — typically a checkout before customer details are captured.                                                                                                                              |
| `ready`     | **No**                      | Has everything it needs, but hasn't been billed or paid.                                                                                                                                                          |

Excluding `draft` and `ready` is the important rule — they represent partial state that the customer shouldn't see.

If you omit the `status` filter entirely, the API returns all statuses including `draft` / `ready`. Don't.

## Display: format the raw amount yourself

Unlike Paddle.js's `PricePreview` (which exposes a pre-formatted string in `formattedTotals.total`), the **`Transaction` entity from the Node SDK does not** — only raw amounts in lowest currency units plus a currency code:

```ts
transaction.details?.totals?.grandTotal; // "3000"  (string, lowest unit)
transaction.currencyCode; // "USD"
```

### Which total to show

| Field           | What it is                                                                                    |
| --------------- | --------------------------------------------------------------------------------------------- |
| `total`         | After discounts and tax, before credits.                                                      |
| `credit`        | Credit applied to this transaction.                                                           |
| `grandTotal`    | `total` minus `credit` — what the customer was charged, or owes. **Show this as the amount.** |
| `grandTotalTax` | The tax within `grandTotal` (Node SDK 3.6.0+).                                                |
| `balance`       | `grandTotal` minus payments received — what's still due.                                      |

All totals are in the transaction's currency (`currencyCode`).

### Convert and format

You need to (a) convert from lowest unit to a number and (b) format it as currency. Two steps because step (a) depends on how many decimal places Paddle uses for the currency, which `Intl.NumberFormat` doesn't know.

```ts
// utils/parse-money.ts

// Paddle's zero-decimal currencies: "1200" JPY is ¥1,200, not ¥12.00. Used as a
// fallback when GET /currencies is unavailable.
const ZERO_DECIMAL_CURRENCIES = new Set(["JPY", "KRW", "VND", "CLP"]);

const PADDLE_API_URL =
  process.env.NEXT_PUBLIC_PADDLE_ENV === "production"
    ? "https://api.paddle.com"
    : "https://sandbox-api.paddle.com";

// GET /currencies is public (no API key) and returns decimal_places for every
// currency Paddle supports. It isn't in the Node SDK, so call it with fetch.
export async function getDecimalPlaces(): Promise<Record<string, number>> {
  try {
    const res = await fetch(`${PADDLE_API_URL}/currencies`, { next: { revalidate: 86400 } });
    const { data } = (await res.json()) as { data: { code: string; decimal_places: number }[] };
    return Object.fromEntries(data.map((c) => [c.code, c.decimal_places]));
  } catch {
    return {}; // fall back to ZERO_DECIMAL_CURRENCIES
  }
}

export function convertAmountFromLowestUnit(
  amount: string,
  currency: string,
  decimalPlaces?: number,
): number {
  const places = decimalPlaces ?? (ZERO_DECIMAL_CURRENCIES.has(currency) ? 0 : 2);
  return parseFloat(amount) / 10 ** places;
}

export function formatMoney(amount: number, currency: string, locale = "en-US"): string {
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency }).format(amount);
  } catch {
    // Malformed locale tag, e.g. from a bad Accept-Language header
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
  }
}

type MoneyFormat = { locale?: string; decimalPlaces?: Record<string, number> };

export function parseMoney(
  amount = "0",
  currency = "USD",
  { locale, decimalPlaces }: MoneyFormat = {},
): string {
  return formatMoney(
    convertAmountFromLowestUnit(amount, currency, decimalPlaces?.[currency]),
    currency,
    locale,
  );
}
```

The action above calls `parseMoney(totals?.grandTotal, t.currencyCode, format)`. The output is a locale-aware string like `"$30.00"`, `"€29,99"`, or `"¥1,200"` — currency symbol, separators, and decimal handling all sorted by `Intl.NumberFormat`. Tax is already included in `grandTotal`, and `grandTotalTax` breaks it out, so you don't add tax yourself — just convert and format.

### Common formatting traps

- **Skipping the zero-decimal currency branch.** Dividing JPY/KRW/VND/CLP by 100 turns ¥1,200 into ¥12. Paddle's zero-decimal currencies are JPY, KRW, VND, and CLP. Prefer `decimal_places` from `GET /currencies`, and keep a hardcoded set as the fallback.
- **Showing `total` as the amount charged.** `total` is before credits; `grandTotal` is what the customer was charged. Re-summing `lineItems` with your own tax math also diverges from the actual charge.
- **Reading `navigator.language` in a Server Action.** Node 21+ defines `navigator`, but it reports the server's locale, not the user's. Use the request's `Accept-Language` header (as above), or format on the client.
- **Confusing the Transaction shape with the PricePreview shape.** `Paddle.PricePreview()` (client-side, for pricing pages) returns `formattedTotals.total` already formatted — see `pricing-pages`. `Transaction` does not. Use the right pattern for each.

## Pagination — cursor pattern

The `.list(...)` collection uses cursor-based pagination. `after` is a transaction ID to start _after_. To support "Load more":

```tsx
// Client component
"use client";

import { useState } from "react";
import {
  getBillingHistory,
  getInvoiceUrl,
  type BillingHistoryItem,
} from "@/actions/billing-history";

type Props = { initialItems: BillingHistoryItem[]; initialHasMore: boolean };

export function BillingHistory({ initialItems, initialHasMore }: Props) {
  const [items, setItems] = useState(initialItems);
  const [hasMore, setHasMore] = useState(initialHasMore);

  async function loadMore() {
    const lastId = items[items.length - 1]?.id;
    const result = await getBillingHistory(lastId);
    if ("error" in result) return;
    setItems((prev) => [...prev, ...result.items]);
    setHasMore(result.hasMore);
  }

  async function downloadInvoice(transactionId: string) {
    const result = await getInvoiceUrl(transactionId);
    if (result.url) window.location.assign(result.url);
  }

  return (
    <>
      <ul>
        {items.map((item) => (
          <li key={item.id}>
            {item.billedAt} · {item.amount} · {item.status}
            {item.invoiceAvailable && (
              <button onClick={() => downloadInvoice(item.id)}>Invoice</button>
            )}
          </li>
        ))}
      </ul>
      {hasMore && <button onClick={loadMore}>Load more</button>}
    </>
  );
}
```

Don't loop `while (collection.hasMore)` server-side — it'll fetch the customer's entire transaction history into memory and might rate-limit you. Pagination is a _user-driven_ operation.

## Common pitfalls

- **Calling `paddle.transactions.list({})` without a `customerId` filter** in a customer-facing action. Returns transactions for every customer in your account. The filter is the security guarantee.
- **Trusting a `customerId` from the action input.** As with the cancel/update/portal actions, the `customerId` must be resolved server-side from the authenticated user's record. Never accept it as a parameter.
- **Treating the `TransactionCollection` as an array.** It's an iterator that fetches lazily via `.next()`. `collection.length` is undefined; `collection.map(...)` doesn't exist.
- **Eager-loading all pages.** A `while (collection.hasMore) { items.push(...await collection.next()) }` loop sounds reasonable but produces unbounded responses. For a customer with hundreds of transactions, this hits memory limits and Paddle rate limits.
- **Forgetting the zero-decimal currency branch when converting amounts.** `parseFloat(amount) / 100` is correct for USD/EUR/GBP/etc. but turns ¥1,200 / ₩1,200 / ₫12,000 / CLP$1,200 into a 100x-too-small number (because those currencies have no minor units; the raw value is already the whole-unit amount). The currencies Paddle treats as zero-decimal are **JPY**, **KRW**, **VND**, and **CLP**. Use `decimal_places` from `GET /currencies`, with a hardcoded fallback — see the `convertAmountFromLowestUnit` helper above.
- **Summing line items manually instead of using `details.totals.grandTotal`.** Paddle's totals already account for line-item subtotals, discounts, tax, and credits. Re-summing yourself with your own tax math will diverge from the actual charge amount and confuse customers comparing the UI to their bank statements.
- **Reaching for `formattedTotals` on a Transaction.** That field exists on Paddle.js `PricePreview` results (the pricing-page world), but not on the Node SDK's `Transaction` entity. Reading `t.details.totals.formattedTotals.total` returns `undefined`. Use `details.totals.grandTotal` + `currencyCode` and format yourself.
- **Including `draft` or `ready` in the status filter.** Those are internal in-flight states, not customer-facing data. Exclude them.
- **Returning the raw `Transaction` SDK object.** It includes line items, customer addresses, business records, and a lot of internal Paddle metadata. Slim to a DTO with what your UI actually needs (id, date, status, formatted amount, whether an invoice is available).
- **Precomputing invoice URLs in the list.** Each costs an API call and expires after an hour. Fetch one when the user clicks, after checking the transaction belongs to them.
- **Going beyond `parseFloat` + `Intl.NumberFormat` with custom math on amounts.** A `parseFloat(amount) / 100` is the canonical lowest-unit conversion (with the zero-decimal handling above). What you should NOT do is layer additional rounding (`Math.round`, `Math.floor`, `Math.ceil`, `toFixed`) or recalculate the total — those introduce off-by-one and currency-rounding bugs. `Intl.NumberFormat` already handles locale-appropriate decimal places. Compute as little as possible; let Paddle's totals and Intl's formatter do the work.

## Verify the integration

1. Sign in as a user with at least one completed sandbox transaction.
2. Call `getBillingHistory()`. You should get `{ items: [...], hasMore: false (or true) }`.
3. Verify the formatted amount in the response matches the grand total shown in the Paddle dashboard for that transaction (currency, amount, tax handling).
4. Sign in as a user who has no Paddle customer record yet. The action should return `{ items: [], hasMore: false }` without error.
5. Try the action while logged out. Should return `{ error: 'Not authenticated' }`.
6. **Critical:** create a sandbox transaction belonging to a _different_ customer (or use the dashboard to inspect another customer's transactions). Confirm those transactions do NOT appear in the response — the `customerId` filter must scope correctly. Then call `getInvoiceUrl` with one of that customer's transaction IDs — it must return `{ error: 'Forbidden' }`.
7. If your account has more than 10 transactions, confirm `hasMore: true` and that calling `getBillingHistory(lastId)` advances the cursor.
8. Click **Invoice** on a completed transaction. The PDF should download.

## Related docs

- [List transactions - API reference](https://developer.paddle.com/api-reference/transactions/list-transactions.md)
- [Get a PDF invoice for a transaction](https://developer.paddle.com/api-reference/transactions/get-transaction-invoice.md) — what `getInvoiceUrl` calls
- [List currencies](https://developer.paddle.com/api-reference/currencies/list-currencies.md) — `decimal_places` for each currency
- [List subscription history](https://developer.paddle.com/api-reference/subscription-history/list-subscription-history.md) — to show what changed on a subscription over time (plan changes, cancellations, payment method updates). Needs `subscription_history.read`. It isn't in the Node SDK yet, so call the API directly; the Paddle MCP exposes it as `client.subscriptions.history.list`.
- Reference implementation: [paddle-nextjs-starter-kit](https://github.com/PaddleHQ/paddle-nextjs-starter-kit) — see `src/utils/paddle/get-transactions.ts` and `src/app/dashboard/payments/[subscriptionId]/`.
