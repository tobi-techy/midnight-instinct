import { describe, expect, it } from "vitest";
import { PROVIDER_KEY_ENV, apiKeyFor } from "../src/boot.js";

describe("apiKeyFor", () => {
  it("reads the gateway key for llmapi", () => {
    expect(PROVIDER_KEY_ENV["llmapi"]).toEqual(["LLM_API_KEY"]);
    expect(apiKeyFor("llmapi", { LLM_API_KEY: "llmapi_abc" })).toBe("llmapi_abc");
  });

  it("keeps a gateway key apart from a real OpenAI key", () => {
    const env = { LLM_API_KEY: "llmapi_abc", OPENAI_API_KEY: "sk-openai" };
    expect(apiKeyFor("llmapi", env)).toBe("llmapi_abc");
    expect(apiKeyFor("openai-compatible", env)).toBe("sk-openai");
  });

  it("ignores blank values and falls back to <PROVIDER>_API_KEY", () => {
    expect(apiKeyFor("llmapi", { LLM_API_KEY: "   " })).toBeUndefined();
    expect(apiKeyFor("groq", {})).toBeUndefined();
    expect(apiKeyFor("some-proxy", { SOME_PROXY_API_KEY: "k" })).toBe("k");
  });
});
