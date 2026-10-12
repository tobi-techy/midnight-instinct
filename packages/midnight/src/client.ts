/**
 * Midnight client: mock, local proof-server, and testnet modes behind one
 * interface. Local and testnet both speak to a small REST proof-server
 * adapter (see docs/MIDNIGHT.md) that owns the wallet, runs compactc
 * artifacts and submits to midnight-local-dev or testnet. The agent process
 * itself never holds seed phrases.
 *
 * Mock mode is the default: deterministic, offline, structurally real
 * (sha256 commitments, single-use nullifiers, spend totals) so demos, CI and
 * the smoke test run with no faucet and no network.
 */
import { randomBytes } from "node:crypto";
import { allowanceKey, centsToUsd, mockCommitmentOf, newAttestationId, parseCategory, preimageOf, usdToCents, type CategoryLabel } from "./commit.js";
import type { MidnightEnv } from "./config.js";

export interface CommitInput {
  text: string;
  category?: string;
  salt?: string;
}

export interface CommitResult {
  commitment: string;
  category: CategoryLabel;
  code: number;
  salt: string;
  txHash: string;
  mode: string;
  contractAddress?: string;
  explorerUrl?: string;
}

export interface ProveInput {
  commitment: string;
  /** What the verifier learns: a category label, or "existence" for proof-of-existence only. */
  disclose?: string;
}

export interface ProveResult {
  attestationId: string;
  disclosed: number;
  disclosedLabel: string;
  txHash: string;
  mode: string;
  explorerUrl?: string;
}

export interface SpendCheckInput {
  owner: string;
  spender: string;
  capability: string;
  amountUsd: number;
}

export interface SpendCheckResult {
  allowed: boolean;
  key: string;
  spentCents: number;
  spentUsd: number;
  limitCents?: number;
  limitUsd?: number;
  txHash?: string;
  reason: string;
}

export interface MidnightStatus {
  mode: string;
  proofUrl?: string;
  contractAddress?: string;
  allowanceAddress?: string;
  commitments: number;
  attestations: number;
  allowances: number;
}

interface PersistedState {
  version: 1;
  vaultKey: string;
  commitments: Record<string, { category: string; code: number; salt: string; txHash: string; at: string }>;
  nullifiers: Record<string, { commitment: string; disclosed: number; txHash: string; at: string }>;
  allowances: Record<string, { maxCents: number; spentCents: number; active: boolean }>;
}

function emptyState(vaultKey: string): PersistedState {
  return { version: 1, vaultKey, commitments: {}, nullifiers: {}, allowances: {} };
}

function isRecord(v: unknown): v is Record<string, never> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Coerce whatever is on disk into a complete PersistedState. The file is also
 * written by the deploy scripts (deployment metadata, no anchor maps) and can be
 * hand-edited, so every map is filled in rather than assumed: `status()` and each
 * count would otherwise throw on a file that is not exactly ours.
 */
export function normalizeState(raw: unknown, vaultKey: string): PersistedState {
  if (!isRecord(raw)) return emptyState(vaultKey);
  const s = raw as Partial<PersistedState>;
  return {
    version: 1,
    vaultKey: typeof s.vaultKey === "string" && s.vaultKey ? s.vaultKey : vaultKey,
    commitments: isRecord(s.commitments) ? (s.commitments as PersistedState["commitments"]) : {},
    nullifiers: isRecord(s.nullifiers) ? (s.nullifiers as PersistedState["nullifiers"]) : {},
    allowances: isRecord(s.allowances) ? (s.allowances as PersistedState["allowances"]) : {},
  };
}

export interface MidnightClientOptions {
  env: MidnightEnv;
  state: PersistedState | undefined;
  save: (state: PersistedState) => void;
  vaultKey: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

async function postJson(fetchImpl: typeof fetch, url: string, body: unknown, timeoutMs = 60_000): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let parsed: unknown = undefined;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      throw new Error(`proof-server returned non-JSON (HTTP ${res.status})`);
    }
    if (!res.ok) {
      const msg = parsed && typeof parsed === "object" && "error" in parsed ? String((parsed as { error: unknown }).error) : text.slice(0, 300);
      throw new Error(`proof-server HTTP ${res.status}: ${msg}`);
    }
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A field the proof server must return in local/testnet mode. Guessing here
 * would anchor a hash the chain never saw: a mock commitment saved as real makes
 * the later `attest` fail with "unknown commitment" on a transaction that looks
 * successful to the owner.
 */
function requiredField(parsed: unknown, field: string, what: string): string {
  const v = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>)[field] : undefined;
  if (typeof v !== "string" || !v) {
    throw new Error(`proof-server returned no ${field} for ${what}: refusing to record an anchor that never landed`);
  }
  return v;
}

