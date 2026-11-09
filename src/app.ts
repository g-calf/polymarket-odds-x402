import { Hono, type Context } from "hono";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";

export type Env = {
  PAYOUT_ADDRESS: string;
  NETWORK: string;
  FACILITATOR_URL: string;
  // CDP x402 facilitator credentials (required only when FACILITATOR_URL
  // points at api.cdp.coinbase.com). Stored as encrypted Worker secrets.
  CDP_API_KEY_NAME?: string;
  CDP_API_KEY_SECRET?: string;
  // Analytics Engine binding (optional: absent locally under Node).
  ANALYTICS?: {
    writeDataPoint(event: {
      blobs?: string[];
      doubles?: number[];
      indexes?: string[];
    }): void;
  };
  // D1 durable log (odds history + payer attention). Optional for local Node.
  DB?: {
    prepare(query: string): {
      bind(...args: unknown[]): {
        run(): Promise<unknown>;
      };
    };
  };
};

export type BatchOddsResponse = {
  odds: OddsResponse[];
  errors: Array<{ id: string; error: string }>;
  timestamp: string;
};

// Per-request Hono context vars.
type Vars = {
  odds: OddsResponse;
  batch: BatchOddsResponse;
};

// --- CDP x402 facilitator JWT auth -----------------------------------------

// CDP's x402 facilitator requires a per-request Bearer JWT. Format:
//   header: { alg: "EdDSA", kid: <key_name>, typ: "JWT", nonce: 16-byte hex }
//   claims: { sub: <key_name>, iss: "cdp", nbf: now, exp: now+120,
//             uris: ["POST api.cdp.coinbase.com/platform/v2/x402/<path>"] }
// Signed with Ed25519 using the raw 32-byte key seed.
// CDP key secret is 64 bytes base64 = seed(32) || pub(32); we use the seed.

const PKCS8_ED25519_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70,
  0x04, 0x22, 0x04, 0x20,
]);

