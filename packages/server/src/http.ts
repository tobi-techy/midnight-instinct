/**
 * The agent's HTTP surface. It satisfies Maritime's BYO contract (/health, /chat,
 * /schedules) and takes Inkbox webhooks directly when self-hosted. Every handler
 * catches its own errors; a bad request must never take the process down.
 *
 * Trust model. /health is open. /chat, /status and /schedules are the owner's
 * surface: when a chat token is configured (INSTINCT_CHAT_TOKEN) every call must
 * carry it, otherwise they answer 401. Without a token the server relies on the
 * network: main.ts binds loopback unless a container env says otherwise, and a
 * Maritime VM only exposes /chat through Maritime's own authenticated API. The
 * Inkbox tunnel never reaches this surface: it forwards to a second listener
 * built with `tunnelOnly: true`, which serves /health, /webhooks/inkbox and the
 * read-only /verify/<attestationId> only.
 */
import http from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { decodeEvent } from "@open-instinct/core";
import type { AgentRuntime, HandleResult, InboundMessage, InstinctConfig, OutboundMessage, ScheduleEntry, Scheduler, StateDir } from "@open-instinct/core";
import { DurableInbox, parseInkboxEvent, verifyInkboxSignature } from "@open-instinct/inkbox";
import type { VerifyResult } from "@open-instinct/midnight";

/** Replies the console outbox is holding for a chat conversation. */
export interface ChatBuffer {
  /** Remove and return what is waiting for one conversation. */
  take(conversationKey: string): OutboundMessage[];
  /** Conversations with waiting replies and how many each. */
  pendingCounts(): Record<string, number>;
}

/** The slice of a Link wallet the HTTP layer needs for the OAuth callback. */
export interface WalletCallback {
  handleCallback(code: string, state: string): Promise<void>;
  isConnected(): boolean;
  /** Starts a PKCE flow; the server keeps the verifier. Optional so older stubs still fit. */
  authorizeUrl?(): { url: string; state: string };
}

/** Checks one attestation against the ledger. Present when the Midnight layer is on. */
export type MidnightVerifier = (attestationId: string) => Promise<VerifyResult>;

/** The slice of a boot() result the HTTP layer needs. Tests pass stubs. */
export interface HttpApp {
  state?: StateDir;
  hydrateInbound?(msg: InboundMessage): Promise<InboundMessage>;
  runtime: Pick<AgentRuntime, "handleInbound" | "stats"> & Partial<Pick<AgentRuntime, "runScheduled">>;
  scheduler: Pick<Scheduler, "toMaritimeSchedules"> & Partial<Pick<Scheduler, "list" | "markRan">>;
  config: InstinctConfig;
  computerKind?: string;
  appsConnected?: string[];
  /**
   * Midnight privacy layer status when configured. A getter so every request
   * reports the current anchor and proof counts, not the boot-time ones.
   */
  midnightStatus?: () => { mode: string; contractAddress?: string; proofUrl?: string; commitments: number; attestations: number; allowances: number; latestAttestation?: string };
  /**
   * The public verifier: anyone with an attestation id can ask whether it is recorded
   * and which single category it disclosed. No secrets, no writes, so it is the one
   * route the tunnel exposes besides /health and the Inkbox webhook.
   */
  midnightVerify?: MidnightVerifier;
  startedAt?: number;
  modelSpec?: string;
  /** Set when the outbox buffers chat replies (ConsoleOutbox or the chat-aware Inkbox wrapper). */
  chatBuffer?: ChatBuffer;
  /** Set when payments are configured. */
  wallet?: WalletCallback;
}

export interface HttpServerOptions {
  /** Inkbox webhook signing key. Falls back to signingKeyProvider, then env INKBOX_SIGNING_KEY. */
  signingKey?: string;
  /** Resolved on every webhook, so a key learned after startup (tunnel + subscribe) is picked up. */
  signingKeyProvider?: () => string | undefined;
  logger?: (m: string) => void;
  env?: NodeJS.ProcessEnv;
  /** Max request body. Default 1 MiB. */
  bodyLimitBytes?: number;
  /**
   * Shared secret for /chat, /status and /schedules. Falls back to env INSTINCT_CHAT_TOKEN.
   * When neither is set those routes are open and the bind address is the only guard.
   */
  chatToken?: string;
  /**
   * Serve only what the public tunnel may see: GET /health and POST /webhooks/inkbox.
   * Everything else is 404. main.ts runs one of these on loopback for the Inkbox tunnel.
   */
  tunnelOnly?: boolean;
  now?: () => Date;
}

