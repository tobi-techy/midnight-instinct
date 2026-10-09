#!/usr/bin/env node
/**
 * Live round-trip: drive the real Midnight adapter with the agent's own
 * MidnightClient (the same code the runtime uses), in `local` mode.
 *
 * Prerequisite: the devnet adapter is running (deploy/midnight-devnet:
 * `npm run setup` then `npm run adapter`).
 *
 *   MIDNIGHT_PROOF_URL=http://127.0.0.1:6400 \
 *   MIDNIGHT_CONTRACT_ADDRESS=<memoryVault.address> \
 *   node packages/midnight/scripts/adapter-roundtrip.mjs
 *
 * Unlike prove-local.mjs (which is offline mock), this issues REAL
 * transactions on the chain and prints their ids.
 */
import { MidnightClient, newPersistedState } from "../dist/index.js";

const proofUrl = process.env.MIDNIGHT_PROOF_URL?.replace(/\/+$/, "");
const contractAddress = process.env.MIDNIGHT_CONTRACT_ADDRESS;
if (!proofUrl || !contractAddress) {
  console.error("Set MIDNIGHT_PROOF_URL and MIDNIGHT_CONTRACT_ADDRESS (see the file header).");
  process.exit(2);
}

let state = newPersistedState("live-vault-key");
const client = new MidnightClient({
  env: { mode: "local", proofUrl, contractAddress },
  state,
  vaultKey: "live-vault-key",
  save: (s) => {
    state = s;
  },
});

const memoryText = "I take medication X daily";

console.log("Agent MidnightClient -> live adapter");
console.log(`  proofUrl: ${proofUrl}`);
console.log(`  contract: ${contractAddress}\n`);

console.log("1. commit (real circuit call)");
const committed = await client.commit({ text: memoryText, category: "health" });
console.log(`   plaintext (stays local): ${JSON.stringify(memoryText)}`);
console.log(`   commitment (on-chain):   ${committed.commitment}`);
console.log(`   tx:                      ${committed.txHash}`);

console.log("\n2. attest (selective disclosure: health)");
const proof = await client.prove({ commitment: committed.commitment, disclose: "health" });
console.log(`   verifier learns: ${proof.disclosedLabel} (code ${proof.disclosed})`);
console.log(`   attestation:     ${proof.attestationId}`);
console.log(`   tx:              ${proof.txHash}`);

console.log("\nlive round-trip complete: two real transactions on Midnight.");
