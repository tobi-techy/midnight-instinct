import { describe, expect, it, vi } from "vitest";
import {
  CATEGORY_CODES,
  MidnightClient,
  disclosureCodeOf,
  newPersistedState,
  type PersistedState,
} from "../src/index.js";

function makeClient() {
  let state: PersistedState = newPersistedState("verify-test-key");
  const client = new MidnightClient({
    env: { mode: "mock" },
    state,
    vaultKey: "verify-test-key",
    save: (s) => {
      state = s;
    },
  });
  return { client, state: () => state };
}

describe("disclosure labels", () => {
  it("maps labels to codes and rejects unknown ones", () => {
    expect(disclosureCodeOf("existence")).toBe(0);
    expect(disclosureCodeOf("health")).toBe(CATEGORY_CODES.health);
    expect(disclosureCodeOf("finance")).toBe(CATEGORY_CODES.finance);
    expect(() => disclosureCodeOf("banana")).toThrow(/unknown category/);
  });
});

describe("third-party verification", () => {
  it("verifies a proof and reveals only the disclosed category", async () => {
    const { client } = makeClient();
    const committed = await client.commit({ text: "allergic to peanuts", category: "health" });
    const proof = await client.prove({ commitment: committed.commitment, disclose: "health" });
    const out = await client.verify({ attestationId: proof.attestationId });
    expect(out.valid).toBe(true);
    expect(out.disclosed).toBe(CATEGORY_CODES.health);
    expect(out.disclosedLabel).toBe("health");
    expect(out.singleUse).toBe(true);
    expect(out.reason).toMatch(/valid health proof/);
    expect(JSON.stringify(out)).not.toContain("peanuts");
  });

  it("does not verify an unknown attestation", async () => {
    const { client } = makeClient();
    const out = await client.verify({ attestationId: "a".repeat(64) });
    expect(out.valid).toBe(false);
    expect(out.singleUse).toBe(false);
    expect(out.reason).toMatch(/no such attestation/);
  });

  it("confirms an expected category and flags a mismatch", async () => {
    const { client } = makeClient();
    const committed = await client.commit({ text: "budget note", category: "finance" });
    const proof = await client.prove({ commitment: committed.commitment, disclose: "finance" });

    const ok = await client.verify({ attestationId: proof.attestationId, expect: "finance" });
    expect(ok.valid).toBe(true);
    expect(ok.categoryMatches).toBe(true);

    const bad = await client.verify({ attestationId: proof.attestationId, expect: "health" });
    expect(bad.valid).toBe(true);
    expect(bad.categoryMatches).toBe(false);
    expect(bad.reason).toMatch(/category mismatch/);
  });

  it("verifies a bare existence proof against expect existence", async () => {
    const { client } = makeClient();
    const committed = await client.commit({ text: "a secret", category: "other" });
    const proof = await client.prove({ commitment: committed.commitment });
    const out = await client.verify({ attestationId: proof.attestationId, expect: "existence" });
    expect(out.disclosed).toBe(0);
    expect(out.disclosedLabel).toBe("existence");
    expect(out.categoryMatches).toBe(true);
  });

  it("rejects a malformed attestation id", async () => {
    const { client } = makeClient();
    await expect(client.verify({ attestationId: "nope" })).rejects.toThrow(/64 hex/);
  });

  it("throws on an unknown expected category instead of silently passing", async () => {
    const { client } = makeClient();
    await expect(client.verify({ attestationId: "a".repeat(64), expect: "banana" })).rejects.toThrow(/unknown category/);
  });

  it("binds a proof to a verifier-chosen challenge and refuses to reuse it", async () => {
    const { client } = makeClient();
    const committed = await client.commit({ text: "note", category: "health" });
    const challenge = "b".repeat(64);
    const proof = await client.prove({ commitment: committed.commitment, disclose: "health", attestationId: challenge });
    expect(proof.attestationId).toBe(challenge);
    await expect(
      client.prove({ commitment: committed.commitment, disclose: "health", attestationId: challenge }),
    ).rejects.toThrow(/already used/);
  });

  it("verifies through the adapter in remote mode without private state", async () => {
    const challenge = "c".repeat(64);
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      seen.push(String(url));
      const body = JSON.parse(String(init?.body ?? "{}")) as { attestationId?: string };
      expect(body.attestationId).toBe(challenge);
      return new Response(JSON.stringify({ valid: true, disclosed: CATEGORY_CODES.health, singleUse: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const client = new MidnightClient({
      env: { mode: "local", proofUrl: "http://127.0.0.1:6400", contractAddress: "vault-addr" },
      state: newPersistedState("k"),
      vaultKey: "k",
      save: () => {},
      fetchImpl,
    });
    const out = await client.verify({ attestationId: challenge, expect: "health" });
    expect(out.valid).toBe(true);
    expect(out.disclosedLabel).toBe("health");
    expect(out.categoryMatches).toBe(true);
    expect(out.verifyUrl).toBe(`http://127.0.0.1:6400/verify/${challenge}`);
    expect(seen[0]).toContain("/verify");
  });
});
