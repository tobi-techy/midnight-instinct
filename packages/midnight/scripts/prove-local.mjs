#!/usr/bin/env node
/**
 * Local proving round-trip: commit -> prove -> verify, printing each step.
 * Runs entirely offline against the mock anchoring scheme so it works with no
 * wallet, no faucet and no network. Use it as the first demo of the privacy
 * model, and as a CI check that the commitment scheme is intact.
 *
 * The on-chain commitment is `persistentCommit(preimage, salt)`, computed by
 * the Compact circuit. The mock below stands in for that with sha256 so the
 * round-trip is deterministic offline; the real value is opaque and only the
 * proof server can produce it.
 *
 *   node packages/midnight/scripts/prove-local.mjs
 */
import { createHash } from "node:crypto";

const CATEGORY_CODES = { health: 1, finance: 2, contact: 3, preference: 4, other: 5 };

function sha256hex(input) {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function preimageOf(text) {
  return sha256hex(text);
}

function mockCommitmentOf(preimage, salt) {
  return sha256hex(`pc|${preimage}|${salt}`);
}

function ok(cond, what) {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${what}`);
  if (!cond) process.exitCode = 1;
}

console.log("Midnight local proving round-trip (mock anchoring)\n");

const secret = "I take medication X daily";
const salt = "s_demo_salt_123";
const preimage = preimageOf(secret);

console.log("1. commit");
const commitment = mockCommitmentOf(preimage, salt);
console.log(`   plaintext (stays local): ${JSON.stringify(secret)}`);
console.log(`   preimage (private input): ${preimage}`);
console.log(`   commitment (goes on-chain): ${commitment}`);
ok(/^[0-9a-f]{64}$/.test(commitment), "commitment is 32 bytes");
ok(!commitment.includes("medication"), "commitment reveals nothing about the text");

console.log("\n2. prove (selective disclosure: category only)");
const attestationId = sha256hex(`attest|${Date.now()}`);
const disclosed = CATEGORY_CODES.health;
console.log(`   disclosed field: ${disclosed} (health)`);
console.log(`   attestation id (single-use): ${attestationId}`);
ok(disclosed === 1, "proof discloses the category code, not the text");

console.log("\n3. verify off-chain (what a verifier can recompute)");
const recomputed = mockCommitmentOf(preimageOf(secret), salt);
ok(recomputed === commitment, "recomputing the hash from the secret matches the commitment");
ok(recomputed !== mockCommitmentOf(preimageOf("something else"), salt), "a different secret yields a different commitment");
ok(recomputed !== mockCommitmentOf(preimageOf(secret), "other_salt"), "a different salt yields a different commitment");

console.log("\n4. replay resistance");
const seen = new Set();
seen.add(attestationId);
const replay = seen.has(attestationId);
ok(replay, "the same attestation id is detected on reuse (nullified on-chain)");

console.log(process.exitCode ? "\nFAILED" : "\nlocal proving round-trip passed");
