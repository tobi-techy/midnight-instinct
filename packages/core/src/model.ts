/**
 * Model resolution. A model spec is "provider/model-id" from the Pi catalog,
 * "openai-compatible/<model-id>" for any OpenAI-compatible endpoint (vLLM, Ollama,
 * LiteLLM, a proxy), or "llmapi/<model-id>" for the LLM API gateway (llmapi.ai),
 * which fronts many vendors behind one OpenAI-compatible endpoint. This is the only
 * place in core that looks at env, and only the env object it is handed.
 */
import type { Model } from "@earendil-works/pi-ai";
import { getModel, getModels, getProviders } from "@earendil-works/pi-ai/compat";

export const OPENAI_COMPATIBLE_PROVIDER = "openai-compatible";
/** The LLM API gateway: one key and one base URL for OpenAI, Anthropic, Google and others. */
export const LLMAPI_PROVIDER = "llmapi";
export const LLMAPI_DEFAULT_BASE_URL = "https://api.llmapi.ai/v1";

const EXAMPLES = [
  "anthropic/claude-fable-5-1",
  "anthropic/claude-opus-5-5",
  "anthropic/claude-sonnet-5-5",
  "openai/gpt-5.4",
  "openai-compatible/<model-id> (uses OPENAI_BASE_URL and OPENAI_API_KEY)",
  "llmapi/<model-id> (uses LLM_API_KEY, base URL https://api.llmapi.ai/v1)",
];

export function resolveModel(spec: string, env: NodeJS.ProcessEnv = {}): Model<any> {
  const trimmed = spec.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) {
    throw new Error(unknownSpec(trimmed, "expected \"provider/model-id\""));
  }
  const provider = trimmed.slice(0, slash);
  // Model ids may themselves contain slashes (openrouter, huggingface), so split once.
  const id = trimmed.slice(slash + 1);

  if (provider === OPENAI_COMPATIBLE_PROVIDER) return openAiCompatibleModel(id, env);
  if (provider === LLMAPI_PROVIDER) return llmapiModel(id, env);

  const model = (getModel as (p: string, m: string) => Model<any> | undefined)(provider, id);
  if (model) return model;

  const providers = getProviders() as string[];
  if (!providers.includes(provider)) {
    throw new Error(unknownSpec(trimmed, `unknown provider "${provider}"`));
  }
  const known = (getModels as (p: string) => Model<any>[])(provider as never)
    .map((m) => m.id)
    .slice(0, 12)
    .join(", ");
  throw new Error(unknownSpec(trimmed, `provider "${provider}" has no model "${id}". Known: ${known}`));
}

export function modelSpecOf(model: Model<any>): string {
  return `${model.provider}/${model.id}`;
}

function openAiCompatibleModel(id: string, env: NodeJS.ProcessEnv): Model<"openai-completions"> {
  const baseUrl = env.OPENAI_BASE_URL?.trim();
  if (!baseUrl) {
    throw new Error(
      `Model "${OPENAI_COMPATIBLE_PROVIDER}/${id}" needs OPENAI_BASE_URL (for example http://localhost:11434/v1). ` +
        `Set OPENAI_API_KEY too when the endpoint checks it.`,
    );
  }
  return openAiCompletionsShape(OPENAI_COMPATIBLE_PROVIDER, id, baseUrl);
}

/**
 * The gateway serves one OpenAI-compatible endpoint, so the model id stays whatever the
 * gateway calls it and no base URL is needed. LLMAPI_BASE_URL overrides the default.
 */
function llmapiModel(id: string, env: NodeJS.ProcessEnv): Model<"openai-completions"> {
  return openAiCompletionsShape(LLMAPI_PROVIDER, id, env.LLMAPI_BASE_URL?.trim() || LLMAPI_DEFAULT_BASE_URL);
}

// The API key is not stored on the model. The runtime hands it to Pi through getApiKey
// so secrets stay out of anything that could be logged or persisted.
function openAiCompletionsShape(provider: string, id: string, baseUrl: string): Model<"openai-completions"> {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider,
    baseUrl,
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
  };
}

function unknownSpec(spec: string, why: string): string {
  return `Unknown model spec "${spec}": ${why}. Valid examples: ${EXAMPLES.join("; ")}.`;
}
