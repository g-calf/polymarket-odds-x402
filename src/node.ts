import { serve } from "@hono/node-server";
import { buildApp, type Env } from "./app";

const env: Env = {
  PAYOUT_ADDRESS: process.env.PAYOUT_ADDRESS ?? "0xYOUR_WALLET_HERE",
  NETWORK: process.env.NETWORK ?? "eip155:84532",
  FACILITATOR_URL:
    process.env.FACILITATOR_URL ?? "https://x402.org/facilitator",
};

const port = Number(process.env.PORT ?? 8787);
const app = buildApp(env);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`polymarket-odds-x402 listening on http://localhost:${info.port}`);
  console.log(`  payout:      ${env.PAYOUT_ADDRESS}`);
  console.log(`  network:     ${env.NETWORK}`);
  console.log(`  facilitator: ${env.FACILITATOR_URL}`);
});
