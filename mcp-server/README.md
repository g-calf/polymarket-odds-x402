# @gcalf/mcp

MCP (Model Context Protocol) server exposing live Polymarket and Kalshi
prediction market odds to any MCP-aware agent runtime. Each call is paid in
USDC on Base mainnet via the x402 protocol — no API keys, no accounts, no
subscriptions.

## Tools

- `get_polymarket_odds(slug)` — $0.005 USDC
- `get_kalshi_odds(ticker)` — $0.005 USDC
- `get_polymarket_odds_batch(slugs: string[])` — $0.02 USDC total (up to 20 slugs)

## Install

```bash
npm install -g @gcalf/mcp
```

## Configure for Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`
(macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "goldencalf": {
      "command": "goldencalf-mcp",
      "_comment": "the `bin` name stays unscoped even though the package is @alxndrwlsn/goldencalf-mcp",
      "env": {
        "CLIENT_PRIVATE_KEY": "0xYOUR_FUNDED_TEST_WALLET_PRIVATE_KEY"
      }
    }
  }
}
```

Restart Claude Desktop. In any chat, ask:

> What are the current odds on Polymarket for `will-x-happen-2026-12`?

Claude will call `get_polymarket_odds` which transparently pays $0.005 in
USDC and returns the live odds.

## Wallet setup

You need a wallet with a small USDC balance on Base mainnet. **Do not use
your main wallet** — create a disposable one for agent payments.

```bash
# generate a test wallet
node -e "import('viem/accounts').then(m => { const pk = m.generatePrivateKey(); console.log('pk:', pk); console.log('addr:', m.privateKeyToAccount(pk).address) })"
```

Fund the printed address with ~$1 USDC on Base mainnet (enough for ~200
single calls). Use Coinbase Wallet or an exchange withdrawal with Base
network selected. No ETH needed — the x402 facilitator covers gas.

## Underlying API

Same server-side endpoints documented at:
- Live: https://polymarket-odds-x402.goldencalf.workers.dev
- Source: https://gitlab.com/alxndrwlsn/goldencalf

## License

MIT
