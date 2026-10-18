/** The env switch and the prompt section the rest of the agent boots from. */
import { describe, expect, it } from "vitest";
import { midnightEnv, midnightGuidance } from "../src/index.js";

describe("midnightEnv", () => {
  it("is off unless a mode or a contract address is set", () => {
    expect(midnightEnv({})).toBeUndefined();
    expect(midnightEnv({ MIDNIGHT_VERIFY_URL: "https://sealai.inkboxwire.com" })).toBeUndefined();
  });

  it("falls back to mock rather than failing on a misspelled mode", () => {
    expect(midnightEnv({ MIDNIGHT_MODE: "TestNet" })?.mode).toBe("testnet");
    expect(midnightEnv({ MIDNIGHT_MODE: "testnett" })?.mode).toBe("mock");
    expect(midnightEnv({ MIDNIGHT_CONTRACT_ADDRESS: "0xabc" })?.mode).toBe("testnet");
  });

  it("normalizes the public verifier base URL and keeps the rest", () => {
    const env = midnightEnv({
      MIDNIGHT_MODE: "testnet",
      MIDNIGHT_PROOF_URL: "http://127.0.0.1:6400/",
      MIDNIGHT_CONTRACT_ADDRESS: "0xabc",
      MIDNIGHT_VERIFY_URL: "https://sealai.inkboxwire.com/",
      MIDNIGHT_EXPLORER_URL: "https://explorer.midnight.network/",
    });
    expect(env).toEqual({
      mode: "testnet",
      proofUrl: "http://127.0.0.1:6400",
      contractAddress: "0xabc",
      verifyBaseUrl: "https://sealai.inkboxwire.com",
      explorerUrl: "https://explorer.midnight.network",
    });
  });
});

describe("midnightGuidance", () => {
  it("names the public verifier only when the agent has one", () => {
    const bare = midnightGuidance({ mode: "mock", commitments: 0 });
    expect(bare).not.toContain("/verify/");
    const withUrl = midnightGuidance({ mode: "mock", commitments: 2, verifyUrl: "https://sealai.inkboxwire.com/" });
    expect(withUrl).toContain("https://sealai.inkboxwire.com/verify/<attestation id>");
    expect(withUrl).toContain("Anchored commitments so far: 2");
  });
});
