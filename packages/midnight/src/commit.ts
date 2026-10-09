/**
 * Commitment scheme for the memory vault. Plaintext never leaves the host;
 * the ledger only sees `commitment = sha256(code | salt | text)` plus an
 * ownership blinder. The CLI mirrors this file for offline anchoring, so keep
 * the scheme stable and document any change in docs/MIDNIGHT.md.
 */
import { createHash } from "node:crypto";

export const CATEGORIES = ["health", "finance", "contact", "preference", "other"] as const;
export type CategoryLabel = (typeof CATEGORIES)[number];

/** Small integers the Compact circuit records as the disclosed field. */
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

/** 32-byte (64 hex char) commitment stored on-ledger. */
export function commitmentOf(text: string, salt: string, code: number): string {
  return sha256hex(`${code}|${salt}|${text}`);
}

/** Ownership blinder: proves the attester owns the commitment without naming them. */
export function blinderOf(vaultKey: string, commitment: string): string {
  return sha256hex(`blinder|${vaultKey}|${commitment}`);
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
