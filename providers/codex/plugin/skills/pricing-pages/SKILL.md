---
name: paddle-pricing-pages
description: Render country-localized prices on a Next.js pricing page using Paddle.js PricePreview — country detection, billing frequency toggle, and currency formatting.
---

# Display localized pricing in Next.js

## When to use this skill

Use this skill when building a public pricing page (or in-app upgrade screen) that needs to show prices in the user's local currency, with the right tax behavior. Covers the `Paddle.PricePreview()` API, country detection, a billing frequency toggle (monthly/yearly), the zero-decimal currency formatting gotcha (JPY/KRW/VND/CLP), and how to keep the displayed price in sync with what checkout will charge.

This is a client-side concern. For checkout itself, see `checkout-web` — the price IDs you display here are the same ones you pass to `Paddle.Checkout.open()`.

## Why use PricePreview at all?

You _could_ hardcode "$10/month" in your UI, but comes with very strong regional pricing built-in — the same plan might be $10 in the US, €9 in the EU (with VAT), £8 in the UK, and ¥1,200 in Japan. Across countries that share a currency you can set different prices for each country to account for purchasing power parity. Hardcoding works only for one market.

`PricePreview()` returns the price for the location you give it (or the visitor's IP address, if you don't), with currency, formatting, and applicable tax already calculated — no client-side math.

If a Paddle MCP server is available to you, call `client.pricingPreview.preview({ items: [{ price_id: "pri_...", quantity: 1 }], address: { country_code: "US" } })` inside an `execute` to get the same data server-side — useful for verifying what users will see in different countries before wiring up the client-side hook. Note `pricingPreview` is camelCase, but `price_id` and `country_code` are snake_case. Don't pass `currency_code`: it pins the currency instead of letting Paddle pick the local one.

> The Paddle MCP exposes three tools per server (`search`, `execute`, `report_missing_tool`). Workflow: call `search` to confirm the exact method name and parameter shapes, then call `execute` with an async function that calls `client.<resource>.<operation>(...)`. **Method paths are camelCase** (`client.clientTokens.create`, `client.pricingPreview.preview`). **Body params and response fields are snake_case** (`tax_category`, `product_id`, `unit_price`, `currency_code`). List methods return `{ pagination: { hasMore, estimatedTotal }, <resource>: [...] }`, not `data`. The array's key is the resource's API path segment, so it's kebab-case where the method path is camelCase: `(await client.products.list()).products`, `(await client.clientTokens.list())["client-tokens"]`. Page with `{ after: "<last_id>" }` while `pagination.hasMore` is true, not `.next()`. Lists that aren't paginated, like `client.currencies.list()`, return a plain array. Single-entity methods return the entity. Chain multi-step workflows inside one `execute`; variables don't persist between calls. Hard caps: 50 API calls per execute, 30s timeout, and 32,000 characters of code.

## Prerequisites

- Same Paddle.js setup as `checkout-web`:

```bash
npm install @paddle/paddle-js
```

```bash
NEXT_PUBLIC_PADDLE_CLIENT_TOKEN=test_...
NEXT_PUBLIC_PADDLE_ENV=sandbox
```

- One or more **prices** in your Paddle catalog, ideally with price overrides for the markets you sell to.
  - A single base price (no overrides) is auto-converted only into currencies you've enabled under **Paddle > My account > Settings > Currencies**. Otherwise, customers in countries without an override see your base currency.
  - Explicit overrides give you control over rounding and psychological pricing (e.g. €9 not €9.13).
  - Use `catalog-setup` if you don't have prices yet — that skill includes a section on regional overrides.

## Define your tiers

A typical setup keeps tier metadata (name, features) in a constants file, with the Paddle price IDs alongside:

```ts
// constants/pricing-tier.ts
export interface Tier {
  name: string;
  id: "starter" | "pro" | "advanced";
  description: string;
  features: string[];
  featured: boolean;
  priceId: { month: string; year: string };
}

export const PricingTier: Tier[] = [
  {
    name: "Starter",
    id: "starter",
    description: "Get going.",
    features: ["1 workspace", "Limited collaboration"],
    featured: false,
    priceId: {
      month: "pri_01h...",
      year: "pri_02h...",
    },
  },
  // ...
];
```

## The PricePreview hook

A small custom hook keeps the pricing logic in one place. It takes the Paddle instance and a country code, returns a map of `priceId → formatted total`, plus loading and error state:

