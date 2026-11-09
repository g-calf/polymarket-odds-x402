import { privateKeyToAccount } from "viem/accounts";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";

const pk = process.env.CLIENT_PRIVATE_KEY as `0x${string}` | undefined;
if (!pk) {
  console.error("CLIENT_PRIVATE_KEY missing");
  process.exit(1);
}

const slug = process.argv[2] ?? "epl-sun-che-2026-11-08-che";
const baseUrl =
  process.env.BASE_URL ?? "https://polymarket-odds-x402.goldencalf.workers.dev";

const account = privateKeyToAccount(pk);
const client = new x402Client();
registerExactEvmScheme(client, { signer: account });
const paidFetch = wrapFetchWithPayment(fetch, client);

const res = await paidFetch(
  `${baseUrl}/api/polymarket/odds/attested?slug=${encodeURIComponent(slug)}`,
);
const text = await res.text();
// Print only the body so it can be piped into the verifier cleanly.
process.stdout.write(text);
