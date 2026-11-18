---
name: paddle-migrate-lemon-squeezy
description: Move a Lemon Squeezy integration to Paddle Billing — audit the codebase, inventory the store read-only, map variants to Paddle products and prices, map webhooks and custom data, rebuild license keys, and prepare the subscriber file for a Paddle-assisted migration.
---

# Migrate from Lemon Squeezy to Paddle

## When to use this skill

Use this skill when an app sells through Lemon Squeezy and the user wants to move it to Paddle Billing. It covers the code and data side of the move: finding every Lemon Squeezy touchpoint, reading the store through the Lemon Squeezy API, proposing a Paddle catalog, mapping webhooks and custom data, rebuilding license key delivery, and preparing the file of active subscribers for a Paddle-assisted migration.

The guide [Migrate from Lemon Squeezy to Paddle](https://developer.paddle.com/migrate/other-platforms/lemon-squeezy.md) is the reference for the migration paths and the cutover order. Follow it; don't re-derive it.

Pair with:

- `catalog-setup` — creates the Paddle products and prices this skill proposes (Step 3).
- `checkout-web` — replaces Lemon.js and checkout links (Step 4).
- `webhooks` and `subscription-sync` — the endpoint and database mirror that replace the Lemon Squeezy handlers (Step 4). This skill adds Lemon Squeezy ID columns to the `subscription-sync` schema.
- `subscription-update` and `subscription-cancel` — replace plan changes and cancellations made through the Lemon Squeezy API.
- `customer-portal` — replaces the signed `urls.customer_portal` and `urls.update_payment_method` links.
- `usage-based-billing` — if any variant is usage-based.
- `sandbox-testing` — tests everything before cutover.

## Read this first

- **Deadline.** Lemon Squeezy stops processing transactions, including renewals, on March 31, 2027. Step 2 reads the Lemon Squeezy API, so run it, and export anything else the user needs, before then. Step 1 works on the codebase alone, and Step 6 works from Step 2's output.
- **What this skill can't do.** It never moves saved payment details. Paddle-assisted migration is for eligible stores: the user requests it, and a migration specialist confirms eligibility and arranges the transfer of card details, as the guide describes. Subscriptions not paid by card, such as PayPal or Cash App Pay, can't be transferred, and neither can rows the specialist turns down: those customers complete a new Paddle checkout, then the user cancels their Lemon Squeezy subscription.
- **Read-only against Lemon Squeezy.** Every call to the Lemon Squeezy API in this skill is a `GET`. Don't cancel, update, or delete anything there; cancellation after cutover is the user's decision, made per the guide.
- **Never print the Lemon Squeezy API key.** Read it from `LEMON_SQUEEZY_API_KEY`, never log it, never write it to a file, and never ask the user to paste it into the chat.
- **Not run against a live store.** The scripts match the Lemon Squeezy [API reference](https://docs.lemonsqueezy.com/api) as of November 2026, but they haven't been run against a real store. If a request fails, or a field is missing or `null` where a script expects a value, read that object's page in the API reference, fix the type and the script to match, and tell the user what differed. Don't guess at field names, and don't drop rows silently: anything a script can't place goes in `needs-fixing.txt`.

## Decide with the user first

Agree on these before changing anything. **Do not guess.**

1. **Migration path.** Paddle-assisted (card subscriptions imported by Paddle, for eligible stores; a specialist confirms eligibility when they review the user's request), customer-led (customers subscribe again through a Paddle checkout), or both. See the guide's "Choose your migration path". The path decides whether Step 6 is needed, and a store that doesn't qualify moves every subscription through the customer-led path.
2. **Which store.** A Lemon Squeezy API key covers every store in the account. If there's more than one, agree which store moves and set `LEMON_SQUEEZY_STORE_ID`; the catalog proposal and the subscriber file then cover that store only.
3. **Catalog shape.** Confirm the mapping rules in Step 2 before anything is created: which variants become prices on one product, which become separate products, and what to do with pay-what-you-want and usage-based variants.
4. **Custom data keys.** Lemon Squeezy code usually passes `checkout[custom][user_id]`. Default to `userId`, which `subscription-sync` reads, plus `lemonSqueezySubscriptionId`, `lemonSqueezyCustomerId`, and `lemonSqueezyVariantId` for subscriptions that replace a Lemon Squeezy one. Use the same keys in checkout `customData`, in the subscriber file, and in the webhook handler.
5. **License keys and files.** Whether the app issues license keys or downloads through Lemon Squeezy, and how current customers keep access after cutover (Step 5).
6. **Where the IDs live.** The `subscription-sync` subscriptions table gets the Lemon Squeezy IDs next to the Paddle ones (Step 4). Keep both sets after cutover for support and reconciliation.

## Prerequisites

- A Paddle sandbox account for building and testing, and a live account for the real catalog. Sandbox and live are separate: IDs from one don't exist in the other.
- The webhook handler and database mirror from `webhooks` and `subscription-sync`. Step 4 replaces the `processEvent` function from `subscription-sync` and relies on its `saveCustomer` and `saveSubscription`, which accept any customer or subscription event's `data`. The examples use Supabase, as that skill does.
- Node.js 20.6 or later and `tsx`. Run the scripts below with `node --env-file=.env.local --import tsx scripts/<name>.ts`, so the keys are read from the env file and never typed on the command line. Install the Node SDK with `npm install @paddle/paddle-node-sdk`.
- Environment variables:

```bash
LEMON_SQUEEZY_API_KEY=...               # live-mode key; read-only use, never printed
LEMON_SQUEEZY_STORE_ID=                 # only if the account has more than one store
PADDLE_API_KEY=pdl_sdbx_apikey_...      # server-side; never expose to the browser
NEXT_PUBLIC_PADDLE_ENV=sandbox          # or "production"
```

- Paddle API key permissions: `product.write` and `price.write` to create the catalog, `discount.write` to recreate discounts, and `customer.read` and `subscription.read` to reconcile after import. Each write permission includes read. Create keys under **Paddle > My account > Settings > Authentication**.
- The scripts write to `migration/`, which holds customer data and license keys. Add it to `.gitignore` before Step 2. The only outputs that are committed are the replace-list from Step 1 and the ID maps from Step 3.

## Step 1: Audit the codebase

Find every Lemon Squeezy touchpoint before changing anything. The filter on the end redacts the value of any `=` or `:` assignment whose name contains key, secret, or token, because keys sit in compose files, CI config, and code as well as in env files; it spells the case classes out because BSD `sed` has no case-insensitive flag. Values on their own line or passed as arguments slip through, so read the output before you report it.

```bash
grep -rniE "lemonsqueezy|lemon_squeezy|lemon-squeezy|lemon\.js|lmsqueezy|x-signature|licenses/(activate|validate|deactivate)|usage-records|customer_portal|update_payment_method" \
  --exclude='.env*' --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=vendor --exclude-dir=dist . \
  | sed -E "s/([Kk][Ee][Yy]|[Ss][Ee][Cc][Rr][Ee][Tt]|[Tt][Oo][Kk][Ee][Nn])[A-Za-z_]*['\"]?[[:space:]]*[=:].*/\1=<redacted>/"
```

List the env var names separately with `grep -ho '^LEMON_SQUEEZY_[A-Z_]*' .env*`.

Report what you found as a replace-list, one row per touchpoint, with the Paddle equivalent and the skill that builds it:

| Lemon Squeezy touchpoint                                                                                                                                                                 | Paddle equivalent                                                                                                                                                                                                                                                                                                           | Skill                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `@lemonsqueezy/lemonsqueezy.js` (`lemonSqueezySetup`, `listVariants`, `createCheckout`, `getSubscription`, `updateSubscription`, `cancelSubscription`, …)                                | `@paddle/paddle-node-sdk` on the server: `paddle.products`, `paddle.prices`, `paddle.transactions`, `paddle.subscriptions`. There's no server-created checkout entity: create a transaction, or open a checkout for price IDs from the browser.                                                                             | `checkout-web`, `subscription-update`, `subscription-cancel` |
| `lemonsqueezy/laravel` (`Billable`, `->checkout()`, `->subscription()`, `->swap()`, `->cancel()`, the `lemon-squeezy/webhook` route, `LEMON_SQUEEZY_*` env vars)                         | `laravel/cashier-paddle`, or the Paddle PHP SDK with your own webhook route.                                                                                                                                                                                                                                                | `webhooks`                                                   |
| `lemon.js` script tag, the `lemonsqueezy-button` class, `LemonSqueezy.Setup({ eventHandler })`, `LemonSqueezy.Url.Open(url)`, the `Checkout.Success` event                               | Paddle.js: `initializePaddle({ token, eventCallback })`, `Paddle.Checkout.open({ items, customer, customData })` or the `paddle_button` class with `data-items`. Act on `checkout.completed` for UX only; provision from webhooks.                                                                                          | `checkout-web`                                               |
| Checkout URL parameters: `checkout[email]`, `checkout[name]`, `checkout[billing_address][country]`, `checkout[billing_address][zip]`, `checkout[discount_code]`, `checkout[custom][...]` | `customer: { email, address: { countryCode, postalCode } }`, `discountCode`, and `customData` on `Paddle.Checkout.open()`. Server-side, the same data goes on the transaction (`customer_id`, `address_id`, `discount_id`, `custom_data`).                                                                                  | `checkout-web`                                               |
| `meta.custom_data` on webhook payloads                                                                                                                                                   | `data.custom_data` on transaction and subscription events (`customData` in the Node SDK). Paddle copies a transaction's custom data to the subscription it creates, and a subscription's to its renewals.                                                                                                                   | `webhooks`                                                   |
| `X-Signature` HMAC-SHA256 hex check of the raw body                                                                                                                                      | `paddle.webhooks.unmarshal(rawBody, secret, signatureHeader)`, which verifies the `Paddle-Signature` header (`ts` and `h1`) and parses the event.                                                                                                                                                                           | `webhooks`                                                   |
| The webhook event names (`order_created`, `subscription_payment_success`, …)                                                                                                             | The Paddle events in the mapping table in Step 4.                                                                                                                                                                                                                                                                           | `webhooks`, `subscription-sync`                              |
| Subscription statuses `on_trial`, `active`, `paused`, `past_due`, `unpaid`, `cancelled`, `expired`                                                                                       | `trialing`, `active`, `paused`, `past_due`, `canceled`. A cancellation at the end of the period is `scheduled_change.action: "cancel"` on an `active` subscription until it takes effect. After dunning, Paddle pauses or cancels the subscription based on your settings, so `unpaid` is `paused` or `canceled` in Paddle. | `subscription-sync`                                          |
| `urls.customer_portal`, `urls.update_payment_method` (signed, 24 hours)                                                                                                                  | A customer portal session from `paddle.customerPortalSessions.create(customerId, [subscriptionId])`: `urls.general.overview` and `urls.subscriptions[].updateSubscriptionPaymentMethod`. Mint per click; don't store the links.                                                                                             | `customer-portal`                                            |
| License API: `POST /v1/licenses/activate`, `validate`, `deactivate`                                                                                                                      | No Paddle feature. Your own keys and endpoints (Step 5).                                                                                                                                                                                                                                                                    | this skill                                                   |
| Usage records (`POST /v1/usage-records`, `increment` or `set`)                                                                                                                           | Usage-based billing with meters and usage events; see the usage row in Step 2.                                                                                                                                                                                                                                              | `usage-based-billing`                                        |
| Affiliate tracking (`LemonSqueezy.Affiliate.*`, `affiliate_activated`)                                                                                                                   | None. A third-party affiliate tool.                                                                                                                                                                                                                                                                                         | None                                                         |

Keep the list in the repo (for example `docs/lemon-squeezy-replace-list.md`) and tick rows off as Steps 3 to 5 land.

## Step 2: Inventory the store and propose a mapping

Read the store through the Lemon Squeezy API and save the result, so every later step works from one snapshot. The API is JSON:API: send `Accept: application/vnd.api+json`, paginate with `page[number]` and `page[size]`, and expect `data[]` entries with `id` and `attributes`. There's a limit of 300 calls per minute. Use a live-mode key: a key created in test mode only returns test-mode data.

```ts
// scripts/lemon-squeezy-inventory.ts
import { mkdirSync, writeFileSync } from "node:fs";

const key = process.env.LEMON_SQUEEZY_API_KEY;
if (!key) throw new Error("LEMON_SQUEEZY_API_KEY is not set");

type Entity = { id: string; attributes: Record<string, unknown> };

async function listAll(resource: string): Promise<Entity[]> {
  const out: Entity[] = [];
  for (let page = 1; ; page++) {
    const res = await fetch(
      `https://api.lemonsqueezy.com/v1/${resource}?page[number]=${page}&page[size]=100`,
      { headers: { Authorization: `Bearer ${key}`, Accept: "application/vnd.api+json" } },
    );
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 60_000)); // 300 calls per minute; wait out the window
      page--;
      continue;
    }
    if (!res.ok) throw new Error(`${resource} page ${page}: HTTP ${res.status}`);
    const body = (await res.json()) as { data: Entity[]; meta?: { page?: { lastPage?: number } } };
    out.push(...body.data);
    if (page >= (body.meta?.page?.lastPage ?? 1)) return out;
  }
}

