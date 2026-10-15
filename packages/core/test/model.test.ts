import { describe, expect, it } from "vitest";
import { LLMAPI_DEFAULT_BASE_URL, LLMAPI_PROVIDER, OPENAI_COMPATIBLE_PROVIDER, modelSpecOf, resolveModel } from "../src/model.js";

describe("resolveModel", () => {
  it("resolves catalog models by provider/id", () => {
    const m = resolveModel("anthropic/claude-fable-5-1");
    expect(m.provider).toBe("anthropic");
    expect(m.id).toBe("claude-fable-5-1");
    expect(m.api).toBe("anthropic-messages");
    expect(modelSpecOf(m)).toBe("anthropic/claude-fable-5-1");
  });

  it("keeps slashes inside model ids", () => {
    const m = resolveModel("openrouter/anthropic/claude-sonnet-4.5");
    expect(m.provider).toBe("openrouter");
    expect(m.id).toBe("anthropic/claude-sonnet-4.5");
  });

  it("builds an OpenAI-compatible model from env without storing the key", () => {
    const m = resolveModel("openai-compatible/llama-3.3-70b", { OPENAI_BASE_URL: "http://localhost:11434/v1", OPENAI_API_KEY: "sk-secret" });
    expect(m.provider).toBe(OPENAI_COMPATIBLE_PROVIDER);
    expect(m.id).toBe("llama-3.3-70b");
    expect(m.api).toBe("openai-completions");
    expect(m.baseUrl).toBe("http://localhost:11434/v1");
    expect(JSON.stringify(m)).not.toContain("sk-secret");
  });

  it("requires OPENAI_BASE_URL for openai-compatible", () => {
    expect(() => resolveModel("openai-compatible/x", {})).toThrow(/OPENAI_BASE_URL/);
  });

  it("resolves llmapi models against the gateway without a base URL", () => {
    const m = resolveModel("llmapi/gpt-4o", { LLM_API_KEY: "llmapi-secret" });
    expect(m.provider).toBe(LLMAPI_PROVIDER);
    expect(m.id).toBe("gpt-4o");
    expect(m.api).toBe("openai-completions");
    expect(m.baseUrl).toBe(LLMAPI_DEFAULT_BASE_URL);
    expect(modelSpecOf(m)).toBe("llmapi/gpt-4o");
    expect(JSON.stringify(m)).not.toContain("llmapi-secret");
  });

  it("keeps slashes inside llmapi model ids and honours LLMAPI_BASE_URL", () => {
    const m = resolveModel("llmapi/anthropic/claude-sonnet-4.5", { LLMAPI_BASE_URL: "https://proxy.internal/v1" });
    expect(m.id).toBe("anthropic/claude-sonnet-4.5");
    expect(m.provider).toBe(LLMAPI_PROVIDER);
    expect(m.baseUrl).toBe("https://proxy.internal/v1");
  });

  it("explains bad specs with examples", () => {
    expect(() => resolveModel("claude-fable-5-1")).toThrow(/provider\/model-id/);
    expect(() => resolveModel("nope/model")).toThrow(/unknown provider "nope"/);
    expect(() => resolveModel("anthropic/claude-99")).toThrow(/has no model "claude-99"/);
    expect(() => resolveModel("anthropic/claude-99")).toThrow(/anthropic\/claude-fable-5-1/);
  });
});
