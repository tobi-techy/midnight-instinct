import { InkboxProvisioner } from "@open-instinct/inkbox";
import { consoleLogger } from "./logger.js";
import { type AdoptIdentity, type LinkPassthrough, seedAdopted } from "./provision.js";
import { type GatewayServer, createGateway } from "./server.js";
import { UserStore } from "./store.js";

export const DEFAULT_AGENT_IMAGE = "ghcr.io/mariagorskikh/open-instinct-agent:latest";

export interface GatewayEnv {
  port: number;
  publicUrl: string;
  dataDir: string;
  inkboxAdminApiKey?: string;
  inkboxBaseUrl?: string;
  maritimeApiKey: string;
  maritimeBaseUrl?: string;
  agentImage: string;
  signupSecret?: string;
  /** GATEWAY_ALLOW_OPEN_SIGNUP=1: run the signup form without an invite code. Off by default. */
  allowOpenSignup: boolean;
  /** GATEWAY_TRUST_PROXY=1: rate-limit by X-Forwarded-For (Railway, Fly, a reverse proxy you run). */
  trustProxy: boolean;
  anthropicApiKey?: string;
  composioApiKey?: string;
  composioToolkits?: string;
  idleTtlSeconds?: number;
  useMaritimeLlm: boolean;
  maritimeModel?: string;
  link?: LinkPassthrough;
  /** Identities that already exist in Inkbox. The gateway relays for them without signup. */
  adopt: AdoptIdentity[];
  /** Extra env for every agent this gateway creates, e.g. INSTINCT_MODEL and LLM_API_KEY. */
  agentEnv?: Record<string, string>;
}

function truthy(v: string | undefined): boolean {
  return v !== undefined && /^(1|true|yes)$/i.test(v.trim());
}

function requireString(entry: Record<string, unknown>, key: string, where: string): string {
  const v = entry[key];
  if (typeof v !== "string" || !v.trim()) throw new Error(`${where}.${key} is required`);
  return v;
}

