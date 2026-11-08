// Scan a much larger sample and show outcome count distribution.
const pageSize = 500;
const pages = 4;
const counts: Record<number, number> = {};
const samples: Array<{ slug: string; question: string; n: number }> = [];

for (let i = 0; i < pages; i++) {
  const r = await fetch(
    `https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=${pageSize}&offset=${i * pageSize}`,
  );
  const markets = (await r.json()) as Array<{
    slug: string;
    question: string;
    outcomes: string;
  }>;
  if (!markets.length) break;
  for (const m of markets) {
    let n = 0;
    try {
      n = (JSON.parse(m.outcomes) as unknown[]).length;
    } catch {
      n = 0;
    }
    counts[n] = (counts[n] ?? 0) + 1;
    if (n > 2 && samples.length < 5) {
      samples.push({ slug: m.slug, question: m.question, n });
    }
  }
}

console.log("outcome count distribution (active markets):");
console.log(counts);
console.log(`\nmulti-outcome samples (n>2):`);
for (const s of samples) {
  console.log(JSON.stringify(s, null, 2));
}
