#!/usr/bin/env node
/**
 * goldencalf-mcp
 *
 * MCP server that exposes Polymarket + Kalshi odds to any MCP-aware agent
 * runtime (Claude Desktop, etc.). Internally pays x402 micropayments on
 * Base mainnet via the user-supplied wallet for every call.
 *
 * Config (via env vars, usually set in the MCP client config file):
 *   CLIENT_PRIVATE_KEY   0x... (REQUIRED). The signing wallet for payments.
 *   GOLDENCALF_API_URL   Override the API base URL (default: production).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { privateKeyToAccount } from "viem/accounts";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";

const API_URL =
  process.env.GOLDENCALF_API_URL ??
  "https://polymarket-odds-x402.goldencalf.workers.dev";

const pk = process.env.CLIENT_PRIVATE_KEY as `0x${string}` | undefined;
if (!pk) {
  console.error(
    "ERROR: CLIENT_PRIVATE_KEY env var is required. This is the signing key for the wallet that pays for each call. Fund it with Base mainnet USDC.",
  );
  process.exit(1);
}

const account = privateKeyToAccount(pk);
const x402 = new x402Client();
registerExactEvmScheme(x402, { signer: account });
const paidFetch = wrapFetchWithPayment(fetch, x402);

async function callApi<T>(path: string): Promise<T> {
  const res = await paidFetch(`${API_URL}${path}`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API ${res.status}: ${body.slice(0, 500)}`);
  }
  return (await res.json()) as T;
}

const server = new McpServer({
  name: "goldencalf-mcp",
  version: "0.1.0",
});

server.registerTool(
  "get_polymarket_odds",
  {
    title: "Get Polymarket odds",
    description:
      "Fetch current implied odds for a single Polymarket prediction market. Costs $0.005 USDC per call on Base mainnet. Returns outcomes, prices (as decimals 0-1), volume, liquidity, and resolution date.",
    inputSchema: {
      slug: z
        .string()
        .describe(
          "Polymarket market slug (trailing segment of polymarket.com/event/<slug>).",
        ),
    },
  },
  async ({ slug }) => {
    const data = await callApi(
      `/api/polymarket/odds?slug=${encodeURIComponent(slug)}`,
    );
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  },
);

server.registerTool(
  "get_kalshi_odds",
  {
    title: "Get Kalshi odds",
    description:
      "Fetch current implied odds for a single Kalshi prediction market. Costs $0.005 USDC per call on Base mainnet. Prices are mid-market (bid+ask)/2 from the Kalshi orderbook.",
    inputSchema: {
      ticker: z
        .string()
        .describe(
          "Kalshi market ticker (e.g. KXNFLGAME-26NOV16LACBAL-LAC). Format: SERIES-DATE-OUTCOME.",
        ),
    },
  },
  async ({ ticker }) => {
    const data = await callApi(
      `/api/kalshi/odds?ticker=${encodeURIComponent(ticker)}`,
    );
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  },
);

server.registerTool(
  "get_polymarket_odds_batch",
  {
    title: "Get Polymarket odds (batch)",
    description:
      "Fetch odds for up to 20 Polymarket markets in one call. Costs $0.02 USDC total (vs. 20 x $0.005 = $0.10 for singles). Returns an array of odds plus any per-slug errors.",
    inputSchema: {
      slugs: z
        .array(z.string())
        .min(1)
        .max(20)
        .describe("Array of Polymarket market slugs (max 20)."),
    },
  },
  async ({ slugs }) => {
    const data = await callApi(
      `/api/polymarket/odds/batch?slugs=${encodeURIComponent(slugs.join(","))}`,
    );
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`goldencalf-mcp connected. API=${API_URL} client=${account.address}`);