function b64urlEncode(bytes: Uint8Array | string): string {
  const s = typeof bytes === "string" ? bytes : String.fromCharCode(...bytes);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

let cachedCdpKey: Promise<CryptoKey> | undefined;
function importCdpKey(secretB64: string): Promise<CryptoKey> {
  if (cachedCdpKey) return cachedCdpKey;
  const raw = b64decode(secretB64);
  // CDP ships 64 bytes (seed || pub). We only need the first 32 (seed).
  const seed = raw.slice(0, 32);
  const pkcs8 = new Uint8Array(PKCS8_ED25519_PREFIX.length + seed.length);
  pkcs8.set(PKCS8_ED25519_PREFIX, 0);
  pkcs8.set(seed, PKCS8_ED25519_PREFIX.length);
  // Ed25519 isn't in the standard WebCrypto types shipped with CF Workers
  // types yet, but the runtime supports it. Cast to bypass the type check.
  const subtle = crypto.subtle as unknown as {
    importKey(
      f: string,
      k: Uint8Array,
      a: { name: string },
      e: boolean,
      u: string[],
    ): Promise<CryptoKey>;
  };
  cachedCdpKey = subtle.importKey(
    "pkcs8",
    pkcs8,
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  return cachedCdpKey;
}

async function signCdpJwt(
  keyName: string,
  key: CryptoKey,
  path: "verify" | "settle" | "supported",
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const nonceBytes = crypto.getRandomValues(new Uint8Array(16));
  const nonce = Array.from(nonceBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const header = {
    alg: "EdDSA",
    kid: keyName,
    typ: "JWT",
    nonce,
  };
  // /supported is GET; /verify and /settle are POST. The uris claim must
  // match the facilitator's actual method, else CDP rejects as 401.
  const method = path === "supported" ? "GET" : "POST";
  const claims = {
    sub: keyName,
    iss: "cdp",
    nbf: now,
    exp: now + 120,
    uris: [`${method} api.cdp.coinbase.com/platform/v2/x402/${path}`],
  };
  const h = b64urlEncode(JSON.stringify(header));
  const p = b64urlEncode(JSON.stringify(claims));
  const signingInput = `${h}.${p}`;
  const subtle = crypto.subtle as unknown as {
    sign(a: string, k: CryptoKey, d: ArrayBuffer): Promise<ArrayBuffer>;
  };
  const sigBuf = await subtle.sign(
    "Ed25519",
    key,
    new TextEncoder().encode(signingInput).buffer as ArrayBuffer,
  );
  const sig = b64urlEncode(new Uint8Array(sigBuf));
  return `${h}.${p}.${sig}`;
}

function buildCreateAuthHeaders(env: Env) {
  return async () => {
    if (!env.CDP_API_KEY_NAME || !env.CDP_API_KEY_SECRET) {
      // No CDP creds configured; return empty — payai etc. don't need auth.
      return {};
    }
    const key = await importCdpKey(env.CDP_API_KEY_SECRET);
    const name = env.CDP_API_KEY_NAME;
    const [v, s, sup] = await Promise.all([
      signCdpJwt(name, key, "verify"),
      signCdpJwt(name, key, "settle"),
      signCdpJwt(name, key, "supported"),
    ]);
    return {
      verify: { Authorization: `Bearer ${v}` },
      settle: { Authorization: `Bearer ${s}` },
      supported: { Authorization: `Bearer ${sup}` },
    };
  };
}

// --- D1 snapshot logging + payer extraction -------------------------------

// Decode the x402 payment header (base64 JSON of signed payload) and
// extract the paying wallet. Tries both modern (PAYMENT-SIGNATURE) and
// legacy (X-PAYMENT) header names.
function extractPayer(headerValue: string | undefined | null): string | null {
  if (!headerValue) return null;
  try {
    const json = JSON.parse(
      // atob handles standard base64; replace url-safe chars first.
      atob(headerValue.replace(/-/g, "+").replace(/_/g, "/")),
    );
    // x402 v2 EIP-3009 payload: payload.authorization.from
    const from =
      json?.payload?.authorization?.from ??
      json?.authorization?.from ??
      json?.from ??
      null;
    return typeof from === "string" ? from : null;
  } catch {
    return null;
  }
}

async function logSnapshot(
  db: Env["DB"],
  row: {
    ts: number;
    endpoint: string;
    source: string | null;
    market_id: string | null;
    outcomes_json: string | null;
    volume_24h: number | null;
    liquidity: number | null;
    active: boolean | null;
    closed: boolean | null;
    status: number;
    latency_ms: number;
    paid: boolean;
    payer_wallet: string | null;
    facilitator: string;
  },
): Promise<void> {
  if (!db) return;
  try {
    await db
      .prepare(
        `INSERT INTO odds_snapshots
         (ts, endpoint, source, market_id, outcomes_json, volume_24h,
          liquidity, active, closed, status, latency_ms, paid, payer_wallet,
          facilitator)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.ts,
        row.endpoint,
        row.source,
        row.market_id,
        row.outcomes_json,
        row.volume_24h,
        row.liquidity,
        row.active === null ? null : row.active ? 1 : 0,
        row.closed === null ? null : row.closed ? 1 : 0,
        row.status,
        row.latency_ms,
        row.paid ? 1 : 0,
        row.payer_wallet,
        row.facilitator,
      )
      .run();
  } catch {
    // never let logging break a response
  }
}

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

const batchDiscovery = declareDiscoveryExtension({
  pathParamsSchema: {
    type: "object",
    properties: {
      slugs: {
        type: "string",
        description:
          "Comma-separated Polymarket slugs (max 20). Returns odds for each; per-slug errors are listed separately. Charged per request, not per slug.",
      },
    },
    required: ["slugs"],
  },
  output: {
    example: {
      odds: [
        {
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
      ],
      errors: [{ id: "nonexistent-slug", error: "no polymarket market: nonexistent-slug" }],
      timestamp: "2026-11-08T12:00:00.000Z",
    },
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      required: ["odds", "errors", "timestamp"],
      properties: {
        odds: { type: "array", items: ODDS_RESPONSE_SCHEMA },
        errors: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "error"],
            properties: {
              id: { type: "string" },
              error: { type: "string" },
            },
          },
        },
        timestamp: { type: "string" },
      },
    },
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

  // Logger: wraps every request. Writes to Analytics Engine (fast, 90-day
  // retention, operational metrics) AND to D1 (durable, seeds history/payer
  // moats). Both are best-effort and never block the response.
  app.use(async (c, next) => {
    const t0 = Date.now();
    await next();
    const latency = Date.now() - t0;
    const path = c.req.path;
    const paymentHeader =
      c.req.header("PAYMENT-SIGNATURE") ??
      c.req.header("payment-signature") ??
      c.req.header("X-PAYMENT") ??
      c.req.header("x-payment");
    const paid = Boolean(paymentHeader);
    const payer = extractPayer(paymentHeader);
    const marketId =
      c.req.query("slug") ?? c.req.query("ticker") ?? "";
    const status = c.res.status;

    // Analytics Engine (sync, non-blocking)
    try {
      c.env.ANALYTICS?.writeDataPoint({
        blobs: [path, marketId, paid ? "paid" : "unpaid", String(status)],
        doubles: [latency],
        indexes: [path.split("/")[2] ?? "other"],
      });
    } catch {}

    // D1 snapshot — pull odds from context if the handler stored them.
    // ctx.waitUntil lets the response return before the DB write resolves.
    const odds = c.get("odds") as OddsResponse | undefined;
    const batch = c.get("batch") as BatchOddsResponse | undefined;
    // For a batch request, log one row per market so each timeseries entry
    // is queryable per-slug.
    const rows: Array<Parameters<typeof logSnapshot>[1]> = [];
    const facilitator = c.env.FACILITATOR_URL;
    const commonTs = Math.floor(Date.now() / 1000);
    if (batch && batch.odds?.length) {
      for (const o of batch.odds) {
        rows.push({
          ts: commonTs,
          endpoint: path,
          source: o.source,
          market_id: o.id,
          outcomes_json: JSON.stringify(o.outcomes),
          volume_24h: o.volume24hr,
          liquidity: o.liquidity,
          active: o.active,
          closed: o.closed,
          status,
          latency_ms: latency,
          paid,
          payer_wallet: payer,
          facilitator,
        });
      }
    } else if (odds) {
      rows.push({
        ts: commonTs,
        endpoint: path,
        source: odds.source,
        market_id: odds.id,
        outcomes_json: JSON.stringify(odds.outcomes),
        volume_24h: odds.volume24hr,
        liquidity: odds.liquidity,
        active: odds.active,
        closed: odds.closed,
        status,
        latency_ms: latency,
        paid,
        payer_wallet: payer,
        facilitator,
      });
    } else if (path.startsWith("/api/")) {
      // Request hit an /api/ path but no odds were resolved (400/404/error).
      // Still log the meta-row so we see demand even for failed calls.
      rows.push({
        ts: commonTs,
        endpoint: path,
        source: null,
        market_id: marketId || null,
        outcomes_json: null,
        volume_24h: null,
        liquidity: null,
        active: null,
        closed: null,
        status,
        latency_ms: latency,
        paid,
        payer_wallet: payer,
        facilitator,
      });
    }
    if (rows.length && c.env.DB) {
      const db = c.env.DB;
      c.executionCtx.waitUntil(
        Promise.all(rows.map((r) => logSnapshot(db, r))).then(() => {}),
      );
    }
  });

  // CAIP-2 network id — runtime is a plain string from env; cast to the branded
  // template-literal type the SDK expects.
  const network = env.NETWORK as `${string}:${string}`;

  const facilitator = new HTTPFacilitatorClient({
    url: env.FACILITATOR_URL,
    createAuthHeaders: buildCreateAuthHeaders(env),
  });
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
  const cheapPayment = { ...basePayment, price: "$0.001" };
  const batchPayment = { ...basePayment, price: "$0.02" };

  const MAX_BATCH = 20;

  // Pre-paywall validators: fetch upstream BEFORE the paymentMiddleware runs.
  // If the resource doesn't exist, bail with a well-formed 404 without ever
  // settling payment. If it does, stash the shaped response in context and
  // let payment proceed — the handler just reads from context (no 2nd fetch).
  //
  // This fixes the "agent paid, got nothing, never comes back" failure mode.
  app.use("/api/polymarket/odds", async (c, next) => {
    const slug = c.req.query("slug");
    if (!slug)
      return c.json(
        {
          error: "missing query param: slug",
          example: "?slug=will-donald-trump-win-the-presidential-election",
          docs: "https://polymarket-odds-x402.goldencalf.workers.dev/llms.txt",
        },
        400,
      );
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

  // Cheap single-slug Polymarket at $0.001 — parallel path for price elasticity.
  app.use("/api/polymarket/odds-cheap", async (c, next) => {
    const slug = c.req.query("slug");
    if (!slug)
      return c.json(
        {
          error: "missing query param: slug",
          example: "?slug=will-donald-trump-win-the-presidential-election",
          docs: "https://polymarket-odds-x402.goldencalf.workers.dev/llms.txt",
        },
        400,
      );
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

  // Batch endpoint pre-validator. Fetch all slugs in parallel. If NONE resolve,
  // refuse to charge (404). If at least one resolves, let payment proceed and
  // return the mixed result with per-slug errors documented.
  app.use("/api/polymarket/odds/batch", async (c, next) => {
    const slugsRaw = c.req.query("slugs");
    if (!slugsRaw) return c.json({ error: "missing query param: slugs" }, 400);
    const slugs = slugsRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (slugs.length === 0)
      return c.json({ error: "empty slugs list" }, 400);
    if (slugs.length > MAX_BATCH)
      return c.json(
        {
          error: `too many slugs (max ${MAX_BATCH}, got ${slugs.length})`,
        },
        400,
      );
    const settled = await Promise.all(
      slugs.map(async (slug) => ({ slug, result: await fetchPolymarketOdds(slug) })),
    );
    const odds: OddsResponse[] = [];
    const errors: Array<{ id: string; error: string }> = [];
    for (const { slug, result } of settled) {
      if (result.ok) odds.push(result.data);
      else errors.push({ id: slug, error: result.message });
    }
    if (odds.length === 0) {
      return c.json(
        {
          error: "no resolvable markets in batch",
          errors,
        },
        404,
      );
    }
    c.set("batch", {
      odds,
      errors,
      timestamp: new Date().toISOString(),
    });
    await next();
  });

  app.use("/api/kalshi/odds", async (c, next) => {
    const ticker = c.req.query("ticker");
    if (!ticker)
      return c.json(
        {
          error: "missing query param: ticker",
          example: "?ticker=KXNFLGAME-26NOV16LACBAL-LAC",
          docs: "https://polymarket-odds-x402.goldencalf.workers.dev/llms.txt",
        },
        400,
      );
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
          serviceName: "goldencalf",
          tags: ["prediction-markets", "polymarket", "odds", "sports", "events"],
          extensions: { ...polymarketDiscovery },
        },
        "GET /api/polymarket/odds-cheap": {
          accepts: [cheapPayment],
          description:
            "Same as /api/polymarket/odds but priced at $0.001. Price elasticity test.",
          mimeType: "application/json",
          serviceName: "goldencalf",
          tags: ["prediction-markets", "polymarket", "odds", "cheap"],
          extensions: { ...polymarketDiscovery },
        },
        "GET /api/polymarket/odds/batch": {
          accepts: [batchPayment],
          description:
            "Batch Polymarket odds lookup: up to 20 slugs per paid call at $0.02 (vs. 20x$0.005 singles).",
          mimeType: "application/json",
          serviceName: "goldencalf",
          tags: ["prediction-markets", "polymarket", "odds", "batch"],
          extensions: { ...batchDiscovery },
        },
        "GET /api/kalshi/odds": {
          accepts: [basePayment],
          description:
            "Current implied odds for a single Kalshi market by ticker.",
          mimeType: "application/json",
          serviceName: "goldencalf",
          tags: ["prediction-markets", "kalshi", "odds", "sports", "events"],
          extensions: { ...kalshiDiscovery },
        },
      },
      resourceServer,
    ),
  );

  app.get("/api/polymarket/odds", (c) => c.json(c.get("odds")));
  app.get("/api/polymarket/odds-cheap", (c) => c.json(c.get("odds")));
  app.get("/api/polymarket/odds/batch", (c) => c.json(c.get("batch")));
  app.get("/api/kalshi/odds", (c) => c.json(c.get("odds")));

  app.get("/", (c) =>
    c.json({
      service: "polymarket-odds-x402",
      endpoints: [
        { path: "GET /api/polymarket/odds?slug=<slug>", price: "$0.005" },
        {
          path: "GET /api/polymarket/odds-cheap?slug=<slug>",
          price: "$0.001",
          note: "price elasticity test",
        },
        {
          path: "GET /api/polymarket/odds/batch?slugs=<a,b,c>",
          price: "$0.02",
          note: `up to ${MAX_BATCH} slugs per call`,
        },
        { path: "GET /api/kalshi/odds?ticker=<ticker>", price: "$0.005" },
      ],
      network: env.NETWORK,
      sources: ["polymarket", "kalshi"],
    }),
  );

  // --- Well-known discovery endpoints ------------------------------------
  // Served unprotected with long cache. Agent crawlers hit these first to
  // understand what the service does and how to call it. Analytics showed
  // ~100+ daily 404s on these paths; converting them to 200s turns passive
  // probes into actionable engagement.

  const ONE_DAY_CACHE = "public, max-age=86400, s-maxage=86400";

  function serviceManifest(baseUrl: string) {
    return {
      name: "goldencalf",
      description:
        "Live Polymarket and Kalshi prediction market odds, paid per call via x402 on Base mainnet. No API keys, no accounts, no subscriptions.",
      base_url: baseUrl,
      payment: {
        protocol: "x402",
        protocol_version: 2,
        network: env.NETWORK,
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        asset_symbol: "USDC",
        asset_decimals: 6,
        pay_to: env.PAYOUT_ADDRESS,
        facilitator: env.FACILITATOR_URL,
      },
      endpoints: [
        {
          method: "GET",
          path: "/api/polymarket/odds",
          query: { slug: "string (Polymarket market slug)" },
          price_usdc: 0.005,
          returns: "single OddsResponse",
        },
        {
          method: "GET",
          path: "/api/polymarket/odds-cheap",
          query: { slug: "string" },
          price_usdc: 0.001,
          returns: "single OddsResponse",
          note: "cheaper variant for cost-sensitive agents",
        },
        {
          method: "GET",
          path: "/api/polymarket/odds/batch",
          query: {
            slugs: `comma-separated slugs (max ${MAX_BATCH})`,
          },
          price_usdc: 0.02,
          returns: "BatchOddsResponse { odds, errors, timestamp }",
          note: "one payment covers up to 20 markets",
        },
        {
          method: "GET",
          path: "/api/kalshi/odds",
          query: { ticker: "string (Kalshi market ticker)" },
          price_usdc: 0.005,
          returns: "single OddsResponse",
        },
      ],
      mcp_server: {
        npm: "@gcalf/mcp",
        install: "npm install -g @gcalf/mcp",
        tools: [
          "get_polymarket_odds",
          "get_kalshi_odds",
          "get_polymarket_odds_batch",
        ],
      },
      discovery: {
        bazaar_payai: `${env.FACILITATOR_URL}/discovery/resources`,
      },
      source_repo: "https://github.com/g-calf/polymarket-odds-x402",
    };
  }

  function baseUrlOf(reqUrl: string): string {
    try {
      const u = new URL(reqUrl);
      return `${u.protocol}//${u.host}`;
    } catch {
      return "https://polymarket-odds-x402.goldencalf.workers.dev";
    }
  }

  // x402's commonly-probed .well-known path. We respond with the service
  // manifest (useful superset) rather than a protocol-defined schema.
  app.get("/.well-known/x402", (c) => {
    c.header("Cache-Control", ONE_DAY_CACHE);
    return c.json(serviceManifest(baseUrlOf(c.req.url)));
  });

  // Agent-card style manifests (several conventions, same payload works).
  const agentCardHandler = (c: Context) => {
    c.header("Cache-Control", ONE_DAY_CACHE);
    const base = baseUrlOf(c.req.url);
    return c.json({
      schema_version: "v1",
      name_for_model: "goldencalf_odds",
      name_for_human: "Goldencalf Prediction Market Odds",
      description_for_model:
        "Fetch live implied odds for individual Polymarket and Kalshi prediction markets. Each call costs USDC (micropayment) via x402 on Base mainnet. Use for sports betting markets, elections, crypto prices, and any event with a public prediction market. Returns outcomes with implied probabilities, volume, liquidity, and resolution date.",
      description_for_human:
        "x402-paid API for Polymarket and Kalshi prediction market odds.",
      auth: {
        type: "x402",
        protocol_version: 2,
        network: env.NETWORK,
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        pay_to: env.PAYOUT_ADDRESS,
      },
      api: { type: "openapi", url: `${base}/openapi.json` },
      logo_url: `${base}/favicon.ico`,
      contact_email: "",
      legal_info_url: `${base}/`,
    });
  };
  app.get("/.well-known/agent.json", agentCardHandler);
  app.get("/.well-known/agent-card.json", agentCardHandler);
  app.get("/agents.json", agentCardHandler);

  // llms.txt — plaintext index optimized for LLM crawlers (llmstxt.org).
  app.get("/llms.txt", (c) => {
    const base = baseUrlOf(c.req.url);
    c.header("Cache-Control", ONE_DAY_CACHE);
    c.header("Content-Type", "text/plain; charset=utf-8");
    return c.body(
      `# goldencalf

> Live implied odds for Polymarket and Kalshi prediction markets. Each call is paid per request in USDC on Base mainnet via the x402 protocol. No API keys, no accounts, no subscriptions.

## Paid endpoints

- [GET /api/polymarket/odds?slug=SLUG](${base}/api/polymarket/odds): single Polymarket market, $0.005 USDC
- [GET /api/polymarket/odds-cheap?slug=SLUG](${base}/api/polymarket/odds-cheap): same, $0.001 USDC (price A/B)
- [GET /api/polymarket/odds/batch?slugs=A,B,C](${base}/api/polymarket/odds/batch): up to ${MAX_BATCH} Polymarket slugs, $0.02 USDC
- [GET /api/kalshi/odds?ticker=TICKER](${base}/api/kalshi/odds): single Kalshi market, $0.005 USDC

## How to call

1. GET the endpoint without a payment header. The response is HTTP 402 with a \`payment-required\` header containing base64-encoded JSON payment requirements (asset, amount, pay_to, network).
2. Sign an EIP-3009 TransferWithAuthorization for the stated amount of USDC to the stated pay_to on Base mainnet (network ${env.NETWORK}, asset 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913).
3. Resend the request with the signed payment in an \`X-PAYMENT\` header. Response is HTTP 200 with the market odds JSON.

The x402 client libraries (\`@x402/fetch\` for JS/TS, community Python clients) handle this loop automatically.

## MCP (Claude Desktop, other MCP runtimes)

\`\`\`
npm install -g @gcalf/mcp
\`\`\`

Three tools register: \`get_polymarket_odds\`, \`get_kalshi_odds\`, \`get_polymarket_odds_batch\`.

## Metadata

- [Service manifest](${base}/.well-known/x402)
- [OpenAPI spec](${base}/openapi.json)
- [Agent card](${base}/.well-known/agent.json)
- [Source repo](https://github.com/g-calf/polymarket-odds-x402)
`,
    );
  });

  // OpenAPI 3.1 spec. Documents all paid endpoints; x402 payment is noted in
  // security + description but OpenAPI has no native x402 scheme, so we
  // describe it as a bearer auth with scheme "x402" for machine consumption.
  app.get("/openapi.json", (c) => {
    const base = baseUrlOf(c.req.url);
    c.header("Cache-Control", ONE_DAY_CACHE);
    return c.json({
      openapi: "3.1.0",
      info: {
        title: "goldencalf — prediction market odds (x402)",
        version: "0.2.0",
        description:
          "Live Polymarket and Kalshi odds, paid per call via x402 on Base mainnet. See /.well-known/x402 for the full payment manifest and /llms.txt for a plaintext summary.",
        contact: { name: "source", url: "https://github.com/g-calf/polymarket-odds-x402" },
        license: { name: "MIT" },
      },
      servers: [{ url: base }],
      components: {
        securitySchemes: {
          x402: {
            type: "http",
            scheme: "x402",
            description:
              "x402 micropayment in USDC on Base mainnet. See /.well-known/x402 for amount, asset, and pay_to per endpoint.",
          },
        },
        schemas: {
          Outcome: {
            type: "object",
            required: ["name", "price", "probability"],
            properties: {
              name: { type: "string" },
              price: { type: "number", minimum: 0, maximum: 1 },
              probability: { type: "string" },
            },
          },
          OddsResponse: ODDS_RESPONSE_SCHEMA,
          BatchOddsResponse: {
            type: "object",
            required: ["odds", "errors", "timestamp"],
            properties: {
              odds: { type: "array", items: ODDS_RESPONSE_SCHEMA },
              errors: {
                type: "array",
                items: {
                  type: "object",
                  required: ["id", "error"],
                  properties: {
                    id: { type: "string" },
                    error: { type: "string" },
                  },
                },
              },
              timestamp: { type: "string" },
            },
          },
        },
      },
      security: [{ x402: [] }],
      paths: {
        "/api/polymarket/odds": {
          get: {
            summary: "Single Polymarket market odds ($0.005)",
            parameters: [
              {
                name: "slug",
                in: "query",
                required: true,
                schema: { type: "string" },
              },
            ],
            responses: {
              "200": {
                description: "Odds",
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/OddsResponse" },
                  },
                },
              },
              "402": { description: "Payment required (see payment-required header)" },
              "404": { description: "Market not found (no payment taken)" },
            },
          },
        },
        "/api/polymarket/odds-cheap": {
          get: {
            summary: "Single Polymarket market odds, cheap variant ($0.001)",
            parameters: [
              {
                name: "slug",
                in: "query",
                required: true,
                schema: { type: "string" },
              },
            ],
            responses: {
              "200": {
                description: "Odds",
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/OddsResponse" },
                  },
                },
              },
              "402": { description: "Payment required" },
              "404": { description: "Market not found" },
            },
          },
        },
        "/api/polymarket/odds/batch": {
          get: {
            summary: `Up to ${MAX_BATCH} Polymarket markets ($0.02)`,
            parameters: [
              {
                name: "slugs",
                in: "query",
                required: true,
                schema: { type: "string" },
                description: `Comma-separated slugs, max ${MAX_BATCH}`,
              },
            ],
            responses: {
              "200": {
                description: "Batch odds + per-slug errors",
                content: {
                  "application/json": {
                    schema: {
                      $ref: "#/components/schemas/BatchOddsResponse",
                    },
                  },
                },
              },
              "402": { description: "Payment required" },
              "404": { description: "No resolvable markets in batch (no payment taken)" },
            },
          },
        },
        "/api/kalshi/odds": {
          get: {
            summary: "Single Kalshi market odds ($0.005)",
            parameters: [
              {
                name: "ticker",
                in: "query",
                required: true,
                schema: { type: "string" },
              },
            ],
            responses: {
              "200": {
                description: "Odds",
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/OddsResponse" },
                  },
                },
              },
              "402": { description: "Payment required" },
              "404": { description: "Market not found" },
            },
          },
        },
      },
    });
  });

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
