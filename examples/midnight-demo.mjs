#!/usr/bin/env node
/**
 * Deterministic Midnight private-memory demo. No API key, no wallet, no
 * network: it drives the exact code path the agent uses (MidnightClient +
 * ShieldedMemory) in mock mode so judges can see the privacy model work.
 *
 *   node examples/midnight-demo.mjs
 *
 * For the live agent flow, run `instinct dev` with MIDNIGHT_MODE set and text
 * the agent "remember privately that I take medication X daily".
 */
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, StateDir } from "../packages/core/dist/index.js";
import { MidnightClient, ShieldedMemory, MIDNIGHT_STATE_FILE, newPersistedState } from "../packages/midnight/dist/index.js";

const dir = mkdtempSync(join(tmpdir(), "midnight-demo-"));
const state = new StateDir(dir);
state.ensure();
const inner = new MemoryStore(state);

let persisted = newPersistedState("demo-vault-key");
const client = new MidnightClient({
  env: { mode: "mock" },
  state: persisted,
  vaultKey: "demo-vault-key",
  save: (s) => {
    persisted = s;
    state.writeJson(MIDNIGHT_STATE_FILE, s);
  },
});
const shielded = new ShieldedMemory({ inner, client });

const line = () => console.log("─".repeat(64));

try {
  console.log("Midnight private agent — demo (mock anchoring)\n");

  line();
  console.log("1. Owner texts: \"remember privately that I take medication X daily\"");
  line();
  const saved = await shielded.remember("I take medication X daily", "health");
  console.log(`   plaintext on host : ${JSON.stringify("I take medication X daily")}`);
  console.log(`   commitment on-chain: ${saved.commitment}`);
  console.log(`   tx                 : ${saved.txHash}`);
  console.log(`   category (disclosed): ${saved.category}`);

  line();
  console.log("2. Owner texts: \"what do you remember?\"");
  line();
  console.log("   memory digest (owner only):");
  console.log(inner.readDurable().trim().split("\n").map((l) => "     " + l).join("\n"));

  line();
  console.log("3. Owner texts: \"prove I have a health note, hide the name\"");
  line();
  const proof = await client.prove({ commitment: saved.commitment, disclose: "health" });
  console.log(`   verifier learns    : ${proof.disclosedLabel} (code ${proof.disclosed})`);
  console.log(`   attestation (1-use): ${proof.attestationId}`);
  console.log(`   tx                 : ${proof.txHash}`);
  console.log(`   text leaked?         ${JSON.stringify(proof).includes("medication") ? "YES (bad)" : "no"}`);

  line();
  console.log("4. What the ledger holds (midnight.json commitments)");
  line();
  const onDisk = JSON.parse(readFileSync(state.path(MIDNIGHT_STATE_FILE), "utf8"));
  for (const [c, row] of Object.entries(onDisk.commitments)) {
    console.log(`   ${c.slice(0, 32)}…  category=${row.category}  tx=${row.txHash}`);
  }
  console.log("   (no memory text appears here — only hashes and a category code)");

  line();
  console.log("Demo complete. The words never left the host; the chain saw a hash.\n");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
