/**
 * Commitment helpers for the memory vault.
 *
 * The ledger commitment is produced inside the Compact circuit by
 * `persistentCommit(preimage, salt)`, so the real value cannot be reproduced
 * off-chain. Plaintext never leaves the host: we hand the circuit only
 * `preimage = sha256(text)` plus a random salt, and the circuit mixes in the
 * salt so even a guessable memory is not brute-forceable from the ledger.
 *
 * Mock mode emulates `persistentCommit` with `mockCommitmentOf` so demos and
 * CI are deterministic without a proof server. Mock hashes are only ever used
 * off-chain and are labelled as mock.
 */
import { createHash } from "node:crypto";

export const CATEGORIES = ["health", "finance", "contact", "preference", "other"] as const;
export type CategoryLabel = (typeof CATEGORIES)[number];

/** Small integers the Compact circuit records as the disclosed category. */
export const CATEGORY_CODES: Record<CategoryLabel, number> = {
  health: 1,
  finance: 2,
  contact: 3,
  preference: 4,
  other: 5,
};

export function parseCategory(raw: string | undefined): CategoryLabel {
  const v = (raw ?? "").trim().toLowerCase();
  return (CATEGORIES as readonly string[]).includes(v) ? (v as CategoryLabel) : "other";
}

export function categoryName(code: number): string {
  for (const [label, c] of Object.entries(CATEGORY_CODES)) {
    if (c === code) return label;
  }
  return code === 0 ? "existence" : "unknown";
}

export function sha256hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** The private circuit input: sha256(text) as 32 raw bytes. The circuit hides it. */
export function preimageOf(text: string): string {
  return sha256hex(text);
}

/**
 * Mock stand-in for Compact's `persistentCommit(preimage, salt)`. Deterministic
 * and offline; only used in mock mode. The real commitment is computed by the
 * proof server inside the circuit and returned to the client.
 */
export function mockCommitmentOf(preimage: string, salt: string): string {
  return sha256hex(`pc|${preimage}|${salt}`);
}

/** Fresh single-use attestation id (the circuit nullifies it on use). */
export function newAttestationId(): string {
  return sha256hex(`attest|${Date.now()}|${Math.random().toString(36).slice(2)}`);
}

/** Ledger key for one (owner, spender, capability) allowance. */
export function allowanceKey(owner: string, spender: string, capability: string): string {
  return sha256hex(`allowance|${owner.trim().toLowerCase()}|${spender.trim().toLowerCase()}|${capability.trim().toLowerCase()}`);
}

/** Dollars to integer cents for the Uint<64> circuit inputs. */
export function usdToCents(usd: number): number {
  if (!Number.isFinite(usd) || usd < 0) throw new Error(`amount must be a non-negative number, got ${usd}`);
  return Math.round(usd * 100);
}

export function centsToUsd(cents: number): number {
  return Math.round(cents) / 100;
}