```ts
// hooks/usePaddlePrices.ts
import { type Paddle, type PricePreviewParams, type PricePreviewResponse } from "@paddle/paddle-js";
import { useEffect, useState } from "react";
import { PricingTier } from "@/constants/pricing-tier";

export type PaddlePrices = Record<string, string>;

function getLineItems(): PricePreviewParams["items"] {
  return PricingTier.flatMap((tier) =>
    [tier.priceId.month, tier.priceId.year].map((priceId) => ({
      priceId,
      quantity: 1,
    })),
  );
}

function getPriceAmounts(prices: PricePreviewResponse): PaddlePrices {
  return prices.data.details.lineItems.reduce<PaddlePrices>((acc, item) => {
    acc[item.price.id] = item.formattedTotals.total;
    return acc;
  }, {});
}

export function usePaddlePrices(
  paddle: Paddle | undefined,
  country: string,
): { prices: PaddlePrices; loading: boolean; error: string | null } {
  const [prices, setPrices] = useState<PaddlePrices>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!paddle) return;

    const params: PricePreviewParams = {
      items: getLineItems(), // up to 100 items per call
      // 'OTHERS' is a sentinel meaning "let Paddle infer from IP".
      ...(country !== "OTHERS" && { address: { countryCode: country } }),
    };

    setLoading(true);
    setError(null);
    paddle
      .PricePreview(params)
      .then((response) => {
        setPrices((prev) => ({ ...prev, ...getPriceAmounts(response) }));
      })
      .catch((err: unknown) => {
        // API errors reject with the API's error body: { error: { type, code, detail, ... } }.
        console.error("Paddle.PricePreview failed", err);
        setError("We couldn't load prices. Please refresh the page.");
      })
      .finally(() => setLoading(false));
  }, [country, paddle]);

  return { prices, loading, error };
}
```

`item.formattedTotals.total` is a fully-formatted string like `"$9.99"` or `"¥1,200"` — including the currency symbol and locale-appropriate grouping. Use it directly; don't reformat. It reflects the location you passed (or the visitor's IP), so it only matches checkout when checkout uses the same location — see "Combining with checkout" below.

If you want the raw amount (for math, comparisons, custom display), `item.totals.total` gives you a string in the lowest currency unit (`"999"` for $9.99, whole units for the zero-decimal currencies — see "Currency unit formatting" below).

