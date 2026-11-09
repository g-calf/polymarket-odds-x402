// Standalone verifier for goldencalf attestation receipts.
// Usage:
//   cat response.json | tsx scripts/verify-attestation.ts
// Or pass via argv:
//   tsx scripts/verify-attestation.ts path/to/response.json
//
// Prints VALID or FAILED <reason>. Uses only the public key published at
// /.well-known/attestation-public-key — no round trip to the goldencalf API.
import { createPublicKey, verify, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Buffer } from "node:buffer";

type Receipt = {
  issuer: string;
  key_id: string;
  issued_at: string;
  resource: string;
  params: Record<string, string>;
  data_sha256: string;
  signature_alg: "Ed25519";
  signature: string;
};
type Attested = { data: unknown; attestation: Receipt };

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    "{" +
    keys
      .map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k]))
      .join(",") +
    "}"
  );
}

// Published public key (fetch via /.well-known/attestation-public-key in prod
// to pick up rotations). Hardcoded here for the single-key case.
const PUBLIC_KEY_B64 = "YRY/thE6ky8Me/eYFjOyENn42mUqC4C7rLqLdg+Mgbs=";

const input = process.argv[2]
  ? readFileSync(process.argv[2], "utf8")
  : readFileSync(0, "utf8");

const payload = JSON.parse(input) as Attested;
const r = payload.attestation;

// 1. Recompute data hash and compare
const expectedHash = createHash("sha256")
  .update(canonicalJson(payload.data))
  .digest("hex");
if (expectedHash !== r.data_sha256) {
  console.log(`FAILED  data_sha256 mismatch`);
  console.log(`  expected ${expectedHash}`);
  console.log(`  got      ${r.data_sha256}`);
  process.exit(1);
}

// 2. Rebuild the signed message and verify the signature
const unsignedReceipt = {
  issuer: r.issuer,
  key_id: r.key_id,
  issued_at: r.issued_at,
  resource: r.resource,
  params: r.params,
  data_sha256: r.data_sha256,
};
const signingInput = Buffer.from(canonicalJson(unsignedReceipt), "utf8");
const signature = Buffer.from(r.signature, "base64");

// Wrap the 32-byte raw public key in Ed25519 SPKI to import.
const spkiPrefix = Buffer.from([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);
const publicKeyRaw = Buffer.from(PUBLIC_KEY_B64, "base64");
const spki = Buffer.concat([spkiPrefix, publicKeyRaw]);
const pubKey = createPublicKey({ key: spki, format: "der", type: "spki" });

const ok = verify(null, signingInput, pubKey, signature);
if (!ok) {
  console.log(`FAILED  signature does not verify under the published public key`);
  process.exit(1);
}

console.log("VALID");
console.log(`  issuer:       ${r.issuer}`);
console.log(`  key_id:       ${r.key_id}`);
console.log(`  issued_at:    ${r.issued_at}`);
console.log(`  resource:     ${r.resource}`);
console.log(`  params:       ${JSON.stringify(r.params)}`);
console.log(`  data_sha256:  ${r.data_sha256}`);
console.log(`  signature:    ${r.signature.slice(0, 32)}... (verified)`);
