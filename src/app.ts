import { Hono } from "hono";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";

export type Env = {
  PAYOUT_ADDRESS: string;
  NETWORK: string;
  FACILITATOR_URL: string;
  // Analytics Engine binding (optional: absent locally under Node).
  ANALYTICS?: {
    writeDataPoint(event: {
      blobs?: string[];
      doubles?: number[];
      indexes?: string[];
    }): void;
  };
};

// Per-request Hono context vars.
type Vars = { odds: OddsResponse };

export type OddsResponse = {
  // Native identifier: Polymarket slug or Kalshi ticker.
  id: string;
  question: string;
  outcomes: Array<{ name: string; price: number; probability: string }>;
  volume24hr: number | null;
  liquidity: number | null;
  endDate: string | null;
  active: boolean;
  closed: boolean;
  source: "polymarket" | "kalshi";
  timestamp: string;
};

type UpstreamResult =
  | { ok: true; data: OddsResponse }
  | { ok: false; status: number; message: string };

const POLYMARKET_BASE = "https://gamma-api.polymarket.com";
const KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2";
const UPSTREAM_TIMEOUT_MS = 8000;
const UPSTREAM_RETRIES = 1;

// Fetch with per-attempt timeout; one retry on network errors or 5xx.
// 4xx is a real signal from upstream and surfaces without retry.
async function fetchWithRetry(url: string): Promise<Response> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= UPSTREAM_RETRIES; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
    try {
      const r = await fetch(url, {
        signal: ctrl.signal,
        headers: { accept: "application/json" },
      });
      clearTimeout(timer);
      if (r.status < 500) return r;
      lastErr = new Error(`upstream HTTP ${r.status}`);
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
    }
  }
  throw lastErr ?? new Error("upstream failed");
}

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
  const num = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(num)) return null;
  return Math.round(num * 100) / 100;
}

function pct(p: number): string {
  return `${(p * 100).toFixed(1)}%`;
}