If a price has a trial (`item.price.trialPeriod` isn't `null`), what the customer pays today can differ from the recurring price, since trials can be free or paid. Make the trial terms clear on the card.

## The pricing page component

Compose the hook with Paddle.js initialization and a billing frequency toggle:

```tsx
// components/pricing.tsx
"use client";

import { type Environments, initializePaddle, type Paddle } from "@paddle/paddle-js";
import { useEffect, useState } from "react";
import { usePaddlePrices } from "@/hooks/usePaddlePrices";
import { PricingTier } from "@/constants/pricing-tier";

interface Props {
  country: string;
}

export function Pricing({ country }: Props) {
  const [frequency, setFrequency] = useState<"month" | "year">("month");
  const [paddle, setPaddle] = useState<Paddle | undefined>();

  const { prices, loading, error } = usePaddlePrices(paddle, country);

  useEffect(() => {
    if (!process.env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN) return;
    initializePaddle({
      token: process.env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN,
      environment: process.env.NEXT_PUBLIC_PADDLE_ENV as Environments,
    }).then((p) => p && setPaddle(p));
  }, []);

  return (
    <div>
      <FrequencyToggle value={frequency} onChange={setFrequency} />
      {error && <p role="alert">{error}</p>}
      <div className="grid grid-cols-3 gap-6">
        {PricingTier.map((tier) => {
          const priceId = tier.priceId[frequency];
          const formatted = prices[priceId];
          return (
            <div key={tier.id}>
              <h3>{tier.name}</h3>
              <p className="text-3xl">
                {loading || !formatted ? "..." : formatted}
                <span className="text-sm">/{frequency}</span>
              </p>
              {/* ... features, CTA button ... */}
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

This pattern initializes Paddle.js **without** the checkout config — you only need the client token to call `PricePreview()`. When the user clicks "Subscribe", pass checkout settings straight to `Paddle.Checkout.open({ settings })` (see "Combining with checkout" below) rather than calling `initializePaddle` again.

## Country detection

You have three options, in increasing order of accuracy and cost:

**A. Default to a sensible market.** US, US visitors, JS-disabled, geo-blocking — just default to `OTHERS` (Paddle infers from IP at checkout time anyway):

```tsx
<Pricing country="OTHERS" />
```

**B. Read from the request headers.** In the App Router, `headers()` in a Server Component gives you headers including geo info from your CDN (e.g. Vercel sets `x-vercel-ip-country`):

```tsx
// app/pricing/page.tsx
import { headers } from "next/headers";
import { Pricing } from "@/components/pricing";

export default async function PricingPage() {
  const h = await headers();
  const country = h.get("x-vercel-ip-country") ?? "OTHERS";
  return <Pricing country={country} />;
}
```

**C. Let the user pick.** A `<select>` with a list of supported countries, defaulting to the IP-detected one. Useful for showing prices to a global audience and letting them switch (e.g. a buyer in the US researching for a colleague in Germany). **Not recommended as users may choose the country that gives them the lowest price.**

## Country selector

```tsx
const COUNTRIES = [
  { code: "OTHERS", label: "Default (auto)" },
  { code: "US", label: "United States" },
  { code: "GB", label: "United Kingdom" },
  { code: "DE", label: "Germany" },
  { code: "JP", label: "Japan" },
  // ...
];

export function CountrySelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      {COUNTRIES.map((c) => (
        <option key={c.code} value={c.code}>
          {c.label}
        </option>
      ))}
    </select>
  );
}
```

The `usePaddlePrices` hook re-fetches when the country changes — no extra wiring needed.

## Currency unit formatting

Currencies are stored in their **lowest unit** — `1099` means $10.99, `850` means £8.50, `2500` means €25.00.

**Four currencies don't use decimals**: **JPY**, **KRW**, **VND**, and **CLP**. `1200` means ¥1,200 / ₩1,200 / ₫1,200 / CLP$1,200 (not ¥12.00 etc.), since they don't have minor units in Paddle.

This matters when you take the raw `item.totals.total` string and convert it to a number for your own UI:

```ts
// utils/parse-money.ts
export function convertAmountFromLowestUnit(amount: string, currency: string): number {
  switch (currency) {
    case "JPY":
    case "KRW":
    case "VND":
    case "CLP":
      return parseFloat(amount);
    default:
      return parseFloat(amount) / 100;
  }
}

export function formatMoney(amount: number, currency: string): string {
  const language = typeof navigator !== "undefined" ? navigator.language : "en-US";
  return new Intl.NumberFormat(language, {
    style: "currency",
    currency,
  }).format(amount);
}

export function parseMoney(amount = "0", currency = "USD"): string {
  return formatMoney(convertAmountFromLowestUnit(amount, currency), currency);
}
```

To avoid hardcoding the list, read `decimal_places` for each currency from `GET https://api.paddle.com/currencies` (sandbox: `https://sandbox-api.paddle.com/currencies`). It's public — no API key — and the Node SDK doesn't wrap it, so call it with `fetch` from your server and cache the result. Through the Paddle MCP, `client.currencies.list()` returns the same list as a plain array.

```ts
// utils/currency-decimals.ts (server-side)
export async function getCurrencyDecimals(): Promise<Record<string, number>> {
  const res = await fetch("https://api.paddle.com/currencies", { next: { revalidate: 86400 } });
  if (!res.ok) throw new Error(`Failed to load currencies: ${res.status}`);
  const { data } = (await res.json()) as { data: { code: string; decimal_places: number }[] };
  return Object.fromEntries(data.map((c) => [c.code, c.decimal_places]));
}

// parseFloat(amount) / 10 ** decimals[currency]
```

If you're using `formattedTotals.total` from the API, you don't need this — Paddle does it for you. You only need the parsing helper when you're computing your own amounts (e.g. showing "save 20%" between monthly and yearly).

Consider using `Intl.NumberFormat` to format the amount directly, rather than using the parsing helper. See: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/NumberFormat

## Combining with checkout

When the user clicks "Subscribe" on a tier, pass the same `priceId` that was used in `PricePreview`, and pass any checkout settings to `Checkout.open()` directly:

