import { describe, expect, it } from "vitest";
import { parseAdopt, parseAgentEnv, readEnv } from "../src/main.js";
import { seedAdopted } from "../src/provision.js";
import { UserStore } from "../src/store.js";
import { readyUser, tempDir } from "./helpers.js";

const adoptEntry = {
  name: "Tobiloba",
  phone: "+2349164904178",
  email: "owner@example.com",
  handle: "@sealai",
  identityId: "idn_sealai",
  identityApiKey: "ik_identity",
  signingKey: "whsec_identity",
};

describe("parseAdopt", () => {
  it("accepts an array of existing identities and normalizes the handle", () => {
    const [entry] = parseAdopt(JSON.stringify([adoptEntry]));
    expect(entry).toEqual({
      name: "Tobiloba",
      phone: "+2349164904178",
      email: "owner@example.com",
      handle: "sealai",
      identityId: "idn_sealai",
      identityApiKey: "ik_identity",
      signingKey: "whsec_identity",
    });
  });

  it("is empty when unset, so a gateway without adopted identities behaves as before", () => {
    expect(parseAdopt(undefined)).toEqual([]);
    expect(parseAdopt("  ")).toEqual([]);
  });

  it("refuses malformed input rather than booting without the identities", () => {
    expect(() => parseAdopt("not json")).toThrow(/JSON array/);
    expect(() => parseAdopt('{"handle":"a"}')).toThrow(/JSON array/);
    expect(() => parseAdopt('[{"name":"a"}]')).toThrow(/phone is required/);
    expect(() => parseAdopt('[{"name":"a","phone":"p","handle":"h"}]')).toThrow(/identityId is required/);
    expect(() => parseAdopt('[{"name":"a","phone":"p","handle":"h","identityId":"i","identityApiKey":"k"},null]')).toThrow(
      /GATEWAY_ADOPT\[1\] must be an object/,
    );
  });
});

describe("parseAgentEnv", () => {
  it("parses extra env for every agent", () => {
    expect(parseAgentEnv('{"INSTINCT_MODEL":"llmapi/gpt-4o","LLM_API_KEY":"k"}')).toEqual({
      INSTINCT_MODEL: "llmapi/gpt-4o",
      LLM_API_KEY: "k",
    });
  });

  it("is undefined when unset or empty", () => {
    expect(parseAgentEnv(undefined)).toBeUndefined();
    expect(parseAgentEnv("{}")).toBeUndefined();
  });

  it("refuses values that are not strings", () => {
    expect(() => parseAgentEnv("[]")).toThrow(/JSON object/);
    expect(() => parseAgentEnv('{"PORT":8080}')).toThrow(/must be a string/);
  });
});

describe("readEnv adoption wiring", () => {
  it("carries adopted identities and agent env through to the config", () => {
    const cfg = readEnv({
      MARITIME_API_KEY: "mk_test",
      GATEWAY_ADOPT: JSON.stringify([adoptEntry]),
      GATEWAY_AGENT_ENV: '{"INSTINCT_MODEL":"llmapi/gpt-4o"}',
    });
    expect(cfg.adopt).toHaveLength(1);
    expect(cfg.adopt[0]?.handle).toBe("sealai");
    expect(cfg.agentEnv).toEqual({ INSTINCT_MODEL: "llmapi/gpt-4o" });
  });
});

describe("seedAdopted", () => {
  it("writes a provisioning record that carries the existing identity", () => {
    const store = new UserStore(tempDir());
    const created = seedAdopted(store, parseAdopt(JSON.stringify([adoptEntry])));
    expect(created).toBe(1);
    const record = store.byHandle("sealai");
    expect(record?.status).toBe("provisioning");
    expect(record?.identityId).toBe("idn_sealai");
    expect(record?.identityApiKey).toBe("ik_identity");
    expect(record?.signingKey).toBe("whsec_identity");
    expect(record?.email).toBe("owner@example.com");
  });

  it("leaves an existing record alone, so a live agent is never re-provisioned", () => {
    const store = new UserStore(tempDir());
    const existing = store.save({ ...readyUser(), handle: "sealai", identityId: "idn_sealai" });
    const created = seedAdopted(store, parseAdopt(JSON.stringify([adoptEntry])));
    expect(created).toBe(0);
    expect(store.byHandle("sealai")?.id).toBe(existing.id);
    expect(store.byHandle("sealai")?.status).toBe("ready");
  });

  it("defaults a missing signing key to empty so provisioning fetches it", () => {
    const store = new UserStore(tempDir());
    const { signingKey: _drop, ...withoutKey } = adoptEntry;
    seedAdopted(store, parseAdopt(JSON.stringify([withoutKey])));
    expect(store.byHandle("sealai")?.signingKey).toBe("");
  });
});
