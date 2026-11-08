import { privateKeyToAccount } from "viem/accounts";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";

const pk = process.env.CLIENT_PRIVATE_KEY as `0x${string}` | undefined;
if (!pk) {
  console.error("CLIENT_PRIVATE_KEY missing in .dev.vars");
  process.exit(1);
}

const baseUrl = process.env.BASE_URL ?? "http://localhost:8787";
const count = Number(process.argv[2] ?? 10);
const slug = process.argv[3] ?? "epl-sun-che-2026-11-08-che";

const account = privateKeyToAccount(pk);
const client = new x402Client();
registerExactEvmScheme(client, { signer: account });
const paidFetch = wrapFetchWithPayment(fetch, client);

console.log(`client: ${account.address}`);
console.log(`target: ${baseUrl}/api/polymarket/odds?slug=${slug}`);
console.log(`count:  ${count}`);
console.log("");

const url = `${baseUrl}/api/polymarket/odds?slug=${encodeURIComponent(slug)}`;
const results: Array<{ i: number; ms: number; status: number; note: string }> = [];
const started = Date.now();

for (let i = 1; i <= count; i++) {
  const t0 = Date.now();
  try {
    const res = await paidFetch(url);
    const elapsed = Date.now() - t0;
    const body = (await res.json()) as {
      outcomes?: Array<{ name: string; probability: string }>;
      timestamp?: string;
    };
    const summary = body.outcomes
      ? body.outcomes.map((o) => `${o.name}=${o.probability}`).join(" / ")
      : "no outcomes";
    results.push({ i, ms: elapsed, status: res.status, note: summary });
    console.log(`#${i.toString().padStart(2)} ${res.status}  ${elapsed}ms  ${summary}`);
  } catch (err) {
    const elapsed = Date.now() - t0;
    results.push({
      i,
      ms: elapsed,
      status: 0,
      note: (err as Error).message ?? String(err),
    });
    console.log(`#${i.toString().padStart(2)} FAIL ${elapsed}ms  ${(err as Error).message}`);
  }
}

const totalMs = Date.now() - started;
const ok = results.filter((r) => r.status >= 200 && r.status < 300).length;
const avg = Math.round(results.reduce((s, r) => s + r.ms, 0) / results.length);

console.log("");
console.log("=== summary ===");
console.log(`ok:    ${ok}/${count}`);
console.log(`total: ${totalMs}ms`);
console.log(`avg:   ${avg}ms/call`);
console.log(`spend: $${(ok * 0.005).toFixed(3)} USDC (if each call paid)`);
