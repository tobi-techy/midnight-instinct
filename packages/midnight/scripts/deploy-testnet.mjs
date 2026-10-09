#!/usr/bin/env node
/**
 * Deploy the vault (and allowances) to Midnight testnet through the
 * proof-server adapter, then persist the contract addresses to the data dir.
 *
 * Prerequisites (see docs/MIDNIGHT.md):
 *   1. compactc builds contracts/build/vault and contracts/build/allowances
 *   2. midnight-local-dev is up, or testnet is reachable
 *   3. a proof-server adapter exposes POST /deploy { contract: "<name>" }
 *      and returns { address, txHash }
 *
 *   MIDNIGHT_MODE=testnet \
 *   MIDNIGHT_PROOF_URL=https://proof.example.com \
 *   MIDNIGHT_EXPLORER_URL=https://explorer.midnight.network \
 *   INSTINCT_DATA_DIR=./.instinct \
 *   node packages/midnight/scripts/deploy-testnet.mjs
 *
 * With no proof server it prints the exact commands to run instead, so the
 * script is useful as a checklist even before the wallet exists.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, resolve, join } from "node:path";

const proofUrl = (process.env.MIDNIGHT_PROOF_URL ?? "").replace(/\/+$/, "");
const explorerUrl = (process.env.MIDNIGHT_EXPLORER_URL ?? "").replace(/\/+$/, "");
const dataDir = resolve(process.env.INSTINCT_DATA_DIR ?? ".instinct");
const outFile = join(dataDir, "midnight.json");

async function deploy(name) {
  const res = await fetch(`${proofUrl}/deploy`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ contract: name }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`deploy ${name} failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  const body = JSON.parse(text);
  if (!body.address || !body.txHash) throw new Error(`deploy ${name} returned no address/txHash`);
  return body;
}

async function main() {
  if (!proofUrl) {
    console.log("MIDNIGHT_PROOF_URL is not set, so there is nothing to deploy against.\n");
    console.log("Run these instead:");
    console.log("  compactc contracts/memory-vault.compact --output contracts/build/vault");
    console.log("  compactc contracts/allowance-registry.compact --output contracts/build/allowances");
    console.log("  # start midnight-local-dev, then point MIDNIGHT_PROOF_URL at your proof-server adapter");
    process.exit(1);
  }

  console.log(`Deploying to ${proofUrl} ...`);
  const vault = await deploy("memory-vault");
  console.log(`  memory-vault -> ${vault.address} (tx ${vault.txHash})`);
  let allowances;
  try {
    allowances = await deploy("allowance-registry");
    console.log(`  allowance-registry -> ${allowances.address} (tx ${allowances.txHash})`);
  } catch (err) {
    console.log(`  allowance-registry skipped: ${err.message}`);
  }

  const existing = existsSync(outFile) ? JSON.parse(readFileSync(outFile, "utf8")) : {};
  const merged = {
    ...existing,
    version: 1,
    mode: "testnet",
    vaultKey: existing.vaultKey ?? "",
    contractAddress: vault.address,
    ...(allowances ? { allowanceAddress: allowances.address } : {}),
    deployedAt: new Date().toISOString(),
    deploymentTx: { vault: vault.txHash, ...(allowances ? { allowances: allowances.txHash } : {}) },
  };
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify(merged, null, 2) + "\n");

  console.log(`\nWrote ${outFile}`);
  if (explorerUrl) {
    console.log(`Vault:     ${explorerUrl}/address/${vault.address}`);
    console.log(`Commit tx: ${explorerUrl}/tx/${vault.txHash}`);
  }
  console.log("\nAdd to your env:");
  console.log(`  MIDNIGHT_MODE=testnet`);
  console.log(`  MIDNIGHT_PROOF_URL=${proofUrl}`);
  console.log(`  MIDNIGHT_CONTRACT_ADDRESS=${vault.address}`);
  if (allowances) console.log(`  MIDNIGHT_ALLOWANCE_ADDRESS=${allowances.address}`);
  if (explorerUrl) console.log(`  MIDNIGHT_EXPLORER_URL=${explorerUrl}`);
}

main().catch((err) => {
  console.error(`deploy failed: ${err.message}`);
  process.exit(1);
});
