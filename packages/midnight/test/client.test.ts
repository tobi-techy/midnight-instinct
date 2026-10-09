import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryStore, StateDir } from "@open-instinct/core";
import {
  CATEGORY_CODES,
  MidnightClient,
  ShieldedMemory,
  newPersistedState,
  type PersistedState,
} from "../src/index.js";

function makeClient() {
  let state: PersistedState = newPersistedState("vault-test-key");
  const client = new MidnightClient({
    env: { mode: "mock" },
    state,
    vaultKey: "vault-test-key",
    save: (s) => {
      state = s;
    },
  });
  return { client, state: () => state };
}

describe("commitment scheme", () => {
  it("produces the same commitment for the same input and differs for any change", async () => {
    const { client } = makeClient();
    const a = await client.commit({ text: "I take medication X", category: "health", salt: "fixed" });
    const b = await client.commit({ text: "I take medication X", category: "health", salt: "fixed" });
    expect(a.commitment).toBe(b.commitment);
    const c = await client.commit({ text: "I take medication Y", category: "health", salt: "fixed" });
    expect(c.commitment).not.toBe(a.commitment);
    const d = await client.commit({ text: "I take medication X", category: "health", salt: "other-salt" });
    expect(d.commitment).not.toBe(a.commitment);
    // The category is disclosed at proof time, not baked into the commitment.
    const e = await client.commit({ text: "I take medication X", category: "finance", salt: "fixed" });
    expect(e.commitment).toBe(a.commitment);
  });

  it("keeps the plaintext out of the commitment and reports a mock tx", async () => {
    const { client } = makeClient();
    const out = await client.commit({ text: "my passport number is 12345", category: "contact" });
    expect(out.commitment).toMatch(/^[0-9a-f]{64}$/);
    expect(out.commitment).not.toContain("passport");
    expect(out.txHash.startsWith("mock_commit_")).toBe(true);
    expect(out.category).toBe("contact");
    expect(out.code).toBe(CATEGORY_CODES.contact);
  });

  it("does not duplicate an identical commitment", async () => {
    const { client } = makeClient();
    await client.commit({ text: "same", category: "other", salt: "s" });
    await client.commit({ text: "same", category: "other", salt: "s" });
    expect(client.status().commitments).toBe(1);
  });
});

describe("selective disclosure", () => {
  it("proves a category without revealing existence of the text", async () => {
    const { client } = makeClient();
    const committed = await client.commit({ text: "allergic to peanuts", category: "health" });
    const proof = await client.prove({ commitment: committed.commitment, disclose: "health" });
    expect(proof.disclosed).toBe(CATEGORY_CODES.health);
    expect(proof.disclosedLabel).toBe("health");
    expect(JSON.stringify(proof)).not.toContain("peanuts");
  });

  it("supports bare existence proof (disclosed 0)", async () => {
    const { client } = makeClient();
    const committed = await client.commit({ text: "a secret", category: "other" });
    const proof = await client.prove({ commitment: committed.commitment });
    expect(proof.disclosed).toBe(0);
    expect(proof.disclosedLabel).toBe("existence");
  });

  it("refuses to prove an unknown commitment", async () => {
    const { client } = makeClient();
    await expect(client.prove({ commitment: "0".repeat(64) })).rejects.toThrow(/unknown commitment/);
  });

  it("issues a fresh single-use attestation each time", async () => {
    const { client } = makeClient();
    const committed = await client.commit({ text: "note", category: "other" });
    const p1 = await client.prove({ commitment: committed.commitment, disclose: "other" });
    const p2 = await client.prove({ commitment: committed.commitment, disclose: "other" });
    expect(p1.attestationId).not.toBe(p2.attestationId);
    expect(client.status().attestations).toBe(2);
  });
});

describe("allowances (stretch)", () => {
  it("denies when no allowance exists", async () => {
    const { client } = makeClient();
    const out = await client.checkSpend({ owner: "Owner", spender: "sam", capability: "purchase", amountUsd: 10 });
    expect(out.allowed).toBe(false);
    expect(out.reason).toMatch(/no active allowance/);
  });

  it("authorizes, spends within limit, and blocks the over-limit spend", async () => {
    const { client } = makeClient();
    await client.authorize("Owner", "sam", "purchase", 50);
    const ok = await client.checkSpend({ owner: "Owner", spender: "sam", capability: "purchase", amountUsd: 30 });
    expect(ok.allowed).toBe(true);
    expect(ok.spentUsd).toBe(30);
    const over = await client.checkSpend({ owner: "Owner", spender: "sam", capability: "purchase", amountUsd: 30 });
    expect(over.allowed).toBe(false);
    expect(over.reason).toMatch(/exceed allowance/);
    expect(over.limitUsd).toBe(50);
  });

  it("blocks a revoked allowance", async () => {
    const { client } = makeClient();
    await client.authorize("Owner", "sam", "purchase", 50);
    await client.revokeAllowance("Owner", "sam", "purchase");
    const out = await client.checkSpend({ owner: "Owner", spender: "sam", capability: "purchase", amountUsd: 1 });
    expect(out.allowed).toBe(false);
  });
});

describe("persistence and shielded memory", () => {
  it("restores commitments from saved state across client instances", async () => {
    let state: PersistedState = newPersistedState("k");
    const save = (s: PersistedState) => {
      state = s;
    };
    const first = new MidnightClient({ env: { mode: "mock" }, state, vaultKey: "k", save });
    const c = await first.commit({ text: "persist me", category: "preference" });
    const second = new MidnightClient({ env: { mode: "mock" }, state, vaultKey: "k", save });
    expect(second.hasCommitment(c.commitment)).toBe(true);
    const proof = await second.prove({ commitment: c.commitment, disclose: "preference" });
    expect(proof.disclosed).toBe(CATEGORY_CODES.preference);
  });

  it("ShieldedMemory writes plaintext locally AND anchors a commitment", async () => {
    const dir = mkdtempSync(join(tmpdir(), "midnight-shield-"));
    try {
      const state = new StateDir(dir);
      state.ensure();
      const inner = new MemoryStore(state);
      let persisted = newPersistedState("k");
      const client = new MidnightClient({ env: { mode: "mock" }, state: persisted, vaultKey: "k", save: (s) => (persisted = s) });
      const shielded = new ShieldedMemory({ inner, client });
      const out = await shielded.remember("prefers window seats", "preference");
      // Plaintext landed in the owner's readable notebook.
      expect(inner.readDurable()).toContain("prefers window seats");
      // A commitment was anchored and is restorable from the Midnight state.
      expect(out.saved).toBe(true);
      expect(out.commitment).toMatch(/^[0-9a-f]{64}$/);
      expect(out.txHash?.startsWith("mock_commit_")).toBe(true);
      expect(client.hasCommitment(out.commitment!)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("config gating", () => {
  it("mock mode needs no proof server", async () => {
    const { client } = makeClient();
    expect(client.mode).toBe("mock");
    await expect(client.commit({ text: "x", category: "other" })).resolves.toBeTruthy();
  });
});
