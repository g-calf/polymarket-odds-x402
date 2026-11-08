import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { appendFileSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const envPath = resolve(process.cwd(), ".dev.vars");

if (existsSync(envPath)) {
  const existing = readFileSync(envPath, "utf8");
  if (/^CLIENT_PRIVATE_KEY=/m.test(existing) && !process.argv.includes("--force")) {
    console.error(
      `.dev.vars already has a CLIENT_PRIVATE_KEY. Pass --force to overwrite the whole file.`,
    );
    process.exit(1);
  }
}

const pk = generatePrivateKey();
const account = privateKeyToAccount(pk);

const block = `
# Disposable test wallet for Base Sepolia. Never put real funds here.
CLIENT_PRIVATE_KEY=${pk}
CLIENT_ADDRESS=${account.address}
`;

if (process.argv.includes("--force") || !existsSync(envPath)) {
  writeFileSync(envPath, block.trimStart(), { mode: 0o600 });
} else {
  appendFileSync(envPath, block, { mode: 0o600 });
}

console.log("Generated disposable test wallet:");
console.log(`  address:     ${account.address}`);
console.log(`  private key: saved to ${envPath}`);
console.log("");
console.log("Fund this address with Base Sepolia USDC only (no ETH needed —");
console.log("x402 uses EIP-3009 gasless signatures; the facilitator pays gas):");
console.log("  USDC (Base Sepolia): https://faucet.circle.com  (pick Base Sepolia)");
console.log("");
console.log("Minimum needed: ~$0.10 USDC for ~20 paid calls at $0.005 each.");
