const base = "https://api.elections.kalshi.com/trade-api/v2";

const r = await fetch(`${base}/markets?limit=50&status=open`);
const j = (await r.json()) as { markets: Array<Record<string, unknown>> };

console.log(`total: ${j.markets.length}`);
console.log("\n=== ticker prefixes seen ===");
const prefixes: Record<string, number> = {};
for (const m of j.markets) {
  const t = String(m.ticker ?? "");
  const p = t.split("-")[0] ?? "?";
  prefixes[p] = (prefixes[p] ?? 0) + 1;
}
console.log(prefixes);

console.log("\n=== first non-KXMVE market, whole payload ===");
const nonSynth = j.markets.find(
  (m) => !String(m.ticker ?? "").startsWith("KXMVE"),
);
if (nonSynth) {
  console.log(JSON.stringify(nonSynth, null, 2));
} else {
  console.log("none in this page — trying series endpoint for a cleaner market");
  const r2 = await fetch(
    `${base}/markets?limit=5&status=open&series_ticker=KXNFLGAME`,
  );
  const j2 = (await r2.json()) as { markets?: Array<Record<string, unknown>> };
  if (j2.markets?.[0]) {
    console.log(JSON.stringify(j2.markets[0], null, 2));
    const ticker = String(j2.markets[0].ticker);
    const g = await fetch(`${base}/markets/${encodeURIComponent(ticker)}`);
    console.log(`\nGET /markets/${ticker} -> ${g.status}`);
    if (g.ok) console.log(JSON.stringify(await g.json(), null, 2).slice(0, 2500));
  } else {
    console.log("series query also empty");
    console.log(JSON.stringify(j2, null, 2).slice(0, 500));
  }
}
