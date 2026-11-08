import { privateKeyToAccount } from "viem/accounts";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";

const pk = process.env.CLIENT_PRIVATE_KEY as `0x${string}` | undefined;
if (!pk) {
  console.error(
    "CLIENT_PRIVATE_KEY missing. Run `npm run genwallet` first, then fund the printed address.",
  );
  process.exit(1);
}

const slug = process.argv[2] ?? "epl-sun-che-2026-11-08-che";
const baseUrl = process.env.BASE_URL ?? "http://localhost:8787";

const account = privateKeyToAccount(pk);
const client = new x402Client();
registerExactEvmScheme(client, { signer: account });

const paidFetch = wrapFetchWithPayment(fetch, client);

console.log(`Client address: ${account.address}`);
console.log(`Calling:        GET ${baseUrl}/api/polymarket/odds?slug=${slug}`);
console.log("");

const started = Date.now();
const res = await paidFetch(
  `${baseUrl}/api/polymarket/odds?slug=${encodeURIComponent(slug)}`,
);
const elapsed = Date.now() - started;

console.log(`Status: ${res.status}   (${elapsed}ms)`);
console.log("Headers of interest:");
for (const h of ["x-payment-response", "content-type"]) {
  const v = res.headers.get(h);
  if (v) console.log(`  ${h}: ${v.slice(0, 120)}${v.length > 120 ? "..." : ""}`);
}
console.log("");
console.log("Body:");
console.log(JSON.stringify(await res.json(), null, 2));
