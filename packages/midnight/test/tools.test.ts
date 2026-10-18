/**
 * Vault tools through the eyes of the caller. A private agent keeps the vault owner-only;
 * a public agent opens `vault_commit` and `vault_prove_reveal` to an unknown sender
 * inside that sender's own scope, and never opens the owner's notebook, status or
 * allowance to anyone else.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryStore, StateDir, type Principal, type ToolContext } from "@open-instinct/core";
import { MidnightClient, ShieldedMemory, midnightTools, newPersistedState, type PersistedState } from "../src/index.js";

const OWNER: Principal = { kind: "owner", id: "owner", tier: "owner", displayName: "Maria" };
const SENDER: Principal = { kind: "stranger", id: "stranger:imessage:+15559998777", tier: "stranger", displayName: "+15559998777" };
const CONTACT: Principal = { kind: "contact", id: "contact:sam", tier: "partner", displayName: "Sam", contactId: "sam" };

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ text?: string }> }).content ?? [];
  return content.map((b) => b.text ?? "").join("\n");
}

function failed(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true;
}

function harness(opts: { publicMode?: boolean; verifyUrl?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "midnight-tools-"));
  const state = new StateDir(dir);
  state.ensure();
  const inner = new MemoryStore(state);
  let persisted: PersistedState = newPersistedState("vault-key");
  const client = new MidnightClient({
    env: { mode: "mock" },
    state: persisted,
    vaultKey: "vault-key",
    save: (s) => {
      persisted = s;
    },
  });
  const shielded = new ShieldedMemory({ inner, client, principalId: "owner" });
  const tools = midnightTools({ client, shielded, publicMode: opts.publicMode === true, ...(opts.verifyUrl ? { verifyUrl: opts.verifyUrl } : {}) });
  const tool = (name: string) => tools.find((t) => t.spec.name === name)!.spec;
  const ctx = (principal: Principal): ToolContext => ({ principal, conversationKey: "imessage:person", channel: "imessage", now: () => new Date("2026-10-18T12:00:00Z") });
  return { inner, tool, ctx, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const commitmentIn = (text: string): string => /Commitment ([0-9a-f]{64})/.exec(text)?.[1] ?? "";

describe("vault tools for a sender on a public agent", () => {
  it("anchors the sender's memory without touching the owner's notebook, and proves it", async () => {
    const h = harness({ publicMode: true });
    try {
      const committed = await h.tool("vault_commit").execute({ text: "likes the window seat", category: "preference" }, h.ctx(SENDER));
      const text = textOf(committed);
      expect(failed(committed)).toBe(false);
      expect(text).toContain("Anchored for this conversation as a preference memory");
      expect(text).toContain("Quote the commitment");
      expect(h.inner.readDurable()).not.toContain("likes the window seat");
      const commitment = commitmentIn(text);
      expect(commitment).toMatch(/^[0-9a-f]{64}$/);

      const proof = await h.tool("vault_prove_reveal").execute({ commitment, disclose: "preference" }, h.ctx(SENDER));
      expect(failed(proof)).toBe(false);
      expect(textOf(proof)).toContain("The verifier learns only this: preference");
      // The whole id goes back, so a judge can verify it without asking again.
      expect(/Attestation id ([0-9a-f]{64}) is single-use/.test(textOf(proof))).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  it("refuses a sender proving a commitment from another scope", async () => {
    const h = harness({ publicMode: true });
    try {
      const owner = await h.tool("vault_commit").execute({ text: "the owner's health note", category: "health" }, h.ctx(OWNER));
      expect(h.inner.readDurable()).toContain("the owner's health note");
      const commitment = commitmentIn(textOf(owner));
      const denied = await h.tool("vault_prove_reveal").execute({ commitment }, h.ctx(SENDER));
      expect(failed(denied)).toBe(true);
      expect(textOf(denied)).toContain("another vault scope");
      expect(textOf(denied)).not.toContain("attestation");
    } finally {
      h.cleanup();
    }
  });

  it("points at the agent's own public verifier when it has one, whole id included", async () => {
    const h = harness({ publicMode: true, verifyUrl: "https://sealai.inkboxwire.com/" });
    try {
      const committed = await h.tool("vault_commit").execute({ text: "travels with a small dog", category: "other" }, h.ctx(SENDER));
      const proof = await h.tool("vault_prove_reveal").execute({ commitment: commitmentIn(textOf(committed)) }, h.ctx(SENDER));
      const text = textOf(proof);
      const id = /Attestation id ([0-9a-f]{64}) is single-use/.exec(text)?.[1] ?? "";
      expect(failed(proof)).toBe(false);
      expect(text).toContain(`Anyone can check it themselves at https://sealai.inkboxwire.com/verify/${id}`);
    } finally {
      h.cleanup();
    }
  });

  it("keeps the vault shut for an unknown sender on a private agent", async () => {
    const h = harness();
    try {
      const res = await h.tool("vault_commit").execute({ text: "not for you" }, h.ctx(SENDER));
      expect(failed(res)).toBe(true);
      expect(textOf(res)).toContain("Only the owner");
    } finally {
      h.cleanup();
    }
  });

  it("keeps the vault shut for a contact, even on a public agent", async () => {
    const h = harness({ publicMode: true });
    try {
      for (const name of ["vault_commit", "vault_prove_reveal"] as const) {
        const args = name === "vault_commit" ? { text: "x" } : { commitment: "a".repeat(64) };
        const res = await h.tool(name).execute(args, h.ctx(CONTACT));
        expect(failed(res), name).toBe(true);
        expect(textOf(res)).toContain("Only the owner");
      }
      const status = await h.tool("vault_status").execute({}, h.ctx(CONTACT));
      expect(failed(status)).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  it("keeps the vault status and the allowance owner-only", async () => {
    const h = harness({ publicMode: true });
    try {
      const status = await h.tool("vault_status").execute({}, h.ctx(SENDER));
      expect(failed(status)).toBe(true);
      expect(textOf(status)).toContain("Only the owner");
      const allowance = await h.tool("allowance_check").execute({ spender: "sam", capability: "purchase", amountUsd: 10 }, h.ctx(SENDER));
      expect(failed(allowance)).toBe(true);
      expect(textOf(allowance)).toContain("Only the owner");
    } finally {
      h.cleanup();
    }
  });

  it("still lets the owner use the notebook and the vault the way it always did", async () => {
    const h = harness({ publicMode: true });
    try {
      const committed = await h.tool("vault_commit").execute({ text: "prefers aisle seats", category: "preference" }, h.ctx(OWNER));
      expect(textOf(committed)).toContain("Saved privately as a preference memory");
      expect(h.inner.readDurable()).toContain("prefers aisle seats");
      const proof = await h.tool("vault_prove_reveal").execute({ commitment: commitmentIn(textOf(committed)) }, h.ctx(OWNER));
      expect(failed(proof)).toBe(false);
    } finally {
      h.cleanup();
    }
  });
});