async function main() {
  const inventory: Record<string, Entity[]> = {};
  for (const r of [
    "stores",
    "products",
    "variants",
    "prices",
    "discounts",
    "discount-redemptions",
    "customers",
    "subscriptions",
    "orders",
    "license-keys",
    "license-key-instances",
  ]) {
    inventory[r] = await listAll(r);
    console.log(`${r}: ${inventory[r].length}`);
  }
  mkdirSync("migration", { recursive: true });
  writeFileSync("migration/lemon-squeezy-inventory.json", JSON.stringify(inventory, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

Before going further, open the saved file and compare one subscription, one order, and one price against the field names in this step and Step 6; the API reference settles any difference. Orders are included because a subscription's currency comes from its order, and discount redemptions because they're how you find which subscriptions carry a discount. With more than one store, propose the catalog for the agreed store only: products, discounts, and license keys carry a `store_id`; variants and prices don't, so follow them through `product_id` and `variant_id`.

Then propose the Paddle catalog, variant by variant, and confirm it with the user before Step 3. Read pricing from the Price objects, not the deprecated price fields on variants:

| Lemon Squeezy                                                                                                                                          | Paddle                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Variants of one product that differ only by `unit_price` or renewal interval                                                                           | One product with one price per variant, for example "Pro" with "Monthly" and "Annual" prices.                                                                                                                          |
| Variants that differ by feature set                                                                                                                    | Separate products, each with its own prices.                                                                                                                                                                           |
| More than one Price object for a variant, or subscriptions whose `first_subscription_item.price_id` isn't the variant's current price (legacy pricing) | One extra price per distinct legacy amount, on the same product. Subscribers to be imported need a catalog price; for new sales only, a custom price on the transaction is the alternative.                            |
| `category: subscription` with `renewal_interval_unit` and `renewal_interval_quantity`                                                                  | `billing_cycle: { interval, frequency }`. Intervals are `day`, `week`, `month`, and `year` on both sides.                                                                                                              |
| `trial_interval_unit` and `trial_interval_quantity`                                                                                                    | `trial_period: { interval, frequency }` on the price. Paid and cardless trials are options; see `catalog-setup`.                                                                                                       |
| `category: one_time`                                                                                                                                   | A price with no `billing_cycle`.                                                                                                                                                                                       |
| `setup_fee_enabled` with `setup_fee`                                                                                                                   | No setup fee on a price. Add a one-time price for the fee and sell both in one checkout.                                                                                                                               |
| `scheme: package` with `package_size`, or `scheme: graduated` or `volume` with `tiers`                                                                 | No direct equivalent for tiered unit pricing. Model each tier the user sells as its own price, or use quantity limits on one price. Flag it and ask.                                                                   |
| `category: pwyw` (`min_price`, `suggested_price`)                                                                                                      | No direct equivalent. Flag it. Options: a fixed price, a few preset prices, or a transaction created server-side with a custom price for the amount the customer chose.                                                |
| `category: lead_magnet`                                                                                                                                | A price with a unit price of zero.                                                                                                                                                                                     |
| `usage_aggregation` set (usage-based)                                                                                                                  | `usage-based-billing`. It's early access (beta) and doesn't bill usage in arrears, so flag it, confirm the user has access, and agree how metered variants translate.                                                  |
| Variant `has_license_keys`, `license_activation_limit`, `license_length_*`                                                                             | Nothing in the catalog. Store these limits in your own license table (Step 5).                                                                                                                                         |
| `tax_code` `saas`, `eservice`, `ebook`                                                                                                                 | `tax_category`: `saas` stays `saas`; `ebook` becomes `ebooks`, which needs approval; `eservice` becomes `saas`, `standard`, or `digital-goods` (needs approval) depending on what's sold, so ask. See `catalog-setup`. |
| Discounts                                                                                                                                              | See "Discounts" below.                                                                                                                                                                                                 |

Amounts are in the smallest currency unit on both sides, so copy `unit_price` into `unit_price.amount` as a string. `unit_price` is `null` on graduated and volume prices, where the amounts are in `tiers`, and on usage-based prices, where it's `unit_price_decimal`; both are flagged rows above. Lemon Squeezy variants have one price in one currency; add `unit_price_overrides` in Paddle only if the user wants country-specific prices.

**Discounts.** `amount_type` `percent` or `fixed` becomes `type` `percentage` or `flat` (with `currency_code`); `expires_at`, `max_redemptions`, and `is_limited_to_products` become `expires_at`, `usage_limit`, and `restrict_to` with price or product IDs. For `duration`: `once` is the default; `forever` is `recur: true`; `repeating` is `recur: true` with `maximum_recurring_intervals`, which counts billing periods, so divide `duration_in_months` by the months in the price's billing cycle and flag any that don't divide evenly. Keep the same `code` where it fits Paddle's rule (letters and numbers only, up to 32 characters, not case-sensitive); flag codes that don't.

Report the proposal as a table (Lemon Squeezy product, variant, and price to Paddle product, price, billing cycle, trial, and tax category) with every flagged row at the top, and wait for the user's decisions.

## Step 3: Create the catalog and write the ID map

Create the agreed products and prices with `catalog-setup`, in sandbox first. Create the discounts the same way, with the same method order and conventions. This is the body for one "repeating" discount, as an SDK call to add to that skill's seed script:

```ts
// Add to scripts/seed-paddle-catalog.ts from catalog-setup, after the prices.
const discount = await paddle.discounts.create({
  description: "Launch offer (Lemon Squeezy discount 1234)",
  code: "LAUNCH20",
  type: "percentage",
  amount: "20",
  enabledForCheckout: true,
  recur: true,
  maximumRecurringIntervals: 3, // "repeating" for 3 months on a monthly price; omit for "forever"
  restrictTo: ["pri_01h..."],
});
console.log(discount.id);
```

Then write the map from Lemon Squeezy IDs to Paddle IDs and commit it: the app reads it during the customer-led flow and the subscriber file is built from it. Sandbox IDs never work in live, so keep one file per environment, `src/config/lemon-squeezy-id-map.sandbox.json` and `src/config/lemon-squeezy-id-map.production.json`, both with this shape:

```json
{
  "prices": { "67890": "pri_01h...", "67891": "pri_01h..." },
  "variants": { "2468": { "product_id": "pro_01h...", "price_id": "pri_01h..." } },
  "discounts": { "1234": "dsc_01h..." }
}
```

Key `prices` by Lemon Squeezy Price ID, because that's what a subscription item references and it distinguishes legacy pricing. `variants` is the lookup for checkout links that only know a variant, and for subscriptions on a free trial, which have no item yet. Confirm every Paddle ID exists before you write it, for example with `paddle.prices.get(id)`.

Add a small lookup the app can import, so checkout and webhook code don't hard-code IDs:

```ts
// utils/paddle/lemon-squeezy-ids.ts
import production from "@/config/lemon-squeezy-id-map.production.json";
import sandbox from "@/config/lemon-squeezy-id-map.sandbox.json";

export type IdMap = {
  prices: Record<string, string>;
  variants: Record<string, { product_id: string; price_id: string }>;
  discounts: Record<string, string>;
};

export const idMap: IdMap =
  process.env.NEXT_PUBLIC_PADDLE_ENV === "production" ? production : sandbox;

export function paddlePriceForVariant(variantId: string | number): string {
  const entry = idMap.variants[String(variantId)];
  if (!entry) throw new Error(`No Paddle price mapped for Lemon Squeezy variant ${variantId}`);
  return entry.price_id;
}
```

## Step 4: Replace checkout and webhooks

### Checkout

Build it with `checkout-web`. Where the old code built a Lemon Squeezy checkout URL for a variant, open a Paddle checkout for `paddlePriceForVariant(variantId)`, with `customer: { email }` and `customData` holding the agreed keys. For the customer-led path, this is the checkout the user sends existing customers to: pass their Lemon Squeezy subscription, customer, and variant IDs in `customData` too, as strings, so the new subscription links back to the old one. The guide describes how to keep a customer's current billing date.

### Webhooks

Build the endpoint with `webhooks` and the database mirror with `subscription-sync`, then subscribe the notification destination to the Paddle events on the right of this table, plus `customer.imported` and `subscription.imported` for the assisted path. Several Lemon Squeezy events map onto one Paddle event with a condition, so the handler checks a field rather than the event name:

| Lemon Squeezy event                               | Paddle event                                                                                                                                                                                                                                                             |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `order_created`                                   | `transaction.completed`, or `transaction.paid` to act before the invoice is finalized                                                                                                                                                                                    |
| `order_refunded`, `subscription_payment_refunded` | `adjustment.created` with an `action` of `refund`. Check its `status`: refunds that are approved automatically are created as `approved`. Refunds that need review are created as `pending_approval`, and `adjustment.updated` occurs when they're approved or rejected. |
| `customer_updated`                                | `customer.updated`                                                                                                                                                                                                                                                       |
| `subscription_created`                            | `subscription.created`, then `subscription.activated` or `subscription.trialing`                                                                                                                                                                                         |
| `subscription_updated`                            | `subscription.updated`                                                                                                                                                                                                                                                   |
| `subscription_cancelled`                          | `subscription.updated` with a `scheduled_change.action` of `cancel`                                                                                                                                                                                                      |
| `subscription_expired`                            | `subscription.canceled`, or `subscription.paused` if payment recovery is set to pause                                                                                                                                                                                    |
| `subscription_resumed`                            | `subscription.updated` with `scheduled_change` set to `null`                                                                                                                                                                                                             |
| `subscription_paused`, `subscription_unpaused`    | `subscription.paused`, `subscription.resumed`                                                                                                                                                                                                                            |
| `subscription_payment_success`                    | `transaction.completed`. For renewals, the transaction's `origin` is `subscription_recurring`.                                                                                                                                                                           |
| `subscription_payment_failed`                     | `transaction.payment_failed`, then `subscription.past_due`                                                                                                                                                                                                               |
| `subscription_payment_recovered`                  | `transaction.completed` for the past due transaction, then `subscription.updated` with a `status` of `active`                                                                                                                                                            |
| `license_key_created`, `license_key_updated`      | No equivalent. Generate keys when `transaction.completed` occurs for a first purchase, not for renewals (Step 5).                                                                                                                                                        |
| `affiliate_activated`                             | No equivalent.                                                                                                                                                                                                                                                           |

Imported subscriptions arrive as `customer.imported` and `subscription.imported`, with the custom data from the subscriber file, and then `subscription.activated` or `subscription.trialing`. Treat them like `customer.created` and `subscription.created`.

Two rows can't be told from the event alone: a cancellation being undone (`subscription_resumed`) and a payment recovery both arrive as a plain `subscription.updated`, so compare the event with the stored row from `subscription-sync` (previous `scheduled_change_action`, previous status) before acting. Refunds need the second event: act on an adjustment only when its `status` is `approved`, whether that's on `adjustment.created` or the later `adjustment.updated`.

### Schema and handler

Add the Lemon Squeezy IDs to the `subscription-sync` subscriptions table so support and reconciliation can cross-reference:

```sql
ALTER TABLE subscriptions
  ADD COLUMN lemon_squeezy_subscription_id TEXT,
  ADD COLUMN lemon_squeezy_customer_id TEXT,
  ADD COLUMN lemon_squeezy_variant_id TEXT;
CREATE INDEX subscriptions_lemon_squeezy_subscription_id_idx
  ON subscriptions(lemon_squeezy_subscription_id);
```

Replace `processEvent` in `utils/paddle/process-webhook.ts` from `subscription-sync` with this version, and keep `saveCustomer` and `saveSubscription` in that file unchanged. Every subscription event in the table reaches `saveSubscription`, because `subscription.updated` covers transitions without a dedicated event and only sometimes follows one, so a switch without `subscription.resumed` or `subscription.past_due` lets the stored status fall behind. The Lemon Squeezy IDs are copied out of custom data on the same write:

```ts
// utils/paddle/process-webhook.ts
import {
  type AdjustmentCreatedEvent,
  type AdjustmentUpdatedEvent,
  type EventEntity,
  EventName,
  type TransactionCompletedEvent,
} from "@paddle/paddle-node-sdk";
import { createClient as createAdminClient } from "@/utils/supabase/server-internal";

export async function processEvent(event: EventEntity) {
  switch (event.eventType) {
    case EventName.CustomerCreated:
    case EventName.CustomerUpdated:
    case EventName.CustomerImported:
      return saveCustomer(event.data, event.occurredAt);
    case EventName.SubscriptionCreated:
    case EventName.SubscriptionImported:
    case EventName.SubscriptionUpdated:
    case EventName.SubscriptionActivated:
    case EventName.SubscriptionTrialing:
    case EventName.SubscriptionPastDue:
    case EventName.SubscriptionPaused:
    case EventName.SubscriptionResumed:
    case EventName.SubscriptionCanceled:
      await saveSubscription(event.data, event.occurredAt);
      return saveLemonSqueezyIds(event.data);
    case EventName.TransactionCompleted:
      return onTransactionCompleted(event);
    case EventName.AdjustmentCreated:
    case EventName.AdjustmentUpdated:
      return onAdjustment(event);
  }
}

// Runs on every subscription event: the IDs never change, so the write is idempotent, and a
// lost subscription.created still gets repaired by the next event.
async function saveLemonSqueezyIds(sub: {
  id: string;
  customData?: Record<string, unknown> | null;
}) {
  const custom = sub.customData ?? {};
  const asId = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : null);
  const subscriptionId = asId(custom.lemonSqueezySubscriptionId);
  if (!subscriptionId) return;
  const admin = await createAdminClient();
  const { error } = await admin
    .from("subscriptions")
    .update({
      lemon_squeezy_subscription_id: subscriptionId,
      lemon_squeezy_customer_id: asId(custom.lemonSqueezyCustomerId),
      lemon_squeezy_variant_id: asId(custom.lemonSqueezyVariantId),
    })
    .eq("subscription_id", sub.id);
  if (error) throw error;
}

async function onTransactionCompleted(event: TransactionCompletedEvent) {
  const origin = event.data.origin;
  if (origin === "web" || origin === "api") {
    // was order_created: fulfill, issue license keys (Step 5). Idempotent on event.data.id.
  }
  // Renewals, plan changes, and payment method updates also complete transactions; nothing to fulfill.
}

async function onAdjustment(event: AdjustmentCreatedEvent | AdjustmentUpdatedEvent) {
  const { action, status, type, subscriptionId } = event.data;
  if (action === "refund" && status === "approved" && type === "full" && !subscriptionId) {
    // was order_refunded on a one-time purchase: revoke keys. A refunded renewal leaves the
    // subscription active; its key follows subscription.canceled instead.
  }
}
```

The `subscription_cancelled` row is `event.data.scheduledChange?.action === "cancel"` on a `subscription.updated`: access continues until `scheduledChange.effectiveAt`, and `subscription-sync` already stores it. Keep every handler idempotent and ordered by `occurredAt`, as `webhooks` describes; Lemon Squeezy retried a webhook only three times, so code that assumed one delivery needs the guard now.

After an assisted import, Paddle also returns a file mapping Lemon Squeezy subscription IDs to Paddle IDs. Use it to check the columns above, and to fill them for any row whose custom data didn't carry the IDs. Keep the old IDs for support and reconciliation; don't drop them after cutover.

## Step 5: Rebuild license keys and file delivery

Paddle doesn't generate license keys, host files, or offer a License API. Existing Lemon Squeezy keys don't transfer, and the activate, validate, and deactivate endpoints stop with the service. Build the equivalent in the app, driven by the handler above:

| Paddle event                                                                          | Key                                                                                                                                                  |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transaction.completed` with an `origin` of `web` or `api`                            | Issue one key per transaction ID, unless custom data carries a `lemonSqueezySubscriptionId`: that's an existing customer moving over, handled below. |
| `subscription.paused`, including a failed payment recovery that ends in a pause       | Suspend.                                                                                                                                             |
| `subscription.resumed`                                                                | Reinstate.                                                                                                                                           |
| `subscription.updated` with a `scheduled_change.action` of `cancel`                   | No change until the status flips.                                                                                                                    |
| `subscription.canceled`                                                               | Revoke.                                                                                                                                              |
| Approved full refund of a one-time purchase (an adjustment with no `subscription_id`) | Revoke.                                                                                                                                              |
| Partial refund, or refund of a renewal                                                | No change.                                                                                                                                           |

- **Store** each key against the Paddle customer ID and subscription ID (or transaction ID for one-time purchases), with the activation limit and expiry that the variant used to carry.
- **Validate and activate** through your own endpoints, keyed on the stored key and an instance name, mirroring the three Lemon Squeezy calls so client apps change little.
- **Files** move to your own storage. Hand out time-limited download links from the same `transaction.completed` handler.

```sql
CREATE TABLE license_keys (
  key TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,            -- "ctm_01h..."
  subscription_id TEXT,                 -- "sub_01h...", null for one-time purchases
  transaction_id TEXT NOT NULL UNIQUE,  -- "txn_01h..."; one key per purchase
  product_id TEXT NOT NULL,             -- "pro_01h..."
  activation_limit INT,
  status TEXT NOT NULL DEFAULT 'active', -- 'active' | 'suspended' | 'disabled' | 'expired'
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE license_activations (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL REFERENCES license_keys(key),
  instance_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

For customers who already hold a Lemon Squeezy key, decide with the user how they keep access: issue new keys after the import and tell customers, or import the existing key strings from the Step 2 inventory (`license-keys` returns the full `key`, `activation_limit`, `expires_at`, and `status`; `license-key-instances` the activations) against the Paddle customer and subscription IDs from the file Paddle returns after import. Either way, the app must stop calling the Lemon Squeezy License API before cutover.

## Step 6: Prepare the subscriber file

Only for the Paddle-assisted path, once the specialist has confirmed the store is eligible. The specialist sends the template; this step builds the data for it from the Step 2 inventory and the Step 3 ID map, one row per subscription that Paddle can import. The script's keys are placeholders: map them onto the template you're given.

| Field                        | From Lemon Squeezy                                                                                                                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Customer email and name      | `user_email`, `user_name` on the subscription                                                                                                                                                          |
| Country                      | `country` on the customer                                                                                                                                                                              |
| Postal code                  | Not in the API. See "Postal codes" below.                                                                                                                                                              |
| Status                       | `status`: `on_trial`, `active`, `paused`, `past_due` import; `cancelled`, `expired`, and `unpaid` don't                                                                                                |
| Currency                     | `currency` on the subscription's order (`order_id`)                                                                                                                                                    |
| Next billing date            | `renews_at`; `trial_ends_at` while `on_trial`; `pause.resumes_at` while `paused`. See "Dates" below.                                                                                                   |
| Paddle price ID and quantity | `first_subscription_item.price_id` through the ID map, and `first_subscription_item.quantity`. The variant mapping only when the item is `null`, which it is during a free trial.                      |
| External IDs                 | The Lemon Squeezy subscription `id`, and `customer_id`                                                                                                                                                 |
| Discount (optional)          | A discount redemption on the subscription's order whose discount has a `duration` of `repeating` or `forever`, through the ID map                                                                      |
| Custom data (optional)       | Your user ID plus the Lemon Squeezy subscription, customer, and variant IDs, under the keys agreed above, so `subscription.imported` carries them back and the handler in Step 4 fills the new columns |
| Payment details reference    | Leave it to the specialist. Nothing in this skill fills it.                                                                                                                                            |

**Postal codes.** Required in some countries because tax depends on them; the template lists which, so make `POSTAL_CODE_REQUIRED` in the script match it. The customer object has city, region, and country only, but the orders export from the Lemon Squeezy dashboard has a `postal_code` column. Build `migration/postal-codes.json` from it as `{ "<order_id>": "<postal_code>" }`, and ask customers for anything missing.

**Dates.** Every next billing date must be in the future on import day, so rerun Step 2 and this script just before import. For `past_due` rows, where `renews_at` is the next retry attempt, and for paused rows with no resume date, ask the specialist which date to supply and put it in `migration/billing-dates.json` as `{ "<subscription id>": "<ISO date>" }`.

The script reads those two files and `migration/user-ids.json` (`{ "<email>": "<your user ID>" }`), so fix the inputs rather than the output and the import-day rerun stays complete:

```ts
// scripts/lemon-squeezy-subscriber-file.ts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { IdMap } from "@/utils/paddle/lemon-squeezy-ids";

type Entity<A> = { id: string; attributes: A };
type LsSubscription = {
  store_id: number;
  customer_id: number;
  order_id: number;
  variant_id: number;
  user_name: string;
  user_email: string;
  status: string;
  payment_processor: string;
  card_brand: string | null;
  trial_ends_at: string | null;
  renews_at: string | null;
  pause: { mode: string; resumes_at: string | null } | null;
  first_subscription_item: { price_id: number; quantity: number } | null;
};
type Inventory = {
  subscriptions: Entity<LsSubscription>[];
  customers: Entity<{ country: string | null }>[];
  orders: Entity<{ currency: string }>[];
  discounts: Entity<{ duration: string }>[];
  "discount-redemptions": Entity<{ discount_id: number; order_id: number }>[];
};

const readJson = <T>(path: string, fallback: T): T =>
  existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : fallback;
const inventory = JSON.parse(
  readFileSync("migration/lemon-squeezy-inventory.json", "utf8"),
) as Inventory;
const idMap = JSON.parse(
  readFileSync("src/config/lemon-squeezy-id-map.production.json", "utf8"),
) as IdMap;
const postalCodes = readJson<Record<string, string>>("migration/postal-codes.json", {});
const billingDates = readJson<Record<string, string>>("migration/billing-dates.json", {});
const userIds = readJson<Record<string, string>>("migration/user-ids.json", {});
const STORE_ID = process.env.LEMON_SQUEEZY_STORE_ID;

const POSTAL_CODE_REQUIRED = new Set(["US", "CA", "IN", "AU", "FR", "DE", "IT", "NL", "ES", "GB"]);
const IMPORTABLE = new Set(["on_trial", "active", "paused", "past_due"]);
const byId = <A>(list: Entity<A>[]) => new Map(list.map((e) => [e.id, e.attributes]));
const customers = byId(inventory.customers);
const orders = byId(inventory.orders);
const discounts = byId(inventory.discounts);
const recurringDiscountByOrder = new Map<string, string>();
for (const { attributes: r } of inventory["discount-redemptions"]) {
  const duration = discounts.get(String(r.discount_id))?.duration;
  if (duration === "repeating" || duration === "forever") {
    recurringDiscountByOrder.set(String(r.order_id), String(r.discount_id));
  }
}
const csvCell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;

const rows: Record<string, unknown>[] = [];
const customerLed: string[] = [];
const fixes: string[] = [];

for (const { id, attributes: s } of inventory.subscriptions) {
  if (STORE_ID && String(s.store_id) !== STORE_ID) continue;
  if (!IMPORTABLE.has(s.status)) continue;
  // Lemon Squeezy processes cards through Stripe; PayPal subscriptions carry "paypal", and
  // card_brand is empty for any non-card payment.
  if (s.payment_processor !== "stripe" || !s.card_brand) {
    customerLed.push(`${id} (${s.user_email}): not paid by card`);
    continue;
  }
  const country = customers.get(String(s.customer_id))?.country;
  const currency = orders.get(String(s.order_id))?.currency;
  const postalCode = postalCodes[String(s.order_id)];
  const lsPriceId = s.first_subscription_item?.price_id;
  const priceId = lsPriceId
    ? idMap.prices[String(lsPriceId)]
    : idMap.variants[String(s.variant_id)]?.price_id;
  const lsDiscountId = recurringDiscountByOrder.get(String(s.order_id));
  const nextBillingDate =
    billingDates[id] ??
    (s.status === "on_trial"
      ? s.trial_ends_at
      : s.status === "paused"
        ? s.pause?.resumes_at
        : s.renews_at);
  const problems = [
    !country && "no country",
    country && POSTAL_CODE_REQUIRED.has(country) && !postalCode && "postal code required",
    !currency && "no currency: order missing from the inventory",
    !priceId &&
      (lsPriceId
        ? `no Paddle price for Lemon Squeezy price ${lsPriceId} (legacy pricing?)`
        : `no Paddle price for variant ${s.variant_id}`),
    lsDiscountId && !idMap.discounts[lsDiscountId] && `no Paddle discount for ${lsDiscountId}`,
    s.status === "past_due" && !billingDates[id] && "past_due: date from the specialist needed",
    // new Date(null) is Invalid Date, so a missing date fails this check as well as a past one.
    !(new Date(nextBillingDate ?? "") > new Date()) &&
      `next billing date ${nextBillingDate ?? "(none)"} isn't in the future`,
  ].filter(Boolean);
  if (problems.length) {
    fixes.push(`${id} (${s.user_email}): ${problems.join("; ")}`);
    continue;
  }
  rows.push({
    email: s.user_email,
    name: s.user_name,
    country,
    postal_code: postalCode ?? "",
    status: s.status,
    currency,
    next_billing_date: nextBillingDate,
    paddle_price_id: priceId,
    quantity: s.first_subscription_item?.quantity ?? 1,
    paddle_discount_id: lsDiscountId ? idMap.discounts[lsDiscountId] : "",
    lemon_squeezy_subscription_id: id,
    lemon_squeezy_customer_id: String(s.customer_id),
    custom_data: JSON.stringify({
      userId: userIds[s.user_email],
      lemonSqueezySubscriptionId: id,
      lemonSqueezyCustomerId: String(s.customer_id),
      lemonSqueezyVariantId: String(s.variant_id),
    }),
  });
}

const header = Object.keys(rows[0] ?? {});
const csv = [header.map(csvCell), ...rows.map((r) => header.map((h) => csvCell(r[h])))]
  .map((line) => line.join(","))
  .join("\n");
writeFileSync("migration/subscribers.csv", csv);
writeFileSync("migration/needs-fixing.txt", fixes.join("\n"));
writeFileSync("migration/customer-led.txt", customerLed.join("\n"));
console.log(`${rows.length} rows, ${fixes.length} need fixing, ${customerLed.length} customer-led`);
```

Only clean rows reach the file. Report the three counts and show `needs-fixing.txt` to the user, then fix the inputs and rerun. A missing price mapping means Step 3 missed a legacy price or a variant. Rows in `customer-led.txt`, and any row the specialist reports as untransferable, move through the customer-led path instead. The file holds customer data, so share it only through the channel the specialist gives you.

## Cut over

Follow the guide's order, and don't skip ahead:

1. Switch new sales to Paddle once the sandbox checks pass, the live catalog exists, and the live account has passed verification and domain approval (`onboarding` checks both).
2. Take a fresh inventory and run Step 6 again on import day, so every next billing date is in the future.
3. Hand the file to the specialist through the channel they give you, or launch the customer-led campaign.
4. Confirm the Paddle subscriptions are active, with the reconciliation in "Verify the integration".
5. Only then cancel the matching Lemon Squeezy subscriptions. Keep both webhook handlers live until the last one is canceled, and keep the exports.

## Common pitfalls

- **Mapping by variant when subscribers are on legacy prices.** The subscription item references a Price ID, and a variant can have more than one over its life. Map by Price ID and create a Paddle price for each legacy amount, or those rows fail on import.
- **Reading deprecated pricing fields on variants.** `price`, `is_subscription`, `interval`, and the trial fields on a variant are kept for compatibility; the Price object is current.
- **Dropping customers in the `cancelled` grace period.** A Lemon Squeezy subscription with `cancelled: true` keeps running until `ends_at`. It isn't imported, so the app keeps honoring the stored `ends_at` after the Lemon Squeezy handlers go, and the customer re-subscribes through Paddle if they want to continue.
- **Sorting subscribers by `payment_processor` alone.** `card_brand` is empty for subscriptions not paid by card, and that's the field the guide uses to tell the two groups apart. The specialist's transfer result is final either way.
- **Provisioning from `checkout.completed`.** It's the replacement for `Checkout.Success` as a UX signal only. Grant access from `transaction.completed`, as `checkout-web` says.
- **Re-granting on retries.** Lemon Squeezy retried a webhook three times; Paddle retries for far longer. The idempotency and ordering guards in `webhooks` are mandatory here.
- **Canceling in Lemon Squeezy too early.** Nothing in this skill cancels there. Cancel only after the Paddle subscription is confirmed active, per the guide.
- **Committing `migration/`.** It holds customer data and license keys. Only the replace-list and the ID maps under `src/config/` are committed.

## Verify the integration

1. Run the whole Paddle integration in sandbox with `sandbox-testing`: a purchase for each mapped price, a trial, a plan change, a cancellation, a failed payment, a refund, and the portal links.
2. Run a `subscription.imported` simulation against the endpoint (see `sandbox-testing`), with a custom payload whose `custom_data` carries the agreed keys, and confirm the row lands with the Lemon Squeezy ID columns filled.
3. Open the customer-led checkout for a mapped variant with the Lemon Squeezy IDs in `customData`, complete it with a test card, and confirm the new row carries both sets of IDs.
4. After the import, reconcile: for each row in the subscriber file, confirm a Paddle subscription exists with the expected price, quantity, and next billing date (`paddle.subscriptions.list({ status: ["active", "trialing", "paused", "past_due"] })`), and that the app's row has both IDs.

## Related docs

- [Migrate from Lemon Squeezy to Paddle](https://developer.paddle.com/migrate/other-platforms/lemon-squeezy.md)
- [Paddle for digital products](https://developer.paddle.com/get-started/how-paddle-works/digital-products.md)
- [Work with custom data](https://developer.paddle.com/build/transactions/custom-data.md)
- [Provision access and handle subscription state](https://developer.paddle.com/build/subscriptions/provision-access-webhooks.md)
- [subscription.imported](https://developer.paddle.com/webhooks/subscriptions/subscription-imported.md)
- [Discounts API reference](https://developer.paddle.com/api-reference/discounts.md)
- [Go-live checklist](https://developer.paddle.com/build/go-live-checklist.md)
- [Request a migration](https://www.paddle.com/compare/lemon-squeezy)
