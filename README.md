# goldencalf — Polymarket + Kalshi odds via x402

Agent-native API that returns live implied odds for prediction markets,
gated by x402 micropayments on Base mainnet. No API keys, no accounts, no
subscriptions — pay per call in USDC.

**Live:** https://polymarket-odds-x402.goldencalf.workers.dev

## Endpoints

| Endpoint | Price | Description |
|---|---|---|
| `GET /api/polymarket/odds?slug=<slug>` | $0.005 | Single Polymarket market |
| `GET /api/polymarket/odds-cheap?slug=<slug>` | $0.001 | Same, cheaper (price A/B test) |
| `GET /api/polymarket/odds/batch?slugs=<a,b,c>` | $0.02 | Up to 20 Polymarket slugs |
| `GET /api/kalshi/odds?ticker=<ticker>` | $0.005 | Single Kalshi market |

## Response schema (single)

```json
{
  "id": "epl-sun-che-2026-11-08-che",
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

Batch endpoint returns `{ odds: OddsResponse[], errors: {id,error}[], timestamp }`.

Full JSON Schema is published in the x402 Bazaar discovery metadata — agents
can parse without reading these docs.

## Call it from an agent

### Claude Desktop / any MCP client (easiest)

```bash
npm install -g @gcalf/mcp
```

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "goldencalf": {
      "command": "goldencalf-mcp",
      "env": { "CLIENT_PRIVATE_KEY": "0xYOUR_FUNDED_WALLET_KEY" }
    }
  }
}
```

Three tools auto-register: `get_polymarket_odds`, `get_kalshi_odds`,
`get_polymarket_odds_batch`. See [`mcp-server/README.md`](./mcp-server/README.md).

### TypeScript / Node.js

```ts
import { privateKeyToAccount } from "viem/accounts";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";

const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);
const client = new x402Client();
registerExactEvmScheme(client, { signer: account });
const paidFetch = wrapFetchWithPayment(fetch, client);

const res = await paidFetch(
  "https://polymarket-odds-x402.goldencalf.workers.dev/api/polymarket/odds?slug=epl-sun-che-2026-11-08-che"
);
console.log(await res.json());
```

### Python

```py
import os
from eth_account import Account
# community x402 Python client
from x402 import X402Session

session = X402Session(private_key=os.environ["PRIVATE_KEY"])
r = session.get(
  "https://polymarket-odds-x402.goldencalf.workers.dev/api/polymarket/odds",
  params={"slug": "epl-sun-che-2026-11-08-che"},
)
print(r.json())
```

### Plain curl (see the 402 shape)

```bash
curl -i "https://polymarket-odds-x402.goldencalf.workers.dev/api/polymarket/odds?slug=epl-sun-che-2026-11-08-che"
# → HTTP 402 Payment Required with `payment-required` header (base64 JSON)
# Decode the header, sign an EIP-3009 authorization, retry with `X-PAYMENT`
```

## Wallet setup

The calling agent needs a wallet with USDC on Base mainnet. **Do not use your
main wallet** — generate a disposable key for agent calls:

```bash
node -e "import('viem/accounts').then(m => { const pk = m.generatePrivateKey(); console.log('pk:', pk); console.log('addr:', m.privateKeyToAccount(pk).address) })"
```

Fund with ~$1 USDC on Base mainnet (= ~200 single calls). No ETH needed —
the x402 facilitator covers on-chain gas.

## Discovery

Listed in the [x402 Bazaar](https://facilitator.payai.network/discovery/resources).
Agents can find this endpoint without ever reading this README.

## How it works

```
agent → x402 client signs EIP-3009 authorization
     → request with X-PAYMENT header
     → Cloudflare Worker:
          pre-paywall validator fetches upstream (if 404, bail before paying)
          payment middleware verifies signature + settles via facilitator
          handler returns the reshaped odds
     → agent gets 200 JSON
```

Upstream data comes from:
- [Polymarket Gamma API](https://gamma-api.polymarket.com) (public, no auth)
- [Kalshi public markets API](https://api.elections.kalshi.com/trade-api/v2) (public, no auth)

## Repo layout

```
src/app.ts              # Hono app + x402 middleware + reshape logic
src/index.ts            # Cloudflare Workers entry
src/node.ts             # Node.js dev entry
scripts/client.ts       # Example x402-fetch paying client
scripts/client-kalshi.ts
scripts/batch.ts        # 10-call sequential batch demo
mcp-server/             # Published as `goldencalf-mcp` on npm
wrangler.jsonc          # CF Worker config (payout wallet, network, facilitator, analytics)
```

## Deploy

```bash
# From WSL/Linux ARM64 or any non-Windows ARM64 machine:
cd ~/polymarket-odds-x402
CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... npx wrangler deploy
```

Analytics queryable via Workers Analytics Engine SQL API:

```bash
curl -X POST \
  'https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/analytics_engine/sql' \
  -H 'Authorization: Bearer <CF_TOKEN>' \
  -d 'SELECT blob1 as path, blob3 as paid, blob4 as status,
         count() as hits, avg(double1) as avg_ms
       FROM polymarket_odds_x402
       WHERE timestamp > NOW() - INTERVAL "1" DAY
       GROUP BY path, paid, status ORDER BY hits DESC FORMAT JSON'
```
