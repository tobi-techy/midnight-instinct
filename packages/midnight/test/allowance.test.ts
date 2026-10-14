import { describe, expect, it, vi } from "vitest";
import { MidnightClient, allowanceKey, newPersistedState, type PersistedState } from "../src/index.js";

function makeClient() {
  let state: PersistedState = newPersistedState("allowance-test-key");
  const client = new MidnightClient({
    env: { mode: "mock" },
    state,
    vaultKey: "allowance-test-key",
    save: (s) => {
      state = s;
    },
  });
  return { client, state: () => state };
}

describe("read-only allowance check", () => {
  it("reports no allowance before one is authorized", async () => {
    const { client } = makeClient();
    const out = await client.checkAllowance({ owner: "Maria", spender: "owner", capability: "purchase", amountUsd: 20 });
    expect(out.active).toBe(false);
    expect(out.allowed).toBe(false);
    expect(out.reason).toMatch(/no active on-chain allowance/);
  });

  it("allows an amount inside a live allowance and reports what is left", async () => {
    const { client } = makeClient();
    await client.authorize("Maria", "owner", "purchase", 50);
    const out = await client.checkAllowance({ owner: "Maria", spender: "owner", capability: "purchase", amountUsd: 20 });
    expect(out.active).toBe(true);
    expect(out.allowed).toBe(true);
    expect(out.limitCents).toBe(5000);
    expect(out.spentCents).toBe(0);
    expect(out.remainingCents).toBe(5000);
    expect(out.reason).toMatch(/within the on-chain allowance/);
  });

  it("counts what was already spent and refuses to go over", async () => {
    const { client } = makeClient();
    await client.authorize("Maria", "owner", "purchase", 50);
    await client.checkSpend({ owner: "Maria", spender: "owner", capability: "purchase", amountUsd: 30 });

    const fits = await client.checkAllowance({ owner: "Maria", spender: "owner", capability: "purchase", amountUsd: 20 });
    expect(fits.allowed).toBe(true);
    expect(fits.spentCents).toBe(3000);
    expect(fits.remainingCents).toBe(2000);

    const over = await client.checkAllowance({ owner: "Maria", spender: "owner", capability: "purchase", amountUsd: 20.01 });
    expect(over.allowed).toBe(false);
    expect(over.reason).toMatch(/exceeds the \$20\.00 left/);
  });

  it("does not spend when it only checks", async () => {
    const { client, state } = makeClient();
    await client.authorize("Maria", "owner", "purchase", 50);
    await client.checkAllowance({ owner: "Maria", spender: "owner", capability: "purchase", amountUsd: 20 });
    const key = allowanceKey("Maria", "owner", "purchase");
    expect(state().allowances[key]?.spentCents).toBe(0);
  });

  it("stops being allowed once revoked", async () => {
    const { client } = makeClient();
    await client.authorize("Maria", "sam", "purchase", 50);
    await client.revokeAllowance("Maria", "sam", "purchase");
    const out = await client.checkAllowance({ owner: "Maria", spender: "sam", capability: "purchase", amountUsd: 5 });
    expect(out.active).toBe(false);
    expect(out.allowed).toBe(false);
  });

  it("keys allowances per (owner, spender, capability)", async () => {
    const { client } = makeClient();
    await client.authorize("Maria", "sam", "purchase", 50);
    const other = await client.checkAllowance({ owner: "Maria", spender: "owner", capability: "purchase", amountUsd: 5 });
    expect(other.active).toBe(false);
    const otherCap = await client.checkAllowance({ owner: "Maria", spender: "sam", capability: "computer.use" });
    expect(otherCap.active).toBe(false);
  });

  it("reads the registry instead of local state when a network is configured", async () => {
    const seen: unknown[] = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      seen.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response(JSON.stringify({ key: "k", active: true, limitCents: 5000, spentCents: 1000 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const client = new MidnightClient({
      env: { mode: "local", proofUrl: "http://127.0.0.1:6400", contractAddress: "vault", allowanceAddress: "registry" },
      state: newPersistedState("k"),
      vaultKey: "k",
      save: () => {},
      fetchImpl,
    });

    const fits = await client.checkAllowance({ owner: "Maria", spender: "owner", capability: "purchase", amountUsd: 40 });
    expect(fits.active).toBe(true);
    expect(fits.spentCents).toBe(1000);
    expect(fits.allowed).toBe(true);
    expect(String((seen[0] as { url: string }).url)).toContain("/allowance/check");

    const over = await client.checkAllowance({ owner: "Maria", spender: "owner", capability: "purchase", amountUsd: 40.01 });
    expect(over.allowed).toBe(false);
  });
});