/** GATEWAY_ADOPT: a JSON array of identities the operator already owns (see AdoptIdentity). */
export function parseAdopt(raw: string | undefined): AdoptIdentity[] {
  if (!raw || !raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("GATEWAY_ADOPT must be a JSON array");
  }
  if (!Array.isArray(parsed)) throw new Error("GATEWAY_ADOPT must be a JSON array");
  return parsed.map((entry, i) => {
    const where = `GATEWAY_ADOPT[${i}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`${where} must be an object`);
    const o = entry as Record<string, unknown>;
    const out: AdoptIdentity = {
      name: requireString(o, "name", where),
      phone: requireString(o, "phone", where),
      handle: requireString(o, "handle", where).replace(/^@/, ""),
      identityId: requireString(o, "identityId", where),
      identityApiKey: requireString(o, "identityApiKey", where),
    };
    if (typeof o["email"] === "string" && o["email"]) out.email = o["email"];
    if (typeof o["signingKey"] === "string" && o["signingKey"]) out.signingKey = o["signingKey"];
    if (typeof o["id"] === "string" && o["id"]) out.id = o["id"];
    return out;
  });
}

/** GATEWAY_AGENT_ENV: a JSON object of extra env for every agent this gateway creates. */
export function parseAgentEnv(raw: string | undefined): Record<string, string> | undefined {
  if (!raw || !raw.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("GATEWAY_AGENT_ENV must be a JSON object");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("GATEWAY_AGENT_ENV must be a JSON object");
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "string") throw new Error(`GATEWAY_AGENT_ENV.${key} must be a string`);
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The only place the gateway reads process.env. Everything else takes options. */
export function readEnv(env: NodeJS.ProcessEnv): GatewayEnv {
  const port = Number(env["PORT"] ?? 8787);
  const maritimeApiKey = env["MARITIME_API_KEY"];
  if (!maritimeApiKey) throw new Error("MARITIME_API_KEY is required (the gateway forwards every message through Maritime).");
  const publicUrl = env["GATEWAY_PUBLIC_URL"] ?? `http://localhost:${port}`;
  const idle = env["INSTINCT_IDLE_TTL_SECONDS"] ? Number(env["INSTINCT_IDLE_TTL_SECONDS"]) : undefined;
  const linkClientId = env["LINK_CLIENT_ID"] || undefined;
  const link: LinkPassthrough | undefined = linkClientId
    ? {
        clientId: linkClientId,
        ...(env["LINK_CLIENT_SECRET"] ? { clientSecret: env["LINK_CLIENT_SECRET"] } : {}),
        ...(env["STRIPE_PUBLISHABLE_KEY"] ? { stripePublishableKey: env["STRIPE_PUBLISHABLE_KEY"] } : {}),
      }
    : undefined;
  return {
    port,
    publicUrl,
    dataDir: env["GATEWAY_DATA_DIR"] ?? "./.instinct-gateway",
    inkboxAdminApiKey: env["INKBOX_ADMIN_API_KEY"] || undefined,
    inkboxBaseUrl: env["INKBOX_BASE_URL"] || undefined,
    maritimeApiKey,
    maritimeBaseUrl: env["MARITIME_API_URL"] || undefined,
    agentImage: env["INSTINCT_AGENT_IMAGE"] || DEFAULT_AGENT_IMAGE,
    signupSecret: env["GATEWAY_SIGNUP_SECRET"] || undefined,
    allowOpenSignup: truthy(env["GATEWAY_ALLOW_OPEN_SIGNUP"]) || truthy(env["GATEWAY_OPEN_SIGNUP"]),
    trustProxy: truthy(env["GATEWAY_TRUST_PROXY"]),
    anthropicApiKey: env["ANTHROPIC_API_KEY"] || undefined,
    composioApiKey: env["COMPOSIO_API_KEY"] || undefined,
    composioToolkits: env["COMPOSIO_TOOLKITS"] || env["INSTINCT_COMPOSIO_TOOLKITS"] || undefined,
    idleTtlSeconds: idle !== undefined && Number.isFinite(idle) ? idle : undefined,
    useMaritimeLlm: truthy(env["INSTINCT_USE_MARITIME_LLM"]),
    maritimeModel: env["INSTINCT_MARITIME_MODEL"] || undefined,
    link,
    adopt: parseAdopt(env["GATEWAY_ADOPT"]),
    agentEnv: parseAgentEnv(env["GATEWAY_AGENT_ENV"]),
  };
}

/**
 * Signup provisions an Inkbox identity and a Maritime VM, both billed to the
 * operator. With a provisioner configured the form is live, so it must be
 * behind an invite code unless the operator opts into open signup by name.
 */
export function checkSignupPolicy(cfg: Pick<GatewayEnv, "inkboxAdminApiKey" | "signupSecret" | "allowOpenSignup">): { ok: true; open: boolean } | { ok: false; reason: string } {
  if (!cfg.inkboxAdminApiKey) return { ok: true, open: false };
  if (cfg.signupSecret) return { ok: true, open: false };
  if (cfg.allowOpenSignup) return { ok: true, open: true };
  return {
    ok: false,
    reason:
      "INKBOX_ADMIN_API_KEY is set but GATEWAY_SIGNUP_SECRET is not. Every signup creates a billed identity and VM, so set an invite code, " +
      "or set GATEWAY_ALLOW_OPEN_SIGNUP=1 to run the form open to the internet on purpose.",
  };
}

export function startGateway(cfg: GatewayEnv): GatewayServer {
  const log = consoleLogger;
  const policy = checkSignupPolicy(cfg);
  if (!policy.ok) throw new Error(policy.reason);
  if (policy.open) {
    log.warn("gateway.open_signup", {
      warning: "Signup is open to anyone. Each signup bills your Maritime wallet and Inkbox plan. Set GATEWAY_SIGNUP_SECRET to close it.",
    });
  }

  const store = new UserStore(cfg.dataDir);
  // Records for identities that already exist. Seeded before listen so the
  // resume pass on boot finishes them: webhooks, then the Maritime agent.
  const adopted = seedAdopted(store, cfg.adopt);
  if (adopted > 0) log.info("gateway.adopted", { count: adopted });
  const inkbox = cfg.inkboxAdminApiKey
    ? new InkboxProvisioner({ adminApiKey: cfg.inkboxAdminApiKey, baseUrl: cfg.inkboxBaseUrl })
    : undefined;
  if (!inkbox) log.warn("gateway.relay_only", { reason: "INKBOX_ADMIN_API_KEY not set; signup disabled" });
  if (!cfg.publicUrl.startsWith("https://")) log.warn("gateway.public_url_not_https", { publicUrl: cfg.publicUrl });

  const server = createGateway({
    store,
    publicUrl: cfg.publicUrl,
    inkbox,
    inkboxBaseUrl: cfg.inkboxBaseUrl,
    maritime: {
      apiKey: cfg.maritimeApiKey,
      baseUrl: cfg.maritimeBaseUrl,
      agentImage: cfg.agentImage,
      idleTtlSeconds: cfg.idleTtlSeconds,
      useMaritimeLlm: cfg.useMaritimeLlm,
      maritimeModel: cfg.maritimeModel,
      ...(cfg.agentEnv ? { extraEnv: cfg.agentEnv } : {}),
    },
    signupSecret: cfg.signupSecret,
    anthropicApiKey: cfg.anthropicApiKey,
    composioApiKey: cfg.composioApiKey,
    composioToolkits: cfg.composioToolkits,
    link: cfg.link,
    trustProxy: cfg.trustProxy,
    logger: log,
    // The triage endpoint called with an identity-scoped key answers for that identity, so its QR fits the user.
    routerInfoFor: (user) => new InkboxProvisioner({ adminApiKey: user.identityApiKey, baseUrl: cfg.inkboxBaseUrl }).routerInfo(),
  });
  server.listen(cfg.port, "0.0.0.0", () => {
    log.info("gateway.listening", { port: cfg.port, publicUrl: cfg.publicUrl, users: store.all().length, signup: Boolean(inkbox), link: Boolean(cfg.link) });
    server.resumePending();
  });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(0), 10_000);
    deadline.unref();
    server.close(() => { void server.drainWebhooks().finally(() => process.exit(0)); });
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  return server;
}

const isMain = process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  try {
    startGateway(readEnv(process.env));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