export const BODY_LIMIT_BYTES = 1024 * 1024;
export const CHAT_TOKEN_HEADER = "x-instinct-token";
export const TUNNEL_ROUTES: ReadonlySet<string> = new Set(["GET /health", "POST /webhooks/inkbox"]);
/** `/verify/<attestationId>`: one 64-hex id, so a link is both unguessable and bounded. */
export const VERIFY_PATH = /^\/verify\/([0-9a-f]{64})$/i;
/** The verifier's front door: a form, and a `?id=` hand-off for a pre-filled link. */
export const VERIFY_INDEX_PATH = "/verify";

/** The read-only verifier the public tunnel may reach, next to health and the webhook. */
export function isTunnelRoute(method: string, path: string): boolean {
  if (TUNNEL_ROUTES.has(`${method} ${path}`)) return true;
  if (method !== "GET") return false;
  return path === VERIFY_INDEX_PATH || VERIFY_PATH.test(path);
}
/** A Maritime schedule wake may arrive a little before the minute boundary we computed. */
export const SCHEDULE_WAKE_GRACE_MS = 90_000;
/** Envelope event type the gateway relays when Link redirects to its callback URL. */
export const LINK_CALLBACK_EVENT = "link.oauth_callback";

const inboxes = new WeakMap<HttpApp, { queue: DurableInbox<InboundMessage>; listeners: number; closing?: Promise<void> }>();

/** Wait for admitted work before closing the agent's tool clients. */
export async function closeInkboxInbox(app: HttpApp): Promise<void> {
  const inbox = inboxes.get(app);
  if (!inbox) return;
  inbox.closing ??= inbox.queue.close().finally(() => {
    if (inboxes.get(app) === inbox) inboxes.delete(app);
  });
  await inbox.closing;
}

async function processInbound(app: HttpApp, msg: InboundMessage): Promise<HandleResult> {
  const hydrated = app.hydrateInbound ? await app.hydrateInbound(msg) : msg;
  return app.runtime.handleInbound(hydrated, { waitForCompletion: true });
}

async function acceptInbound(app: HttpApp, msg: InboundMessage): Promise<ChatResponse> {
  const inbox = inboxes.get(app);
  if (inbox) {
    const fresh = inbox.queue.enqueue(msg.id, msg);
    return { response: "", acked: true, conversationKey: msg.conversationKey, ...(fresh ? {} : { blocked: "duplicate" }) };
  }
  // Embedders without persistent state must finish handling before acknowledging.
  return summarize(await processInbound(app, msg), true);
}

export interface ChatRequest {
  message: string;
  source?: string;
  conversation_id?: string;
}

export interface ChatResponse {
  response: string;
  acked?: boolean;
  conversationKey?: string;
  blocked?: string;
  /** Replies the agent finished after an earlier /chat on this conversation acked. */
  pending?: string[];
}

export const ACK_TEXT = "On it. I will send the result when it is done.";

/** Build the owner's InboundMessage for a plain /chat call (dashboard, CLI, maritime chat). */
export function ownerChatMessage(body: ChatRequest, now: Date = new Date()): InboundMessage {
  return {
    id: `chat:${randomUUID()}`,
    channel: "chat",
    conversationKey: `chat:${body.conversation_id ?? "default"}`,
    from: "owner",
    text: body.message,
    replyRef: {},
    receivedAt: now.toISOString(),
    ...(body.source ? { source: body.source } : {}),
  };
}

