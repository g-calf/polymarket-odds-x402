# Distribution — post today

One-tap-ready copy for each channel. Edit tone if you want but the facts are checked.

Key links to reuse everywhere:
- API: https://polymarket-odds-x402.goldencalf.workers.dev
- MCP: https://www.npmjs.com/package/@gcalf/mcp
- Repo: https://github.com/g-calf/polymarket-odds-x402
- Service manifest: https://polymarket-odds-x402.goldencalf.workers.dev/.well-known/x402
- llms.txt: https://polymarket-odds-x402.goldencalf.workers.dev/llms.txt
- OpenAPI: https://polymarket-odds-x402.goldencalf.workers.dev/openapi.json

---

## Twitter / X — thread, 5 tweets

**1/** Shipped an x402-paid API for prediction market odds on Base mainnet.

Agents fetch live Polymarket + Kalshi odds for $0.005/call in USDC. No API keys. No accounts. No subscriptions. 🧵

**2/** Why x402: every agent shop today either (a) ships their own scrapers, (b) hits free APIs that break, or (c) burns weeks on vendor contracts.

x402 lets an agent just sign a $0.005 USDC auth and get the data. Facilitator pays gas. Done.

**3/** Four paid endpoints at https://polymarket-odds-x402.goldencalf.workers.dev

• `/api/polymarket/odds` — $0.005
• `/api/polymarket/odds-cheap` — $0.001 (price A/B)
• `/api/polymarket/odds/batch` — $0.02 for up to 20 slugs
• `/api/kalshi/odds` — $0.005

Full /openapi.json + /llms.txt + /.well-known/x402 for discovery.

**4/** For Claude Desktop / any MCP runtime:
```
npm install -g @gcalf/mcp
```
Three tools auto-register. Set CLIENT_PRIVATE_KEY to a funded Base wallet (~$1 USDC = 200 calls).

**5/** Marginal cost ≈ $0. Polymarket Gamma + Kalshi public APIs are free. Cloudflare Workers runtime is free. Facilitator eats on-chain gas. Agent pays $0.005 → clean margin.

Source + docs: https://github.com/g-calf/polymarket-odds-x402

Reply with questions / breakage / feature asks.

---

## x402 Discord (or wherever x402 builders hang)

**Title / subject:** Live x402 endpoint for Polymarket + Kalshi odds — pay $0.005 per call

**Body:**

Hey — just shipped a working x402 service on Base mainnet. Live at `polymarket-odds-x402.goldencalf.workers.dev`.

Four endpoints:
- `GET /api/polymarket/odds?slug=<slug>` — $0.005
- `GET /api/polymarket/odds-cheap?slug=<slug>` — $0.001 (price elasticity test)
- `GET /api/polymarket/odds/batch?slugs=<a,b,c>` — $0.02 for up to 20 slugs
- `GET /api/kalshi/odds?ticker=<ticker>` — $0.005

Discovery metadata ready-to-crawl:
- `/.well-known/x402` — service manifest
- `/openapi.json` — OpenAPI 3.1
- `/llms.txt` — plaintext summary
- `/.well-known/agent.json` + `agent-card.json` + `agents.json` — agent-card format
- Listed in payai Bazaar (search by payTo `0xE5126f9Cf0fab2B709D932b2516Ade946ebD9629`)

For MCP-native agents: `npm install -g @gcalf/mcp` → three tools register.

Response has: outcomes with implied probabilities, 24h volume, liquidity, resolution date. Full JSON Schema in the Bazaar discovery extension.

Pre-paywall validator: bad slugs return 404 without taking payment — agents don't churn on invalid IDs.

Source: `https://github.com/g-calf/polymarket-odds-x402`

Would love: feedback on pricing, which additional endpoints would actually get used, and any discovery/Bazaar listings I'm missing.

---

## Hacker News "Show HN" (save for later, needs ~10 external paid calls as proof)

**Title:** Show HN: Live Polymarket+Kalshi odds API, $0.005/call via x402 micropayments

Don't post yet. Post once analytics show >=10 external paid calls. Then add that number to the opening line as social proof.

---

## Short DM / cold outreach (to agent framework maintainers: LangChain, CrewAI, AutoGen, AgentKit)

Subject: x402 tool for prediction market odds — fit for your tool registry?

Hi — I run an x402-gated API for Polymarket and Kalshi odds. Agents pay $0.005/call in USDC on Base mainnet. No auth, no accounts, works today.

Published MCP server (`@gcalf/mcp` on npm), full OpenAPI, agent-card manifests at the expected `.well-known` paths. Works out of the box with MCP-aware runtimes; happy to ship a direct <framework name> integration if there's interest.

Appeal: prediction markets are a strong real-time signal for agents reasoning about sports, elections, crypto, macro. Replaces scraping/vendor-contract paths with a single paid request.

Repo: https://github.com/g-calf/polymarket-odds-x402

---

## r/PredictionMarkets, r/AlgorithmicTrading, Polymarket Discord

Slightly different angle — emphasize the *data* more than the protocol:

**Title:** Hosted paid API for Polymarket + Kalshi odds (fresh every call)

Built a tiny API that returns live implied odds from Polymarket and Kalshi. No caching, no API keys, pay per call ($0.005 in USDC on Base). Four endpoints: single-market Polymarket, cheap variant, batch of 20, single-market Kalshi.

Primary use case is autonomous agents / bots that want clean, fresh odds without scraping or vendor contracts, but humans can call it directly too. Full docs + install at https://polymarket-odds-x402.goldencalf.workers.dev

Feedback welcome, especially on what additional endpoints would be useful.

---

## Where to post, ranked

1. **x402 Discord** — most concentrated buyer pool; post first.
2. **Twitter/X** — reach + optionality for retweets; post second with the thread above.
3. **MCP / Anthropic Discord** — MCP server is the frictionless install. Thread the install instructions.
4. **Polymarket Discord (dev channel)** — your users already hang here; soft-sell the data angle.
5. **r/PredictionMarkets** — smaller, concentrated interest.
6. **Direct DMs to agent framework maintainers** — slow, high per-contact value. Save for after broadcast lands.
7. **HN Show HN** — wait for traction before spending this card.

## Likely first-question replies (keep handy)

- **"How do I pay without burning my main wallet?"** → generate a disposable Base wallet, fund it with $1 USDC, use it as CLIENT_PRIVATE_KEY. One-liner in the mcp-server README.
- **"Is x402 safe?"** → yes, EIP-3009 TransferWithAuthorization is a signature-based gasless transfer standard. Your signature authorizes ONE transfer of a specific amount to a specific recipient. Nothing else can be done with it.
- **"What happens if the market doesn't exist?"** → 404 without payment. Pre-paywall validator fetches upstream before settling; invalid slugs/tickers never cost anything.
- **"Can I use this without crypto?"** → not today. x402 is on-chain. If this is a real constraint for you, DM me — if there's volume I'd add Stripe.
- **"How many agents are using this?"** → be honest with real numbers. Silence or vague answers kill trust.
- **"Where's the dashboard / UI?"** → there isn't one; the product is the API. Metrics via Cloudflare Analytics Engine (queryable via SQL).
