# Distribution drafts

Copy-paste material for different channels. Edit to your voice before posting.

---

## Twitter / X thread (6 tweets)

**1/** Just shipped an x402-paid API for prediction market odds on Base mainnet.

Agents can fetch live Polymarket + Kalshi odds for $0.005/call in USDC. No API keys, no accounts, no signup. Pay per request. 🧵

**2/** Why x402: every agent shop today either (a) ships their own data integrations, (b) hardcodes free scrapes that break, or (c) burns engineering on vendor contracts. x402 lets them just pay a half-cent and move on.

**3/** Four endpoints, all on https://polymarket-odds-x402.goldencalf.workers.dev :
• /api/polymarket/odds?slug=... ($0.005)
• /api/kalshi/odds?ticker=... ($0.005)
• /api/polymarket/odds/batch ($0.02, up to 20 slugs)
• /api/polymarket/odds-cheap ($0.001, price A/B test)

**4/** For Claude Desktop & MCP-aware agents:
```
npm install -g @gcalf/mcp
```
Three tools auto-register. Pays from a wallet you control. Full setup → github in reply.

**5/** No marginal cost on our end. Gamma + Kalshi public APIs upstream. Cloudflare Workers runtime. Facilitator pays the on-chain gas. Agent pays $0.005 USDC, we clear ~$0.005 minus facilitator fee. Clean margin.

**6/** Listed on x402 Bazaar (payai). Source + docs: https://gitlab.com/alxndrwlsn/goldencalf
Try it. Break it. DMs open.

---

## Discord / forum post (x402 community, Polymarket community, agent-dev subreddits)

**Title:** Live x402-gated API for Polymarket + Kalshi odds — pay $0.005 per call

Hey — just shipped a working x402 endpoint on Base mainnet that any agent can call to get live implied odds from Polymarket or Kalshi. $0.005/call, no auth, no account.

**Endpoints:**
- `GET /api/polymarket/odds?slug=<slug>` — $0.005
- `GET /api/kalshi/odds?ticker=<ticker>` — $0.005
- `GET /api/polymarket/odds/batch?slugs=<a,b,c>` — $0.02 for up to 20 slugs
- Plus a $0.001 cheap variant to probe price elasticity

**Base URL:** `https://polymarket-odds-x402.goldencalf.workers.dev`

**MCP server:** `npm install -g @gcalf/mcp` → set `CLIENT_PRIVATE_KEY` in your Claude Desktop (or other MCP runtime) config → three tools auto-register.

**TypeScript one-liner:** uses standard `@x402/fetch` + viem signer. Example in the README.

Response has: outcomes with implied probabilities, 24h volume, liquidity, resolution date, active/closed flags. Full JSON Schema is published in the Bazaar discovery metadata so agents can parse without reading docs.

Source: https://gitlab.com/alxndrwlsn/goldencalf
Feedback welcome — especially on pricing and what endpoints would actually get used.

---

## Direct outreach: agent framework maintainers (LangChain, CrewAI, AutoGen, AgentKit)

**Subject:** x402 tool for Polymarket + Kalshi odds — would this fit your tool registry?

Hi — I ship an x402-gated API returning live implied odds from Polymarket and Kalshi. Agents pay $0.005/call in USDC on Base mainnet. No auth, no accounts, works today.

I've also published an MCP server (`goldencalf-mcp` on npm) that wraps it. For frameworks that haven't adopted MCP, I can ship a direct integration if there's interest — it's ~30 lines of code.

The appeal for your users: prediction markets are a strong data source for agents reasoning about near-term events (sports, elections, macro). Getting that data cleanly without scraping or vendor contracts is table-stakes for anything agentic in that space.

Happy to open a PR if it fits. Repo: https://gitlab.com/alxndrwlsn/goldencalf

---

## One-paragraph version for cold DMs / short posts

I built an x402-paid endpoint on Base mainnet that returns live implied odds for Polymarket and Kalshi markets at $0.005/call. For Claude Desktop and other MCP runtimes, `npm install -g @gcalf/mcp` gives you three tools out of the box. For TypeScript agents, use `@x402/fetch` with a funded wallet. Source and docs: https://gitlab.com/alxndrwlsn/goldencalf

---

## Where to post, ranked

1. **x402 Discord / Twitter** — people building x402 agents are already looking for resources. Highest signal-to-noise.
2. **Polymarket Discord (dev channel)** — your users already live here. Anyone building bots/dashboards is a candidate.
3. **MCP community (Anthropic Discord, MCP GitHub discussions)** — the MCP server distribution is the easiest ramp for Claude users.
4. **r/PredictionMarkets** — smaller audience, but concentrated interest.
5. **Hacker News Show HN** — only if you have a landing page and ~10 successful external paid calls to point to. Posting too early = wasted shot.
6. **LangChain / CrewAI Discord tool-sharing channels** — niche but the exact buyer.

## Don't post to

- General LLM / AI subreddits (noise-dominated, not your audience)
- Crypto Twitter without the x402 framing (reads as spam)
- Product Hunt (wrong buyer; you're selling to agents, not humans)