export class MidnightClient {
  readonly mode: string;
  private readonly env: MidnightEnv;
  private state: PersistedState;
  private readonly save: (s: PersistedState) => void;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(opts: MidnightClientOptions) {
    this.env = opts.env;
    this.mode = opts.env.mode;
    this.state = normalizeState(opts.state, opts.vaultKey);
    this.save = opts.save;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => new Date());
  }

  status(): MidnightStatus {
    return {
      mode: this.mode,
      ...(this.env.proofUrl ? { proofUrl: this.env.proofUrl } : {}),
      ...(this.env.contractAddress ? { contractAddress: this.env.contractAddress } : {}),
      ...(this.env.allowanceAddress ? { allowanceAddress: this.env.allowanceAddress } : {}),
      commitments: Object.keys(this.state.commitments).length,
      attestations: Object.keys(this.state.nullifiers).length,
      allowances: Object.keys(this.state.allowances).length,
    };
  }

  hasCommitment(commitment: string): boolean {
    return Boolean(this.state.commitments[commitment]);
  }

  /** Anchor a memory. Plaintext stays in the caller; only the commitment is stored/shared. */
  async commit(input: CommitInput): Promise<CommitResult> {
    const text = input.text.trim();
    if (!text) throw new Error("nothing to commit: text is empty");
    if (text.length > 4000) throw new Error("memory text too long for one commitment (max 4000 chars)");
    const category = parseCategory(input.category);
    const { CATEGORY_CODES } = await import("./commit.js");
    const code = CATEGORY_CODES[category];
    const salt = input.salt ?? randomBytes(32).toString("hex");
    // The circuit takes only the digest and a random salt; persistentCommit
    // mixes in the salt so a guessable memory still cannot be brute-forced.
    const preimage = preimageOf(text);
    const mockCommitment = mockCommitmentOf(preimage, salt);
    if (this.mode === "mock" && this.state.commitments[mockCommitment]) {
      const existing = this.state.commitments[mockCommitment]!;
      return { commitment: mockCommitment, category: existing.category as CategoryLabel, code: existing.code, salt: existing.salt, txHash: existing.txHash, mode: this.mode, ...(this.env.contractAddress ? { contractAddress: this.env.contractAddress } : {}) };
    }
    let commitment: string;
    let txHash: string;
    if (this.mode === "mock") {
      commitment = mockCommitment;
      txHash = `mock_commit_${commitment.slice(0, 16)}`;
    } else {
      if (!this.env.proofUrl) throw new Error(`${this.mode} mode needs MIDNIGHT_PROOF_URL`);
      const parsed = await postJson(this.fetchImpl, `${this.env.proofUrl}/commit`, {
        contract: this.env.contractAddress,
        preimage,
        salt,
        // The circuit binds this code to the commitment; the ledger stores only a
        // hiding commitment to it, so the proof can disclose it truthfully later.
        category: code,
      });
      commitment = requiredField(parsed, "commitment", "commit");
      txHash = requiredField(parsed, "txHash", "commit");
    }
    this.state.commitments[commitment] = { category, code, salt, txHash, at: this.now().toISOString() };
    this.save(this.state);
    const { explorerTxUrl } = await import("./config.js");
    const explorerUrl = explorerTxUrl(this.env, txHash);
    return { commitment, category, code, salt, txHash, mode: this.mode, ...(this.env.contractAddress ? { contractAddress: this.env.contractAddress } : {}), ...(explorerUrl ? { explorerUrl } : {}) };
  }

  /**
   * Selective-disclosure proof. The verifier learns only `disclosed`:
   * a category code (1-5) or 0 for bare existence. The attestation id is
   * nullified so one proof cannot be replayed as two.
   */
  async prove(input: ProveInput): Promise<ProveResult> {
    const commitment = input.commitment.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(commitment)) throw new Error("commitment must be 64 hex chars");
    if (!this.state.commitments[commitment]) throw new Error("unknown commitment: commit it first with vault_commit");
    const raw = (input.disclose ?? "existence").trim().toLowerCase();
    let disclosed: number;
    let disclosedLabel: string;
    if (raw === "existence" || raw === "0" || raw === "") {
      disclosed = 0;
      disclosedLabel = "existence";
    } else {
      const category = parseCategory(raw);
      const { CATEGORY_CODES } = await import("./commit.js");
      disclosed = CATEGORY_CODES[category];
      disclosedLabel = category;
    }
    // The circuit refuses a category the memory was not committed with; fail
    // here too so mock mode cannot claim what local/testnet would reject.
    const row = this.state.commitments[commitment]!;
    if (disclosed !== 0 && disclosed !== row.code) {
      throw new Error(`cannot disclose ${disclosedLabel}: this memory was committed as ${row.category}`);
    }
    const attestationId = newAttestationId();
    if (this.state.nullifiers[attestationId]) throw new Error("attestation collision: retry");
    let txHash: string;
    if (this.mode === "mock") {
      txHash = `mock_attest_${attestationId.slice(0, 16)}`;
    } else {
      if (!this.env.proofUrl) throw new Error(`${this.mode} mode needs MIDNIGHT_PROOF_URL`);
      const parsed = await postJson(this.fetchImpl, `${this.env.proofUrl}/attest`, {
        contract: this.env.contractAddress,
        commitment,
        attestationId,
        category: disclosed,
      });
      txHash = requiredField(parsed, "txHash", "attest");
    }
    this.state.nullifiers[attestationId] = { commitment, disclosed, txHash, at: this.now().toISOString() };
    this.save(this.state);
    const { explorerTxUrl } = await import("./config.js");
    const explorerUrl = explorerTxUrl(this.env, txHash);
    return { attestationId, disclosed, disclosedLabel, txHash, mode: this.mode, ...(explorerUrl ? { explorerUrl } : {}) };
  }

  /** Authorize a (owner, spender, capability) allowance. Mock records it locally; remote submits `authorize`. */
  async authorize(owner: string, spender: string, capability: string, maxUsd: number): Promise<{ key: string; maxCents: number; txHash: string }> {
    const key = allowanceKey(owner, spender, capability);
    const maxCents = usdToCents(maxUsd);
    if (maxCents <= 0) throw new Error("maxUsd must be positive");
    let txHash: string;
    if (this.mode === "mock") {
      txHash = `mock_authorize_${key.slice(0, 16)}`;
    } else {
      if (!this.env.proofUrl) throw new Error(`${this.mode} mode needs MIDNIGHT_PROOF_URL`);
      const parsed = await postJson(this.fetchImpl, `${this.env.proofUrl}/allowance/authorize`, {
        contract: this.env.allowanceAddress ?? this.env.contractAddress,
        key,
        maxAmount: maxCents,
      });
      txHash = requiredField(parsed, "txHash", "allowance call");
    }
    const prev = this.state.allowances[key];
    this.state.allowances[key] = { maxCents, spentCents: prev?.spentCents ?? 0, active: true };
    this.save(this.state);
    return { key, maxCents, txHash };
  }

  /**
   * ZK-gated spend check (stretch). Returns allowed=false instead of throwing
   * when the allowance is missing, inactive or exhausted, so the policy guard
   * can turn it into an ask_owner flow. Amounts stay off-ledger in mock; the
   * remote circuit takes the amount as a witness.
   */
  async checkSpend(input: SpendCheckInput): Promise<SpendCheckResult> {
    const key = allowanceKey(input.owner, input.spender, input.capability);
    const amountCents = usdToCents(input.amountUsd);
    const row = this.state.allowances[key];
    if (!row || !row.active) {
      return { allowed: false, key, spentCents: row?.spentCents ?? 0, spentUsd: centsToUsd(row?.spentCents ?? 0), reason: "no active allowance for this (owner, spender, capability)" };
    }
    if (amountCents <= 0) return { allowed: false, key, spentCents: row.spentCents, spentUsd: centsToUsd(row.spentCents), limitCents: row.maxCents, limitUsd: centsToUsd(row.maxCents), reason: "amount must be positive" };
    if (row.spentCents + amountCents > row.maxCents) {
      return { allowed: false, key, spentCents: row.spentCents, spentUsd: centsToUsd(row.spentCents), limitCents: row.maxCents, limitUsd: centsToUsd(row.maxCents), reason: `would exceed allowance: spent $${centsToUsd(row.spentCents).toFixed(2)} of $${centsToUsd(row.maxCents).toFixed(2)}` };
    }
    let txHash: string | undefined;
    if (this.mode === "mock") {
      txHash = `mock_spend_${key.slice(0, 12)}_${row.spentCents + amountCents}`;
    } else {
      if (!this.env.proofUrl) throw new Error(`${this.mode} mode needs MIDNIGHT_PROOF_URL`);
      const parsed = await postJson(this.fetchImpl, `${this.env.proofUrl}/allowance/spend`, {
        contract: this.env.allowanceAddress ?? this.env.contractAddress,
        key,
        amount: amountCents,
      });
      txHash = requiredField(parsed, "txHash", "allowance call");
    }
    row.spentCents += amountCents;
    this.save(this.state);
    return { allowed: true, key, spentCents: row.spentCents, spentUsd: centsToUsd(row.spentCents), limitCents: row.maxCents, limitUsd: centsToUsd(row.maxCents), ...(txHash ? { txHash } : {}), reason: `within allowance: $${centsToUsd(row.spentCents).toFixed(2)} of $${centsToUsd(row.maxCents).toFixed(2)}` };
  }

  async revokeAllowance(owner: string, spender: string, capability: string): Promise<{ key: string; txHash: string }> {
    const key = allowanceKey(owner, spender, capability);
    const row = this.state.allowances[key];
    if (!row || !row.active) throw new Error("no active allowance to revoke");
    let txHash: string;
    if (this.mode === "mock") {
      txHash = `mock_revoke_${key.slice(0, 16)}`;
    } else {
      if (!this.env.proofUrl) throw new Error(`${this.mode} mode needs MIDNIGHT_PROOF_URL`);
      const parsed = await postJson(this.fetchImpl, `${this.env.proofUrl}/allowance/revoke`, {
        contract: this.env.allowanceAddress ?? this.env.contractAddress,
        key,
      });
      txHash = requiredField(parsed, "txHash", "allowance call");
    }
    row.active = false;
    this.save(this.state);
    return { key, txHash };
  }
}

export type { PersistedState };
export function newPersistedState(vaultKey: string): PersistedState {
  return emptyState(vaultKey);
}
