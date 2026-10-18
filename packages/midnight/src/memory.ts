/**
 * Shielded memory: wraps MemoryStore without forking it. Plaintext flows to
 * the existing markdown files (the owner's readable notebook); each durable
 * write additionally anchors a commitment through the Midnight client. The
 * audit log gets the commitment and tx hash, never the text.
 *
 * Recall policy: the owner gets full digests (unchanged MemoryStore
 * behaviour). Non-owners keep the tier-based preferences digest from
 * runtime.ts; they can additionally receive a Midnight existence/category
 * proof via vault_prove_reveal, which proves a memory exists without
 * revealing it.
 */
import type { AuditLog, MemoryStore } from "@open-instinct/core";
import { categoryName, parseCategory } from "./commit.js";
import { OWNER_SCOPE, type MidnightClient } from "./client.js";

export interface ShieldedMemoryOptions {
  inner: MemoryStore;
  client: MidnightClient;
  /** Audit writer; midnight anchors land as kind "policy" with the tx hash. */
  audit?: Pick<AuditLog, "append">;
  conversationKey?: string;
  principalId?: string;
}

export interface AnchoredWrite {
  saved: boolean;
  /** False when the text was anchored for someone else and did not enter the owner's notebook. */
  notebook?: boolean;
  commitment?: string;
  txHash?: string;
  explorerUrl?: string;
  category?: string;
  error?: string;
}

export interface RememberOptions {
  /**
   * Whose vault this belongs to. Omitted (or the owner scope) is the owner's own
   * notebook. Any other scope anchors the commitment only: the plaintext stays in
   * the conversation it was given in and never enters the owner's notebook.
   */
  scope?: string;
}

export class ShieldedMemory {
  private readonly inner: MemoryStore;
  private readonly client: MidnightClient;
  private readonly audit?: Pick<AuditLog, "append">;
  private readonly conversationKey: string;
  private readonly principalId: string;

  constructor(opts: ShieldedMemoryOptions) {
    this.inner = opts.inner;
    this.client = opts.client;
    this.audit = opts.audit;
    this.conversationKey = opts.conversationKey ?? "system";
    this.principalId = opts.principalId ?? "owner";
  }

  /** Owner plaintext writes, exactly as before. */
  readDurable(): string {
    return this.inner.readDurable();
  }

  readJournal(date?: Date): string {
    return this.inner.readJournal(date);
  }

  digest(maxChars = 4000, now: Date = new Date()): string {
    return this.inner.digest(maxChars, now);
  }

  preferencesDigest(maxChars = 1500): string {
    return this.inner.preferencesDigest(maxChars);
  }

  journalPath(date?: Date): string {
    return this.inner.journalPath(date);
  }

  /** Append to durable memory AND anchor a commitment. Journal lines stay local-only. */
  async remember(text: string, category?: string, opts: RememberOptions = {}): Promise<AnchoredWrite> {
    const clean = text.trim();
    if (!clean) return { saved: false, error: "nothing to remember" };
    // A guest's note is not the owner's note: anchor it, keep the plaintext out of
    // the owner's notebook, and leave it in the conversation that produced it.
    const notebook = !opts.scope || opts.scope === OWNER_SCOPE;
    if (notebook) this.inner.appendDurable(clean);
    try {
      const committed = await this.client.commit({ text: clean, category, ...(opts.scope ? { scope: opts.scope } : {}) });
      this.audit?.append({
        kind: "policy",
        conversationKey: this.conversationKey,
        principal: this.principalId,
        detail: { tool: "vault_commit", commitment: committed.commitment, txHash: committed.txHash, mode: committed.mode, category: committed.category, ...(notebook ? {} : { scope: "guest" }) },
      });
      return { saved: true, notebook, commitment: committed.commitment, txHash: committed.txHash, category: committed.category, ...(committed.explorerUrl ? { explorerUrl: committed.explorerUrl } : {}) };
    } catch (err) {
      // The local note is saved; the anchor failed. The agent must say so.
      return {
        saved: notebook,
        notebook,
        error: `${notebook ? "saved locally but" : "not saved:"} the Midnight anchor failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  appendJournal(text: string, date?: Date): void {
    this.inner.appendJournal(text, date);
  }

  /** Human line for what a stored commitment means, without revealing the text. */
  describeCommitment(commitment: string): string {
    const row = (this.client as unknown as { state?: { commitments?: Record<string, { category: string; txHash: string }> } }).state?.commitments?.[commitment];
    if (!row) return `unknown commitment ${commitment.slice(0, 12)}…`;
    return `${row.category} memory anchored ${commitment.slice(0, 12)}… (tx ${row.txHash})`;
  }
}

export { categoryName, parseCategory };