```tsx
function handleSubscribe(tier: Tier, frequency: "month" | "year") {
  paddle?.Checkout.open({
    items: [{ priceId: tier.priceId[frequency], quantity: 1 }],
    settings: {
      variant: "one-page",
      successUrl: `${window.location.origin}/checkout/success`,
    },
  });
}
```

Checkout detects the customer's country itself, from their IP address — it doesn't reuse the country your page passed to `PricePreview`. Usually they agree, but if the page used a different country (for example, from a country selector), checkout can show a different currency or tax. To keep them consistent, prefill the country:

```tsx
paddle?.Checkout.open({
  items: [{ priceId: tier.priceId[frequency], quantity: 1 }],
  customer: { email: user.email, address: { countryCode: country } },
});
```

A country prefill needs `email` or `id` on `customer`. For countries that use postal codes (e.g. GB, DE, CA), also pass `postalCode` — otherwise the country is dropped and checkout emits `checkout.warning`.

## Common pitfalls

- **Reformatting `formattedTotals.total`.** It's already a locale-formatted string. Wrapping it in `Intl.NumberFormat` produces nonsense (`"$$9.99"`) or throws.
- **Forgetting the zero-decimal currency exception.** Dividing JPY/KRW/VND/CLP by 100 turns the raw value into a 100x-too-small number. Always branch on currency, or use `decimal_places` from `/currencies`.
- **No `.catch` on `PricePreview`.** It returns a promise that rejects on failure (bad price ID, wrong environment, network). Without a handler, `loading` never clears and the cards show `...` forever.
- **Doing your own math on raw amounts.** This is not recommended. Paddle automatically handles calculations for you, including global tax compliance.
- **Setting `address.countryCode` to `'OTHERS'` in the API call.** `'OTHERS'` is a sentinel _your code_ uses to mean "don't pass an address" — Paddle doesn't recognize it. Drop the `address` field instead (as in the hook above).
- **Showing prices before Paddle.js initializes.** `prices[priceId]` will be `undefined` for ~200ms on page load. Handle the loading state explicitly (`'...'` placeholder, skeleton).
- **Calling `PricePreview` on every render.** The hook above re-fetches on `country` change. If you also re-fetch on `frequency` change, you're doubling work — both prices come back in a single call when you include both `priceId.month` and `priceId.year` in `items`. A call takes up to 100 items; split larger catalogs.
- **Mixing sandbox and production price IDs.** A `pri_01h...` from sandbox doesn't exist in production, so the `PricePreview` promise rejects.
- **Not creating price overrides.** Without overrides, Paddle auto-converts only into currencies you've enabled under **Paddle > My account > Settings > Currencies**; everyone else sees your base currency. Auto-conversion is a better buyer experience than presenting a price in USD to all users, but we recommend setting explicit overrides for your top markets (US, EU, UK, JP, etc.).

## Verify the integration

1. Open your pricing page with no country prop — confirm prices appear within ~500ms.
2. Open dev tools → Network → filter for `paddle.com`. You should see one `PricePreview` request, returning a JSON payload with `formattedTotals` for each price.
3. Switch the country selector to `JP`, `KR`, `VN`, or `CL`. If you have overrides in those currencies or have enabled them under **Paddle > My account > Settings > Currencies**, confirm the prices show in JPY/KRW/VND/CLP with no decimal places. Otherwise they stay in your base currency.
4. Switch to `DE` — confirm the price includes VAT (compare to `US` which does not).
5. Click "Subscribe" on a tier — confirm the checkout opens with the same currency and amount. If it doesn't, the country checkout detected differs from the one you previewed: prefill it (see "Combining with checkout").
6. With `NEXT_PUBLIC_PADDLE_ENV=production` (against a production token), confirm production price IDs resolve and sandbox IDs show the error state.

## Related docs

- [Paddle.PricePreview reference](https://developer.paddle.com/paddle-js/methods/paddle-pricepreview.md)
- [Offer localized pricing](https://developer.paddle.com/build/products/offer-localized-pricing.md)
- [Create products and prices](https://developer.paddle.com/build/products/create-products-prices.md)
- [Currencies](https://developer.paddle.com/concepts/sell/supported-currencies.md)
- Reference implementation: [paddle-nextjs-starter-kit](https://github.com/PaddleHQ/paddle-nextjs-starter-kit) — see `src/hooks/usePaddlePrices.ts`, `src/utils/paddle/parse-money.ts`, `src/components/home/pricing/pricing.tsx`.