function reshapePolymarket(market: Record<string, unknown>): OddsResponse | null {
  const names = parseStringArray(market.outcomes);
  const prices = parseStringArray(market.outcomePrices);
  if (!names || !prices || names.length !== prices.length) return null;
  const outcomes = names.map((name, i) => {
    const price = Number(prices[i]);
    const safe = Number.isFinite(price) ? price : 0;
    return { name, price: safe, probability: pct(safe) };
  });
  return {
    id: String(market.slug ?? ""),
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

function reshapeKalshi(m: Record<string, unknown>): OddsResponse | null {
  const ticker = typeof m.ticker === "string" ? m.ticker : null;
  if (!ticker) return null;
  const yesBid = Number(m.yes_bid_dollars);
  const yesAsk = Number(m.yes_ask_dollars);
  if (!Number.isFinite(yesBid) || !Number.isFinite(yesAsk)) return null;
  // Midpoint of bid/ask is the cleanest implied probability. Falls back to
  // last price if the book is one-sided (bid or ask at 0).
  let yesPrice = (yesBid + yesAsk) / 2;
  if (yesBid === 0 || yesAsk === 0) {
    const last = Number(m.last_price_dollars);
    if (Number.isFinite(last) && last > 0) yesPrice = last;
  }
  // Kalshi's yes_sub_title / no_sub_title are often identical for "who wins"
  // markets ("Los Angeles C" for both). Fall back to Yes/No when they collide
  // or either is missing — the question text already identifies what's being bet.
  const rawYes = typeof m.yes_sub_title === "string" ? m.yes_sub_title : "";
  const rawNo = typeof m.no_sub_title === "string" ? m.no_sub_title : "";
  const useFallback = !rawYes || !rawNo || rawYes === rawNo;
  const yesLabel = useFallback ? "Yes" : rawYes;
  const noLabel = useFallback ? "No" : rawNo;
  const title = typeof m.title === "string" && m.title.length > 0 ? m.title : ticker;
  const status = typeof m.status === "string" ? m.status : "";
  const noPrice = 1 - yesPrice;
  return {
    id: ticker,
    question: title,
    outcomes: [
      { name: yesLabel, price: yesPrice, probability: pct(yesPrice) },
      { name: noLabel, price: noPrice, probability: pct(noPrice) },
    ],
    volume24hr: roundCents(m.volume_24h_fp),
    liquidity: roundCents(m.open_interest_fp),
    endDate: typeof m.close_time === "string" ? m.close_time : null,
    active: status === "active" || status === "initialized",
    closed:
      status === "settled" || status === "closed" || status === "finalized",
    source: "kalshi",
    timestamp: new Date().toISOString(),
  };
}

async function fetchPolymarketOdds(slug: string): Promise<UpstreamResult> {
  const url = `${POLYMARKET_BASE}/markets/slug/${encodeURIComponent(slug)}`;
  let r: Response;
  try {
    r = await fetchWithRetry(url);
  } catch (err) {
    return {
      ok: false,
      status: 504,
      message: `polymarket upstream unreachable: ${(err as Error).message}`,
    };
  }
  if (r.status === 404)
    return { ok: false, status: 404, message: `no polymarket market: ${slug}` };
  if (!r.ok)
    return {
      ok: false,
      status: 502,
      message: `polymarket upstream HTTP ${r.status}`,
    };
  const market = (await r.json()) as Record<string, unknown>;
  const shaped = reshapePolymarket(market);
  if (!shaped)
    return { ok: false, status: 502, message: "polymarket response unparseable" };
  return { ok: true, data: shaped };
}

async function fetchKalshiOdds(ticker: string): Promise<UpstreamResult> {
  const url = `${KALSHI_BASE}/markets/${encodeURIComponent(ticker)}`;
  let r: Response;
  try {
    r = await fetchWithRetry(url);
  } catch (err) {
    return {
      ok: false,
      status: 504,
      message: `kalshi upstream unreachable: ${(err as Error).message}`,
    };
  }
  if (r.status === 404)
    return { ok: false, status: 404, message: `no kalshi market: ${ticker}` };
  if (!r.ok)
    return {
      ok: false,
      status: 502,
      message: `kalshi upstream HTTP ${r.status}`,
    };
  const body = (await r.json()) as { market?: Record<string, unknown> };
  if (!body.market)
    return { ok: false, status: 502, message: "kalshi response missing market" };
  const shaped = reshapeKalshi(body.market);
  if (!shaped)
    return { ok: false, status: 502, message: "kalshi response unparseable" };
  return { ok: true, data: shaped };
}

// --- discovery metadata shared by both routes ------------------------------

// JSON Schema (draft 2020-12) for the response body. Published in the Bazaar
// discovery extension so agents can parse responses without guessing shape.
const ODDS_RESPONSE_SCHEMA: Record<string, unknown> = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  required: [
    "id",
    "question",
    "outcomes",
    "active",
    "closed",
    "source",
    "timestamp",
  ],
  properties: {
    id: {
      type: "string",
      description:
        "Native identifier: Polymarket slug or Kalshi ticker.",
    },
    question: { type: "string" },
    outcomes: {
      type: "array",
      minItems: 2,
      description:
        "Both Polymarket and Kalshi markets are binary; outcomes always has exactly 2 entries (Yes/No or similar). Declared as array for forward-compatibility.",
      items: {
        type: "object",
        required: ["name", "price", "probability"],
        properties: {
          name: { type: "string" },
          price: {
            type: "number",
            minimum: 0,
            maximum: 1,
            description: "Implied probability as a 0-1 decimal.",
          },
          probability: {
            type: "string",
            description: "Price formatted as a percentage, e.g. '51.5%'.",
          },
        },
      },
    },
    volume24hr: {
      type: ["number", "null"],
      description: "24h trading volume in USD. Null if not reported.",
    },
    liquidity: {
      type: ["number", "null"],
      description:
        "Liquidity (Polymarket) or open interest (Kalshi) in USD. Null if not reported.",
    },
    endDate: {
      type: ["string", "null"],
      description: "ISO 8601 end-of-market timestamp.",
    },
    active: { type: "boolean" },
    closed: { type: "boolean" },
    source: { type: "string", enum: ["polymarket", "kalshi"] },
    timestamp: {
      type: "string",
      description: "ISO 8601 response timestamp.",
    },
  },
};

const polymarketDiscovery = declareDiscoveryExtension({
  pathParamsSchema: {
    type: "object",
    properties: {
      slug: {
        type: "string",
        description:
          "Polymarket market slug (trailing path segment on polymarket.com/event/<slug>).",
      },
    },
    required: ["slug"],
  },
  output: {
    example: {
      id: "epl-sun-che-2026-11-08-che",
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
    schema: ODDS_RESPONSE_SCHEMA,
  },
});

const kalshiDiscovery = declareDiscoveryExtension({
  pathParamsSchema: {
    type: "object",
    properties: {
      ticker: {
        type: "string",
        description:
          "Kalshi market ticker (e.g. KXNFLGAME-26NOV16LACBAL-LAC). Typically SERIES-DATE-OUTCOME.",
      },
    },
    required: ["ticker"],
  },
  output: {
    example: {
      id: "KXNFLGAME-26NOV16LACBAL-LAC",
      question: "Los Angeles C wins",
      outcomes: [
        { name: "Yes", price: 0.46, probability: "46.0%" },
        { name: "No", price: 0.54, probability: "54.0%" },
      ],
      volume24hr: 1792.62,
      liquidity: 8660.38,
      endDate: "2026-11-19T01:15:00Z",
      active: true,
      closed: false,
      source: "kalshi",
      timestamp: "2026-11-08T18:00:00.000Z",
    },
    schema: ODDS_RESPONSE_SCHEMA,
  },
});

export function buildApp(env: Env) {
  const app = new Hono<{ Bindings: Env; Variables: Vars }>();

  // Analytics logger: wraps every request so we can tell paid vs unpaid,
  // which source, which identifier, status, and latency. Never lets a
  // write failure break the response.
  app.use(async (c, next) => {
    const t0 = Date.now();
    await next();
    const latency = Date.now() - t0;
    try {
      c.env.ANALYTICS?.writeDataPoint({
        blobs: [
          c.req.path,
          c.req.query("slug") ?? c.req.query("ticker") ?? "",
          c.req.header("X-PAYMENT") ? "paid" : "unpaid",
          String(c.res.status),
        ],
        doubles: [latency],
        indexes: [c.req.path.split("/")[2] ?? "other"],
      });
    } catch {
      // never throw on analytics
    }
  });

  // CAIP-2 network id — runtime is a plain string from env; cast to the branded
  // template-literal type the SDK expects.
  const network = env.NETWORK as `${string}:${string}`;

  const facilitator = new HTTPFacilitatorClient({ url: env.FACILITATOR_URL });
  const resourceServer = new x402ResourceServer(facilitator).register(
    network,
    new ExactEvmScheme(),
  );

  const basePayment = {
    scheme: "exact" as const,
    price: "$0.005",
    network,
    payTo: env.PAYOUT_ADDRESS,
  };

  // Pre-paywall validators: fetch upstream BEFORE the paymentMiddleware runs.
  // If the resource doesn't exist, bail with a well-formed 404 without ever
  // settling payment. If it does, stash the shaped response in context and
  // let payment proceed — the handler just reads from context (no 2nd fetch).
  //
  // This fixes the "agent paid, got nothing, never comes back" failure mode.
  app.use("/api/polymarket/odds", async (c, next) => {
    const slug = c.req.query("slug");
    if (!slug) return c.json({ error: "missing query param: slug" }, 400);
    const result = await fetchPolymarketOdds(slug);
    if (!result.ok) {
      return c.json(
        { error: result.message },
        result.status as 400 | 404 | 500 | 502 | 504,
      );
    }
    c.set("odds", result.data);
    await next();
  });

  app.use("/api/kalshi/odds", async (c, next) => {
    const ticker = c.req.query("ticker");
    if (!ticker) return c.json({ error: "missing query param: ticker" }, 400);
    const result = await fetchKalshiOdds(ticker);
    if (!result.ok) {
      return c.json(
        { error: result.message },
        result.status as 400 | 404 | 500 | 502 | 504,
      );
    }
    c.set("odds", result.data);
    await next();
  });

  app.use(
    paymentMiddleware(
      {
        "GET /api/polymarket/odds": {
          accepts: [basePayment],
          description:
            "Current implied odds for a single Polymarket market by slug.",
          mimeType: "application/json",
          extensions: { ...polymarketDiscovery },
        },
        "GET /api/kalshi/odds": {
          accepts: [basePayment],
          description:
            "Current implied odds for a single Kalshi market by ticker.",
          mimeType: "application/json",
          extensions: { ...kalshiDiscovery },
        },
      },
      resourceServer,
    ),
  );

  app.get("/api/polymarket/odds", (c) => c.json(c.get("odds")));
  app.get("/api/kalshi/odds", (c) => c.json(c.get("odds")));

  app.get("/", (c) =>
    c.json({
      service: "polymarket-odds-x402",
      endpoints: [
        "GET /api/polymarket/odds?slug=<market-slug>",
        "GET /api/kalshi/odds?ticker=<market-ticker>",
      ],
      pricing: "$0.005 per request",
      network: env.NETWORK,
      sources: ["polymarket", "kalshi"],
    }),
  );

  // Unprotected diagnostic: can the CF POP actually reach each upstream?
  // Reports latency/status without any payment flow in the way.
  app.get("/debug/upstream", async (c) => {
    const probe = async (name: string, url: string) => {
      const t0 = Date.now();
      try {
        const r = await fetchWithRetry(url);
        const text = await r.text();
        return {
          name,
          url,
          ms: Date.now() - t0,
          status: r.status,
          size: text.length,
          excerpt: text.slice(0, 160),
        };
      } catch (err) {
        return {
          name,
          url,
          ms: Date.now() - t0,
          error: (err as Error).message,
        };
      }
    };
    const [poly, kalshi] = await Promise.all([
      probe(
        "polymarket",
        `${POLYMARKET_BASE}/markets/slug/epl-sun-che-2026-11-08-che`,
      ),
      probe(
        "kalshi",
        `${KALSHI_BASE}/markets/KXNFLGAME-26NOV16LACBAL-LAC`,
      ),
    ]);
    return c.json({ poly, kalshi });
  });

  return app;
}
