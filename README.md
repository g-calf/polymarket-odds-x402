# polymarket-odds-x402

A single-endpoint API that returns current implied odds for a Polymarket market,
gated by an x402 micropayment of $0.005 USDC.

The whole product is this one route:

```
GET /api/polymarket/odds?slug=<market-slug>
```

It fetches from Polymarket's public Gamma API, reshapes the response into a
tight schema, and charges per call via the x402 protocol. Discoverable through
the [x402 Bazaar](https://bazaar.x402.org).

## Response schema

```json
{
  "slug": "epl-sun-che-2026-11-08-che",
  "question": "Will Chelsea FC win on 2026-11-08?",
  "outcomes": [
    { "name": "Yes", "price": 0.515, "probability": "51.5%" },
    { "name": "No",  "price": 0.485, "probability": "48.5%" }
  ],
  "volume24hr": 4866037.76,
  "liquidity": 854785.91,
  "endDate": "2026-11-08T14:00:00Z",
  "active": true,
  "closed": false,
  "source": "polymarket",
  "timestamp": "2026-11-08T12:00:00.000Z"
}
```

## Setup

```bash
npm install
```

Edit `wrangler.jsonc` and replace `0xYOUR_WALLET_HERE` with the Base address
that should receive USDC. For first-run testing, leave `NETWORK` on
`eip155:84532` (Base Sepolia) and `FACILITATOR_URL` on
`https://x402.org/facilitator`.

## Local dev

```bash
npm run dev
```

Then hit the service:

```bash
# Discovery root — unprotected, returns the endpoint catalog
curl http://localhost:8787/

# Protected endpoint — returns a 402 with payment instructions
curl -i "http://localhost:8787/api/polymarket/odds?slug=epl-sun-che-2026-11-08-che"
```

The second call returns HTTP 402 with a JSON body describing the payment
requirements. An x402-aware client (or the `x402-fetch` library) will read the
402, send USDC to the facilitator, retry with an `X-PAYMENT` header, and
receive the real 200 response.

## Testing the full pay loop

Use a client that speaks x402. Example with `x402-fetch` against Base Sepolia:

```ts
import { wrapFetchWithPayment } from "x402-fetch";
import { privateKeyToAccount } from "viem/accounts";

const account = privateKeyToAccount(process.env.TEST_PRIVATE_KEY as `0x${string}`);
const paidFetch = wrapFetchWithPayment(fetch, account);

const res = await paidFetch(
  "http://localhost:8787/api/polymarket/odds?slug=epl-sun-che-2026-11-08-che",
);
console.log(await res.json());
```

Fund the test account from a Base Sepolia USDC faucet before calling.

## Going to mainnet

1. Verify the 402 → pay → 200 loop works on `eip155:84532`.
2. In `wrangler.jsonc`, set:
   - `NETWORK` → `"eip155:8453"` (Base mainnet)
   - `FACILITATOR_URL` → `"https://api.cdp.coinbase.com/platform/v2/x402"`
   - `PAYOUT_ADDRESS` → the real USDC receiving wallet
3. `npm run deploy`

Bazaar indexing happens automatically within ~30 seconds of the first
confirmed payment that carries the declared discovery metadata — nothing extra
to register.

## Pricing

$0.005 per request. Marginal cost is near zero (Gamma is free, no proxy
layer). For a batch endpoint ("top 20 markets by volume with odds") price at
$0.01–$0.02 and add it as a second route in `src/index.ts`.

## Files

- `src/index.ts` — Hono app, x402 middleware, Gamma fetch + reshape, Bazaar extension.
- `wrangler.jsonc` — Cloudflare Worker config; holds wallet, network, facilitator.
- `package.json` — deps: `hono`, `@x402/hono`, `@x402/core`, `@x402/evm`, `@x402/extensions`.
