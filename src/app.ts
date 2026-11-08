import { Hono } from "hono";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";

export type Env = {
  PAYOUT_ADDRESS: string;
  NETWORK: string;
  FACILITATOR_URL: string;
};

export type OddsResponse = {
  slug: string;
  question: string;
  outcomes: Array<{ name: string; price: number; probability: string }>;
  volume24hr: number | null;
  liquidity: number | null;
  endDate: string | null;
  active: boolean;
  closed: boolean;
  source: "polymarket";
  timestamp: string;
};

const GAMMA_BASE = "https://gamma-api.polymarket.com";

// Gamma returns outcomes/outcomePrices as JSON-stringified arrays. Parse them
// into a flat list and drop markets whose shape we don't understand.
function parseStringArray(raw: unknown): string[] | null {
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((x) => typeof x === "string")
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function roundCents(n: unknown): number | null {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

function reshape(market: Record<string, unknown>): OddsResponse | null {
  const names = parseStringArray(market.outcomes);
  const prices = parseStringArray(market.outcomePrices);
  if (!names || !prices || names.length !== prices.length) return null;

  const outcomes = names.map((name, i) => {
    const price = Number(prices[i]);
    const safe = Number.isFinite(price) ? price : 0;
    return {
      name,
      price: safe,
      probability: `${(safe * 100).toFixed(1)}%`,
    };
  });

  return {
    slug: String(market.slug ?? ""),
    question: String(market.question ?? ""),
    outcomes,
    volume24hr: roundCents(market.volume24hr),
    liquidity: roundCents(market.liquidityNum),
    endDate: typeof market.endDate === "string" ? market.endDate : null,
    active: Boolean(market.active),
    closed: Boolean(market.closed),
    source: "polymarket",
    timestamp: new Date().toISOString(),
  };
}

export function buildApp(env: Env) {
  const app = new Hono();

  const facilitator = new HTTPFacilitatorClient({ url: env.FACILITATOR_URL });
  const resourceServer = new x402ResourceServer(facilitator).register(
    env.NETWORK,
    new ExactEvmScheme(),
  );

  app.use(
    paymentMiddleware(
      {
        "GET /api/polymarket/odds": {
          accepts: [
            {
              scheme: "exact",
              price: "$0.005",
              network: env.NETWORK,
              payTo: env.PAYOUT_ADDRESS,
            },
          ],
          description:
            "Current implied odds for a single Polymarket market, looked up by slug.",
          mimeType: "application/json",
          extensions: {
            ...declareDiscoveryExtension({
              method: "GET",
              pathParamsSchema: {
                type: "object",
                properties: {
                  slug: {
                    type: "string",
                    description:
                      "Polymarket market slug (the trailing path segment on polymarket.com/event/<slug>).",
                  },
                },
                required: ["slug"],
              },
              output: {
                example: {
                  slug: "epl-sun-che-2026-11-08-che",
                  question: "Will Chelsea FC win on 2026-11-08?",
                  outcomes: [
                    { name: "Yes", price: 0.515, probability: "51.5%" },
                    { name: "No", price: 0.485, probability: "48.5%" },
                  ],
                  volume24hr: 4866037.76,
                  liquidity: 854785.91,
                  endDate: "2026-11-08T14:00:00Z",
                  active: true,
                  closed: false,
                  source: "polymarket",
                  timestamp: "2026-11-08T12:00:00.000Z",
                },
              },
            }),
          },
        },
      },
      resourceServer,
    ),
  );

  app.get("/api/polymarket/odds", async (c) => {
    const slug = c.req.query("slug");
    if (!slug) {
      return c.json({ error: "missing required query param: slug" }, 400);
    }

    const upstream = await fetch(
      `${GAMMA_BASE}/markets/slug/${encodeURIComponent(slug)}`,
      { headers: { accept: "application/json" } },
    );

    if (upstream.status === 404) {
      return c.json({ error: `no market found for slug: ${slug}` }, 404);
    }
    if (!upstream.ok) {
      return c.json(
        { error: "upstream polymarket error", status: upstream.status },
        502,
      );
    }

    const market = (await upstream.json()) as Record<string, unknown>;
    const shaped = reshape(market);
    if (!shaped) {
      return c.json(
        { error: "market response could not be parsed", slug },
        502,
      );
    }
    return c.json(shaped);
  });

  app.get("/", (c) =>
    c.json({
      service: "polymarket-odds-x402",
      endpoints: ["GET /api/polymarket/odds?slug=<market-slug>"],
      pricing: "$0.005 per request",
      network: env.NETWORK,
    }),
  );

  return app;
}