/** Does this token match the configured one? Constant time, never throws. */
export function tokenMatches(expected: string | undefined, presented: string | undefined): boolean {
  if (!expected) return true;
  if (!presented) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(presented, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The token a request presents: `Authorization: Bearer <t>` or `X-Instinct-Token: <t>`. */
export function presentedToken(headers: http.IncomingHttpHeaders): string | undefined {
  const auth = headers.authorization;
  if (typeof auth === "string") {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m?.[1]) return m[1].trim();
  }
  const raw = headers[CHAT_TOKEN_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * The /chat body is one of: an Inkbox event the gateway wrapped in an envelope, a
 * Link OAuth callback the gateway relayed, a Maritime schedule wake, or the owner
 * typing. Envelope replies go out through the outbox, so the HTTP response carries
 * only an acknowledgement.
 */
export async function handleChat(app: HttpApp, body: ChatRequest, now: Date = new Date()): Promise<ChatResponse> {
  const event = decodeEvent(body.message);
  if (event !== undefined) {
    const link = linkCallbackOf(event);
    if (link) {
      if (!app.wallet) return { response: "", acked: true, blocked: "payments not configured" };
      await app.wallet.handleCallback(link.code, link.state);
      return { response: "", acked: true };
    }
    const inbound = parseInkboxEvent(event);
    if (!inbound) return { response: "", acked: true };
    if (body.source) {
      // The parser knows the channel ("webhook"); Maritime knows how it reached us (front_door, cli, ...).
      inbound.source ??= body.source;
      inbound.meta = { ...inbound.meta, relaySource: body.source };
    }
    return acceptInbound(app, inbound);
  }
  if (body.source === "scheduled") return handleScheduledWake(app, body, now);
  const msg = ownerChatMessage(body, now);
  const result = await app.runtime.handleInbound(msg);
  const out = summarize(result, false);
  const pending = app.chatBuffer?.take(msg.conversationKey).map((m) => m.text).filter((t) => t.length > 0);
  if (pending && pending.length > 0) out.pending = pending;
  return out;
}

/**
 * Maritime wakes the VM for a pushed schedule by posting its prompt with
 * source="scheduled". The entry must run as the scheduled job (owner principal on
 * `scheduled:<id>`, result texted to the owner), not as the owner typing in chat,
 * and it must run once even though the in-process timer is also awake. The timer
 * marks an entry as run before firing it, so an entry that is no longer due was
 * already handled and the wake is just acknowledged.
 */
export async function handleScheduledWake(app: HttpApp, body: ChatRequest, now: Date = new Date()): Promise<ChatResponse> {
  const { scheduler, runtime } = app;
  if (!scheduler.list || !scheduler.markRan || !runtime.runScheduled) {
    return { response: "", acked: true, blocked: "scheduled wakes are not supported by this runtime" };
  }
  const entry = matchScheduleEntry(scheduler.list(), body.message);
  if (!entry) return { response: "", acked: true, blocked: "unknown schedule" };
  const key = `scheduled:${entry.id}`;
  if (!entry.enabled || entry.nextRunAt === undefined || Date.parse(entry.nextRunAt) > now.getTime() + SCHEDULE_WAKE_GRACE_MS) {
    return { response: "", acked: true, conversationKey: key, blocked: "already ran" };
  }
  scheduler.markRan(entry.id, now);
  // The job texts the owner itself; nothing useful can go back to Maritime within the budget.
  void runtime.runScheduled(entry).catch(() => undefined);
  return { response: "", acked: true, conversationKey: key };
}

/** The entry a wake refers to: its id anywhere in the message, else an exact prompt match. */
export function matchScheduleEntry(entries: ScheduleEntry[], message: string): ScheduleEntry | undefined {
  const text = message.trim();
  const byId = entries.find((e) => e.id.length > 0 && text.includes(e.id));
  if (byId) return byId;
  return entries.find((e) => e.prompt.trim() === text);
}

function linkCallbackOf(event: unknown): { code: string; state: string } | undefined {
  if (!event || typeof event !== "object") return undefined;
  const e = event as Record<string, unknown>;
  if (e.type !== LINK_CALLBACK_EVENT && e.event_type !== LINK_CALLBACK_EVENT) return undefined;
  if (typeof e.code !== "string" || typeof e.state !== "string" || !e.code || !e.state) return undefined;
  return { code: e.code, state: e.state };
}

function summarize(result: HandleResult, envelope: boolean): ChatResponse {
  const base: ChatResponse = { response: "", acked: result.acked, conversationKey: result.conversationKey };
  if (result.blocked) base.blocked = result.blocked;
  if (envelope) return base;
  base.response = result.reply ?? (result.acked ? ACK_TEXT : "");
  return base;
}

export function statusJson(app: HttpApp, now: number = Date.now()): Record<string, unknown> {
  const stats = app.runtime.stats();
  const out: Record<string, unknown> = {
    ok: true,
    agent: app.config.agent.name,
    handle: app.config.agent.handle ?? null,
    owner: app.config.owner.name,
    model: app.modelSpec ?? app.config.model.primary,
    conversations: stats.conversations,
    busy: stats.busy,
    computer: app.computerKind ?? "none",
    apps: app.appsConnected ?? [],
    uptimeSeconds: app.startedAt ? Math.round((now - app.startedAt) / 1000) : 0,
  };
  if (app.chatBuffer) out.pendingReplies = app.chatBuffer.pendingCounts();
  if (app.wallet) out.payments = { connected: app.wallet.isConnected() };
  if (app.midnightStatus) out.midnight = app.midnightStatus();
  return out;
}

export function createHttpServer(app: HttpApp, opts: HttpServerOptions = {}): http.Server {
  const log = opts.logger ?? (() => {});
  const env = opts.env ?? process.env;
  const limit = opts.bodyLimitBytes ?? BODY_LIMIT_BYTES;
  const now = opts.now ?? (() => new Date());
  const signingKey = (): string | undefined => opts.signingKey ?? opts.signingKeyProvider?.() ?? env.INKBOX_SIGNING_KEY;
  const chatToken = opts.chatToken ?? env.INSTINCT_CHAT_TOKEN?.trim() ?? undefined;
  const tunnelOnly = opts.tunnelOnly === true;
  if (inboxes.get(app)?.closing) throw new Error("The agent's webhook inbox is still closing");
  if (app.state && !inboxes.has(app)) {
    inboxes.set(app, {
      listeners: 0,
      queue: new DurableInbox<InboundMessage>({
        file: app.state.path("inkbox-inbox.json"),
        handle: async (msg) => { await processInbound(app, msg); },
        onError: (id, status) => log(`Inkbox event ${id}: ${status}`),
      }),
    });
  }
  const inbox = inboxes.get(app);
  if (inbox) inbox.listeners++;

  const server = http.createServer((req, res) => {
    route(req, res).catch((err: unknown) => {
      log(`unhandled route error: ${(err as Error).message}`);
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
      else res.end();
    });
  });

  async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (tunnelOnly && !isTunnelRoute(method, path)) return sendJson(res, 404, { error: "not found" });

    if (method === "GET" && path === "/health") return sendJson(res, 200, { ok: true });

    // A proof is public by construction: the verifier learns what the prover disclosed
    // and nothing else, so this route is open to the network, not just the owner.
    if (method === "GET" && path === VERIFY_INDEX_PATH) return verifyIndex(url, res);
    if (method === "GET" && VERIFY_PATH.test(path)) return verifyProof(path, req, res);

    if (method === "POST" && path === "/webhooks/inkbox") {
      const key = signingKey();
      if (!key) return sendJson(res, 503, { error: "webhook signing key not configured" });
      const raw = await readBody(req, limit);
      if (raw === undefined) return sendJson(res, 413, { error: "body too large" });
      if (!verifyInkboxSignature(raw, req.headers, key)) return sendJson(res, 401, { error: "invalid signature" });
      const payload = parseJson(raw);
      if (payload === undefined) return sendJson(res, 400, { error: "invalid JSON" });
      const inbound = parseInkboxEvent(payload);
      if (inbound) await acceptInbound(app, inbound);
      res.statusCode = 204;
      res.end();
      return;
    }

    if (method === "GET" && path === "/oauth/link/callback") return linkCallback(url, res);

    // Everything below is the owner's surface.
    if (!tokenMatches(chatToken, presentedToken(req.headers))) {
      return sendJson(res, 401, { error: "missing or invalid token" });
    }

    if (method === "GET" && (path === "/" || path === "/status")) return sendJson(res, 200, { ...statusJson(app), ...(inbox ? { inkboxInbox: inbox.queue.summary() } : {}) });
    if (method === "GET" && path === "/schedules") return sendJson(res, 200, app.scheduler.toMaritimeSchedules());
    // `instinct midnight status`. Owner surface: mode, contract addresses and anchor counts.
    if (method === "GET" && path === "/midnight/status") {
      if (!app.midnightStatus) return sendJson(res, 404, { error: "midnight not configured" });
      return sendJson(res, 200, app.midnightStatus());
    }
    // `instinct payments connect | status`. Owner surface: the authorize URL starts a flow this server completes.
    if (method === "GET" && path === "/oauth/link/start") {
      if (!app.wallet?.authorizeUrl) return sendJson(res, 404, { error: "payments not configured" });
      return sendJson(res, 200, { url: app.wallet.authorizeUrl().url });
    }
    if (method === "GET" && path === "/payments/status") {
      if (!app.wallet) return sendJson(res, 404, { error: "payments not configured" });
      return sendJson(res, 200, { connected: app.wallet.isConnected() });
    }

    if (method === "POST" && path === "/chat") {
      const raw = await readBody(req, limit);
      if (raw === undefined) return sendJson(res, 413, { error: "body too large" });
      const body = parseJson(raw);
      if (!body || typeof (body as ChatRequest).message !== "string") {
        return sendJson(res, 400, { error: "expected JSON { message: string, source?, conversation_id? }" });
      }
      try {
        const out = await handleChat(app, body as ChatRequest, now());
        return sendJson(res, 200, out);
      } catch (err) {
        log(`chat failed: ${(err as Error).message}`);
        return sendJson(res, 500, { error: "agent error", response: "" });
      }
    }

    sendJson(res, 404, { error: "not found" });
  }

  /**
   * The public proof verifier. A browser gets a page; everything else gets the same facts
   * as JSON. An id that was never anchored answers `valid: false` rather than an error:
   * "I do not know this proof" is a result, not a failure.
   */
  async function verifyProof(path: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const attestationId = (VERIFY_PATH.exec(path)?.[1] ?? "").toLowerCase();
    if (!app.midnightVerify) {
      return sendJson(res, 503, { error: "this agent has no Midnight layer configured, so it has no proofs to verify" });
    }
    let result: VerifyResult;
    try {
      result = await app.midnightVerify(attestationId);
    } catch (err) {
      log(`verify failed: ${(err as Error).message}`);
      return sendJson(res, 502, { error: "could not reach the ledger", detail: (err as Error).message });
    }
    if ((req.headers.accept ?? "").includes("text/html")) {
      return sendHtml(res, result.valid ? 200 : 404, verifyPage({ attestationId, result, agentName: app.config.agent.name, ownerName: app.config.owner.name }));
    }
    return sendJson(res, result.valid ? 200 : 404, result);
  }

  /**
   * The verifier's front door. `?id=<64 hex>` is a hand-off, so a reply or a slide can
   * carry a pre-filled link; anything else prefills with this agent's newest attestation,
   * which is always a proof a reader can actually check.
   */
  async function verifyIndex(url: URL, res: http.ServerResponse): Promise<void> {
    const raw = (url.searchParams.get("id") ?? "").trim();
    if (raw) {
      const id = raw.replace(/^0x/i, "").toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(id)) {
        return sendHtml(res, 400, verifyIndexPage({ agentName: app.config.agent.name, ownerName: app.config.owner.name, prefill: raw, error: "That is not an attestation id. It is 64 hexadecimal characters, exactly as the agent sent it." }));
      }
      res.writeHead(302, { location: `${VERIFY_INDEX_PATH}/${id}`, "cache-control": "no-store" });
      res.end();
      return;
    }
    const status = app.midnightStatus?.();
    return sendHtml(res, 200, verifyIndexPage({
      agentName: app.config.agent.name,
      ownerName: app.config.owner.name,
      prefill: status?.latestAttestation ?? "",
      ...(status?.latestAttestation ? {} : { error: "No proof has been issued on this agent yet. Ask it to remember something and prove it, then paste the id it replies with." }),
    }));
  }

  async function linkCallback(url: URL, res: http.ServerResponse): Promise<void> {
    if (!app.wallet) return sendHtml(res, 404, linkPage("Payments are not configured on this agent."));
    const code = url.searchParams.get("code") ?? "";
    const state = url.searchParams.get("state") ?? "";
    const error = url.searchParams.get("error");
    if (error) return sendHtml(res, 400, linkPage(`Link reported an error: ${error}. You can close this page and try again from chat.`));
    if (!code || !state) return sendHtml(res, 400, linkPage("The callback is missing its code or state. Start again from chat."));
    try {
      await app.wallet.handleCallback(code, state);
    } catch (err) {
      log(`link callback failed: ${(err as Error).message}`);
      return sendHtml(res, 400, linkPage("Link could not be connected. Start again from chat."));
    }
    return sendHtml(res, 200, linkPage("Connected. Your agent can now pay with Link. You can close this page."));
  }

  server.on("clientError", (_err, socket) => {
    try {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    } catch {
      /* socket already gone */
    }
  });
  server.on("listening", () => inbox?.queue.start());
  server.on("close", () => {
    if (inbox && --inbox.listeners === 0) {
      void closeInkboxInbox(app);
    }
  });

  return server;
}

/**
 * The listener the Inkbox tunnel forwards to: loopback only, webhook routes only.
 * Returns the server once it listens; `address().port` is what the tunnel targets.
 */
export async function listenTunnelServer(app: HttpApp, opts: HttpServerOptions = {}): Promise<http.Server> {
  const server = createHttpServer(app, { ...opts, tunnelOnly: true });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  return server;
}

/** Read the body up to `limit` bytes; undefined when it is too large. */
export function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(tooLarge ? undefined : Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseJson(raw: Buffer): unknown | undefined {
  try {
    return JSON.parse(raw.toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function sendHtml(res: http.ServerResponse, status: number, html: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(html), "cache-control": "no-store" });
  res.end(html);
}

/** A small page for the Link redirect. No scripts, no external assets, text escaped. */
export function linkPage(message: string): string {
  const safe = message.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
  return (
    "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
    "<title>Open Instinct</title><style>body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:48px 16px;color:#111;background:#fff}" +
    "main{max-width:420px;margin:0 auto}h1{font-size:20px;margin:0 0 12px}</style></head>" +
    `<body><main><h1>Link</h1><p>${safe}</p></main></body></html>`
  );
}

/**
 * The verifier's front door: one text box, no scripts, no external assets. It is also the
 * page a pre-filled link lands on before it hands the id to `/verify/<id>`.
 */
export function verifyIndexPage(input: { agentName: string; ownerName: string; prefill: string; error?: string }): string {
  const escape = (text: string): string => text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
  return (
    "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
    `<title>${escape(input.agentName)} proof verifier</title>` +
    "<style>body{font:16px/1.55 system-ui,sans-serif;margin:0;padding:40px 16px;color:#111;background:#fafafa}" +
    "main{max-width:560px;margin:0 auto;background:#fff;border:1px solid #e5e5e5;border-radius:12px;padding:28px}" +
    "h1{font-size:20px;margin:0 0 4px}label{display:block;margin:18px 0 6px;font-weight:600}" +
    "input{width:100%;box-sizing:border-box;font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;padding:10px;border:1px solid #ccc;border-radius:8px}" +
    "button{margin-top:14px;font:inherit;font-weight:600;padding:10px 18px;border:0;border-radius:8px;background:#111;color:#fff;cursor:pointer}" +
    "p{color:#333}.note{color:#666;font-size:14px}.bad{color:#7a1c14;font-weight:600}footer{color:#888;font-size:13px;margin-top:22px}</style></head>" +
    "<body><main>" +
    `<h1>${escape(input.agentName)} proof verifier</h1>` +
    `<div class="note">Hosted by ${escape(input.ownerName)}'s agent, built on Open Instinct with Midnight. Read-only: it checks a proof, it never writes.</div>` +
    (input.error ? `<p class="bad">${escape(input.error)}</p>` : "") +
    "<form method=\"get\" action=\"/verify\">" +
    "<label for=\"id\">Attestation id</label>" +
    `<input id="id" name="id" value="${escape(input.prefill)}" placeholder="64 hexadecimal characters" autocomplete="off" spellcheck="false">` +
    "<button type=\"submit\">Check this proof</button>" +
    "</form>" +
    "<p class=\"note\">A proof reveals only what its prover chose to disclose: whether a memory exists, and at most one category. The memory's text never leaves the agent's host.</p>" +
    "<footer>docs/MIDNIGHT.md in the repository explains the commitment scheme, the circuit and this verifier.</footer>" +
    "</main></body></html>"
  );
}

/**
 * The page a judge opens from a chat reply. Everything a proof reveals and nothing else:
 * whether the attestation is recorded, which single category it disclosed, and that it is
 * single-use. No scripts, no external assets, every value escaped.
 */
export function verifyPage(input: { attestationId: string; result: VerifyResult; agentName: string; ownerName: string }): string {
  const { attestationId, result } = input;
  const escape = (text: string): string => text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
  const reveals = result.disclosed === 0 ? "Only that a memory exists. No category, no text." : `One category: ${result.disclosedLabel}`;
  const mode =
    result.mode === "mock"
      ? "mock: this agent anchors locally, so the commitment is a real hash but no transaction was submitted for it."
      : `${result.mode}: the commitment and the proof are transactions on the Midnight chain.`;
  const rows: Array<[string, string]> = [
    ["Reveals", escape(reveals)],
    ["Single use", result.valid ? "yes, this id cannot be proved again" : "n/a"],
    ["Mode", escape(mode)],
  ];
  if (result.contractAddress) rows.push(["Contract", `<code>${escape(result.contractAddress)}</code>`]);
  const explain = result.valid
    ? "The memory's text never left the agent's host. This page asked the ledger whether this attestation is recorded, and read back only what it disclosed."
    : "This id is not on the ledger. Either it was never anchored, it belongs to another deployment, or it was mistyped. Ask the agent for a fresh proof and use the id exactly as it sent it.";
  return (
    "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
    `<title>${escape(input.agentName)} proof verifier</title>` +
    "<style>body{font:16px/1.55 system-ui,sans-serif;margin:0;padding:40px 16px;color:#111;background:#fafafa}" +
    "main{max-width:560px;margin:0 auto;background:#fff;border:1px solid #e5e5e5;border-radius:12px;padding:28px}" +
    "h1{font-size:20px;margin:0 0 4px}.status{font-size:15px;font-weight:600;margin:16px 0 20px;padding:12px 14px;border-radius:8px}" +
    ".ok{background:#eefbf1;color:#12622c;border:1px solid #b7e4c4}.bad{background:#fdf0ef;color:#7a1c14;border:1px solid #f0c2bd}" +
    "dl{display:grid;grid-template-columns:120px 1fr;gap:8px 16px;margin:0 0 18px}dt{color:#666}dd{margin:0}" +
    "p{color:#333}code{font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}" +
    "footer{color:#888;font-size:13px;margin-top:22px}</style></head><body><main>" +
    `<h1>${escape(input.agentName)} proof verifier</h1>` +
    `<div>Hosted by ${escape(input.ownerName)}'s agent, built on Open Instinct with Midnight.</div>` +
    `<p class="status ${result.valid ? "ok" : "bad"}">${result.valid ? "Proof verified" : "No proof found for this id"}</p>` +
    "<dl>" +
    rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("") +
    `<dt>Attestation</dt><dd><code>${escape(attestationId)}</code></dd>` +
    "</dl>" +
    `<p>${escape(explain)}</p>` +
    (result.verifyUrl ? `<p><a href="${escape(result.verifyUrl)}">Open the same check on the proof server</a></p>` : "") +
    "<footer>docs/MIDNIGHT.md in the repository explains the commitment scheme, the circuit and this verifier.</footer>" +
    "</main></body></html>"
  );
}
