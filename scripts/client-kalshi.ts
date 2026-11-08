import { privateKeyToAccount } from "viem/accounts";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";

const pk = process.env.CLIENT_PRIVATE_KEY as `0x${string}` | undefined;
if (!pk) {
  console.error("CLIENT_PRIVATE_KEY missing");
  process.exit(1);
}

const ticker = process.argv[2] ?? "KXNFLGAME-26NOV16LACBAL-LAC";
const baseUrl = process.env.BASE_URL ?? "http://localhost:8787";

const account = privateKeyToAccount(pk);
const client = new x402Client();
registerExactEvmScheme(client, { signer: account });
const paidFetch = wrapFetchWithPayment(fetch, client);

console.log(`Client:  ${account.address}`);
console.log(`Call:    GET ${baseUrl}/api/kalshi/odds?ticker=${ticker}`);
console.log("");
const t0 = Date.now();
const res = await paidFetch(
  `${baseUrl}/api/kalshi/odds?ticker=${encodeURIComponent(ticker)}`,
);
console.log(`Status:  ${res.status}  (${Date.now() - t0}ms)`);
console.log("");
console.log(JSON.stringify(await res.json(), null, 2));
