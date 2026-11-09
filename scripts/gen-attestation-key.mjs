// Generate a fresh Ed25519 signing key for the attestation layer.
// Prints both halves. Private goes to a Worker secret; public gets
// hardcoded in app.ts + served at /.well-known/attestation-public-key.
import { generateKeyPairSync } from "node:crypto";
import { Buffer } from "node:buffer";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");

const pubRaw = publicKey.export({ format: "jwk" }).x; // base64url 32 bytes
const privPkcs8 = privateKey.export({ format: "der", type: "pkcs8" });
const privPkcs8B64 = Buffer.from(privPkcs8).toString("base64");

// Extract the raw 32-byte seed (last 32 bytes of the 48-byte PKCS8).
const privSeed = Buffer.from(privPkcs8).subarray(-32).toString("base64");

console.log("=== Ed25519 attestation keypair ===");
console.log("public_key_base64url (32-byte):", pubRaw);
console.log("public_key_base64 (32-byte):   ", Buffer.from(pubRaw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("base64"));
console.log("");
console.log("private_key_pkcs8_base64 (48-byte, use this for CF secret):");
console.log(privPkcs8B64);
console.log("");
console.log("private_key_raw_seed_base64 (32-byte alt):");
console.log(privSeed);
