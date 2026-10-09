/**
 * Midnight privacy layer configuration. Read from the environment by the
 * server only; the package takes plain options so tests control it.
 *
 * Modes:
 *   mock    - deterministic local anchoring, no network. The default for
 *             development, CI and the smoke test. Commitments and proofs are
 *             structurally real (sha256, single-use nullifiers) but nothing
 *             leaves the host.
 *   local   - talks to a proof-server REST adapter (see docs/MIDNIGHT.md)
 *             backed by midnight-local-dev. Needs MIDNIGHT_PROOF_URL.
 *   testnet - same adapter against Midnight testnet. Needs MIDNIGHT_PROOF_URL
 *             plus the deployed vault address in MIDNIGHT_CONTRACT_ADDRESS.
 */
export type MidnightMode = "mock" | "local" | "testnet";

/** State file under the data dir holding commitments, nullifiers and allowances. */
export const MIDNIGHT_STATE_FILE = "midnight.json";

export interface MidnightEnv {
  mode: MidnightMode;
  /** Base URL of the proof-server adapter, e.g. http://127.0.0.1:6300. Required for local/testnet. */
  proofUrl?: string;
  /** Deployed memory-vault contract address (testnet). */
  contractAddress?: string;
  /** Deployed allowance-registry contract address (testnet, stretch). */
  allowanceAddress?: string;
  /** Block explorer base URL for tx links, e.g. https://explorer.midnight.network. */
  explorerUrl?: string;
}

/**
 * Midnight is on when MIDNIGHT_MODE is set or a contract address is present.
 * Anything else (including a misspelled mode) falls back to mock rather than
 * failing boot: the demo must never die because of a typo.
 */
export function midnightEnv(env: NodeJS.ProcessEnv): MidnightEnv | undefined {
  const rawMode = env.MIDNIGHT_MODE?.trim().toLowerCase();
  const contractAddress = env.MIDNIGHT_CONTRACT_ADDRESS?.trim() || undefined;
  const allowanceAddress = env.MIDNIGHT_ALLOWANCE_ADDRESS?.trim() || undefined;
  const proofUrl = env.MIDNIGHT_PROOF_URL?.trim().replace(/\/+$/, "") || undefined;
  const explorerUrl = env.MIDNIGHT_EXPLORER_URL?.trim().replace(/\/+$/, "") || undefined;
  if (!rawMode && !contractAddress) return undefined;
  let mode: MidnightMode = "mock";
  if (rawMode === "local" || rawMode === "testnet") mode = rawMode;
  else if (contractAddress) mode = "testnet";
  return {
    mode,
    ...(proofUrl ? { proofUrl } : {}),
    ...(contractAddress ? { contractAddress } : {}),
    ...(allowanceAddress ? { allowanceAddress } : {}),
    ...(explorerUrl ? { explorerUrl } : {}),
  };
}

/** Explorer link for a tx hash. Undefined for mock hashes, which never left the host. */
export function explorerTxUrl(env: MidnightEnv, txHash: string): string | undefined {
  if (!env.explorerUrl || txHash.startsWith("mock_")) return undefined;
  return `${env.explorerUrl}/tx/${txHash}`;
}
