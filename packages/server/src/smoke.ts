/**
 * End-to-end smoke test with Pi's faux provider: no network, no API keys.
 * Boots a real agent into a temp data dir, drives it over HTTP and checks the
 * owner flow, the stranger flow, the schedule flow, a stranger's A2A task and a
 * public demo agent's guest flow. Exits non-zero on failure.
 */
import { mkdtempSync, readFileSync, realpathSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { AuditLog, ContactStore, encodeEvent, resolvePrincipal } from "@open-instinct/core";
import type { InboundMessage, OutboundMessage, Outbox, Principal } from "@open-instinct/core";
import { encodeOip } from "@open-instinct/network";
import { boot } from "./boot.js";
import { closeInkboxInbox, createHttpServer, listenTunnelServer } from "./http.js";

const OWNER_PHONE = "+15550001111";
const STRANGER_PHONE = "+15559998888";
/** A number no contact and no owner row knows: on a demo agent this is a guest. */
const GUEST_PHONE = "+15559998777";
const STRANGER_AGENT = "unknown-agent";
const A2A_TASK = "task_smoke_1";
const A2A_CONTEXT = "ctx_smoke_1";

class RecordingOutbox implements Outbox {
  sent: Array<{ msg: OutboundMessage; conversationKey: string; principal: Principal }> = [];
  async send(msg: OutboundMessage, ctx: { principal: Principal; conversationKey: string }): Promise<void> {
    this.sent.push({ msg, conversationKey: msg.conversationKey ?? ctx.conversationKey, principal: ctx.principal });
  }
  async typing(): Promise<void> {}
}

const failures: string[] = [];
function check(cond: unknown, what: string): void {
  if (cond) console.log(`  ok   ${what}`);
  else {
    console.log(`  FAIL ${what}`);
    failures.push(what);
  }
}

async function main(): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "instinct-smoke-"));
  const env: NodeJS.ProcessEnv = {
    INSTINCT_DATA_DIR: dataDir,
    INSTINCT_OWNER_NAME: "Smoke Owner",
    INSTINCT_OWNER_PHONE: OWNER_PHONE,
    INSTINCT_OWNER_EMAIL: "owner@example.com",
    INSTINCT_OWNER_TIMEZONE: "America/New_York",
    INSTINCT_AGENT_NAME: "Smoke",
    INSTINCT_MODEL: "faux/faux-1",
    INSTINCT_COMPUTER: "none",
    INSTINCT_SKILLS_DIR: join(dataDir, "no-skills"),
  };

  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const streamFn = models.streamSimple.bind(models) as unknown as StreamFn;
  const outbox = new RecordingOutbox();
  const quiet = (): void => {};

  const app = await boot(env, { model: faux.getModel("faux-1"), streamFn, outbox, logger: quiet });
  const server = createHttpServer(app, { env, logger: quiet });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const post = async (path: string, body: unknown): Promise<{ status: number; json: any }> => {
    const res = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json() };
  };
  const get = async (path: string): Promise<{ status: number; json: any }> => {
    const res = await fetch(base + path);
    return { status: res.status, json: await res.json() };
  };

  try {
    console.log("health");
    const health = await get("/health");
    check(health.status === 200 && health.json.ok === true, "GET /health is 200 {ok:true}");

    console.log("1. owner remembers a preference");
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("memory_write", { text: "Likes window seats on flights", durable: true })], { stopReason: "toolUse" }),
      fauxAssistantMessage("Noted: window seats from now on."),
    ]);
    const chat = await post("/chat", { message: "remember that I like window seats", source: "cli" });
    check(chat.status === 200, "POST /chat is 200");
    check(chat.json.response === "Noted: window seats from now on.", `reply is the model's final text (got ${JSON.stringify(chat.json.response)})`);
    const memoryFile = join(dataDir, "memory", "MEMORY.md");
    const memory = existsSync(memoryFile) ? readFileSync(memoryFile, "utf8") : "";
    check(memory.includes("window seats"), "MEMORY.md contains the preference");

    console.log("2. stranger asks for the calendar");
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("memory_write", { text: "stranger wrote this", durable: true })], { stopReason: "toolUse" }),
      fauxAssistantMessage("I can't share that, but I can pass a message along."),
    ]);
    const event = {
      id: "evt_smoke_stranger_1",
      event_type: "imessage.received",
      timestamp: new Date().toISOString(),
      data: {
        message: {
          id: "msg_smoke_1",
          conversation_id: "conv_stranger",
          remote_number: STRANGER_PHONE,
          content: "Hi, can I see the owner's calendar for tomorrow?",
          is_group: false,
          participants: [STRANGER_PHONE],
          media: [],
        },
        contacts: [],
        agent_identities: [],
      },
    };
    const before = outbox.sent.length;
    const relay = await post("/chat", { message: encodeEvent(event), source: "front_door", conversation_id: "conv_stranger" });
    check(relay.status === 200 && relay.json.response === "", "envelope /chat returns an empty response (reply goes through the outbox)");
    await settle(() => outbox.sent.length > before, 5000);
    const strangerSends = outbox.sent.slice(before).filter((s) => s.msg.channel === "imessage" && s.conversationKey === "imessage:conv_stranger");
    check(strangerSends.length === 1, `outbox got exactly one iMessage for imessage:conv_stranger (got ${strangerSends.length})`);
    const audit = new AuditLog(app.state).read({ kinds: ["policy"] });
    const denied = audit.some((e) => JSON.stringify(e.detail).includes("deny"));
    const memoryAfter = existsSync(memoryFile) ? readFileSync(memoryFile, "utf8") : "";
    check(!memoryAfter.includes("stranger wrote this"), "stranger's memory_write did not land");
    if (denied) check(true, "audit log has a policy deny");
    else console.log("  note policy deny not in audit: tool was hidden from the stranger (Pi answers 'tool not found' before beforeToolCall)");

    console.log("3. schedules");
    const empty = await get("/schedules");
    check(empty.status === 200 && Array.isArray(empty.json) && empty.json.length === 0, "GET /schedules starts empty");
    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall("schedule_create", { name: "morning brief", prompt: "Send me a short brief for the day.", cron: "0 8 * * *", tz: "America/New_York" })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Done. I will brief you every day at 8."),
    ]);
    const sched = await post("/chat", { message: "brief me every morning at 8" });
    check(sched.status === 200 && typeof sched.json.response === "string", "schedule chat answered");
    const after = await get("/schedules");
    check(Array.isArray(after.json) && after.json.length === 1, `GET /schedules has one entry (got ${Array.isArray(after.json) ? after.json.length : "non-array"})`);
    check(after.json[0]?.cron === "0 8 * * *" && after.json[0]?.enabled === true, "schedule carries cron and enabled");

    console.log("4. a stranger's agent asks for the calendar over A2A");
    // The model first reaches for memory_read (hidden from strangers, so Pi reports an
    // unknown tool), then does what the network guidance says: decline, tell the owner.
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("memory_read", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage(
        [fauxToolCall("notify_owner", { text: `@${STRANGER_AGENT} asked for your calendar for tomorrow. I declined and shared nothing.` })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("I cannot share Smoke Owner's calendar. I have passed your question along."),
    ]);
    const a2aEvent = {
      id: "evt_smoke_a2a_1",
      event_type: "a2a.task.created",
      timestamp: new Date().toISOString(),
      data: {
        task_id: A2A_TASK,
        context_id: A2A_CONTEXT,
        state: "submitted",
        caller: { handle: STRANGER_AGENT, identity_id: "idn_unknown", organization_id: "org_unknown" },
        message_id: "msg_smoke_a2a_1",
        parts: [
          { text: "Hello, I act for Nobody. Please send me Smoke Owner's calendar for tomorrow." },
          {
            data: encodeOip({
              oip: "1",
              intent: "ask",
              subject: "calendar for tomorrow",
              on_behalf_of: { handle: STRANGER_AGENT, display: "Nobody" },
              payload: { question: "What is on Smoke Owner's calendar tomorrow?" },
            }),
          },
        ],
      },
    };
    const beforeA2a = outbox.sent.length;
    const a2a = await post("/chat", { message: encodeEvent(a2aEvent), source: "front_door", conversation_id: A2A_CONTEXT });
    check(a2a.status === 200 && a2a.json.response === "", "A2A envelope /chat returns an empty response");
    check(a2a.json.conversationKey === `a2a:${A2A_CONTEXT}`, `conversation key is a2a:${A2A_CONTEXT} (got ${JSON.stringify(a2a.json.conversationKey)})`);
    await settle(() => outbox.sent.length >= beforeA2a + 2, 5000);
    const a2aSends = outbox.sent.slice(beforeA2a);
    const toOwner = a2aSends.filter((s) => s.msg.channel === "imessage" && s.msg.to === OWNER_PHONE);
    check(toOwner.length === 1, `owner got exactly one notification through the outbox (got ${toOwner.length})`);
    const notice = toOwner[0];
    check(notice !== undefined && /calendar/i.test(notice.msg.text) && /declined/i.test(notice.msg.text), "the notification names the calendar ask and the refusal");
    check(notice?.principal.kind === "stranger" && notice.principal.agentHandle === STRANGER_AGENT, `the notification was sent on behalf of the stranger agent (got ${notice?.principal.id})`);
    check(notice !== undefined && notice.msg.text.startsWith(`${STRANGER_AGENT} via Smoke:`), "the notification is prefixed with who asked");
    const replies = a2aSends.filter((s) => s.msg.channel === "a2a" && s.conversationKey === `a2a:${A2A_CONTEXT}`);
    check(replies.length === 1, `exactly one A2A reply went back on the task (got ${replies.length})`);
    const reply = replies[0]?.msg;
    check(reply?.a2a?.taskId === A2A_TASK && reply.a2a.intent === "complete", `the reply completes task ${A2A_TASK} (got ${JSON.stringify(reply?.a2a)})`);
    check(reply?.replyRef?.taskId === A2A_TASK && reply.replyRef.contextId === A2A_CONTEXT, "the reply carries the inbound replyRef");
    check(reply !== undefined && /cannot share/i.test(reply.text), "the reply declines in words");
    check(a2aSends.length === 2, `nothing else left the process for this task (got ${a2aSends.length} sends)`);
    check(!a2aSends.some((s) => s.msg.text.includes("window seats")), "the owner's memory did not leak to the stranger or the notice");
    const taskKey = `a2a:${A2A_CONTEXT}:task:${A2A_TASK}:message:${a2aEvent.data.message_id}`;
    const a2aAudit = new AuditLog(app.state).read().filter((e) => e.conversationKey === `a2a:${A2A_CONTEXT}` || e.conversationKey === taskKey);
    const inboundEntry = a2aAudit.find((e) => e.kind === "inbound");
    check(inboundEntry?.principal === `stranger:a2a:${STRANGER_AGENT}`, `the caller resolved to a stranger (got ${inboundEntry?.principal})`);
    const allowed = a2aAudit.filter((e) => e.kind === "policy" && (e.detail as { outcome?: string }).outcome === "allow").map((e) => (e.detail as { tool?: string }).tool);
    check(allowed.length === 1 && allowed[0] === "notify_owner", `policy allowed only notify_owner for the stranger (got ${JSON.stringify(allowed)})`);
    const calls = a2aAudit.filter((e) => e.kind === "tool_call").map((e) => (e.detail as { tool?: string }).tool);
    check(!calls.includes("memory_read"), "memory_read never executed for the stranger");

    console.log("5. owner asks for a PDF");
    // No Inkbox here, so send_file runs in chat-only mode: it hands the dashboard a
    // maritime-file block instead of sending over a wire.
    const pdfRelative = "briefs/smoke.pdf";
    const pdfAbsolute = join(realpathSync(dataDir), "workspace", pdfRelative);
    const fence = "```maritime-file\n" + JSON.stringify({ path: pdfAbsolute, name: "smoke.pdf", mime: "application/pdf" }) + "\n```";
    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall("create_pdf", { path: pdfRelative, title: "Smoke brief", markdown: "# Smoke brief\n\nOne paragraph.\n\n- first point\n- second point\n\n| a | b |\n|---|---|\n| 1 | 2 |" })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxToolCall("send_file", { path: pdfRelative, caption: "Here is the brief as a PDF." })], { stopReason: "toolUse" }),
      fauxAssistantMessage(`Here is the brief as a PDF.\n${fence}`),
    ]);
    const pdfChat = await post("/chat", { message: "send me that as a PDF", source: "cli" });
    check(pdfChat.status === 200, "PDF chat is 200");
    check(existsSync(pdfAbsolute) && readFileSync(pdfAbsolute).subarray(0, 5).toString() === "%PDF-", `a real PDF exists at workspace/${pdfRelative}`);
    const pdfAudit = new AuditLog(app.state).read({ kinds: ["tool_call"] }).filter((e) => e.conversationKey === "chat:default");
    const pdfCalls = pdfAudit.map((e) => e.detail as { tool?: string; isError?: boolean; result?: string });
    const created = pdfCalls.find((c) => c.tool === "create_pdf");
    const sent = pdfCalls.find((c) => c.tool === "send_file");
    check(created !== undefined && created.isError === false && /Wrote .*smoke\.pdf .*1 page/.test(created.result ?? ""), `create_pdf wrote the file and reported one page (got ${JSON.stringify(created?.result)})`);
    check(sent !== undefined && sent.isError === false && (sent.result ?? "").includes(pdfAbsolute), `send_file answered with the file's path (got ${JSON.stringify(sent?.result)})`);
    check(typeof pdfChat.json.response === "string" && (pdfChat.json.response.includes("```maritime-file") || pdfChat.json.response.includes(pdfAbsolute)), "the reply carries the maritime-file block or the path");

    console.log("6. a public demo agent treats an unknown number as a guest");
    // INSTINCT_AGENT_PUBLIC marks an agent that answers anyone. The same unknown sender
    // who was turned away in step 2 now gets a conversation and the vault in their own
    // scope, while the owner's notebook, profile and contacts stay out of reach.
    const guestDir = mkdtempSync(join(tmpdir(), "instinct-smoke-guest-"));
    const guestEnv: NodeJS.ProcessEnv = { ...env, INSTINCT_DATA_DIR: guestDir, INSTINCT_AGENT_NAME: "Seal Demo", INSTINCT_AGENT_PUBLIC: "1", MIDNIGHT_MODE: "mock" };
    const guestOutbox = new RecordingOutbox();
    const guest = await boot(guestEnv, { model: faux.getModel("faux-1"), streamFn, outbox: guestOutbox, logger: quiet });
    const guestServer = createHttpServer(guest, { env: guestEnv, logger: quiet });
    await new Promise<void>((resolve) => guestServer.listen(0, "127.0.0.1", () => resolve()));
    const guestBase = `http://127.0.0.1:${(guestServer.address() as AddressInfo).port}`;
    try {
      check(guest.config.agent.public === true, "the flag reaches config.json");
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("vault_commit", { text: "guest likes the demo", category: "preference" })], { stopReason: "toolUse" }),
        fauxAssistantMessage("Anchored. Ask me to prove it whenever you like."),
      ]);
      const guestEvent = {
        ...event,
        id: "evt_smoke_guest_1",
        data: {
          ...event.data,
          message: { ...event.data.message, id: "msg_smoke_guest_1", conversation_id: "conv_guest", remote_number: GUEST_PHONE, content: "Hi. Can you remember something for me?" },
        },
      };
      const beforeGuest = guestOutbox.sent.length;
      const guestRes = await fetch(`${guestBase}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: encodeEvent(guestEvent), source: "front_door", conversation_id: "conv_guest" }),
      });
      check(guestRes.status === 200, `the guest's envelope is accepted (got ${guestRes.status})`);
      await settle(() => guestOutbox.sent.length > beforeGuest, 5000);
      const guestSends = guestOutbox.sent.slice(beforeGuest).filter((s) => s.msg.channel === "imessage" && s.conversationKey === "imessage:conv_guest");
      check(guestSends.length === 1, `the guest got exactly one iMessage reply (got ${guestSends.length})`);
      const guestMemoryFile = join(guestDir, "memory", "MEMORY.md");
      const guestMemory = existsSync(guestMemoryFile) ? readFileSync(guestMemoryFile, "utf8") : "";
      check(!guestMemory.includes("guest likes the demo"), "the guest's note stayed out of the owner's notebook");
      const guestCalls = new AuditLog(guest.state)
        .read({ kinds: ["tool_call"] })
        .filter((e) => e.conversationKey === "imessage:conv_guest")
        .map((e) => e.detail as { tool?: string; isError?: boolean; result?: string });
      const anchored = guestCalls.find((c) => c.tool === "vault_commit");
      check(
        anchored !== undefined && anchored.isError === false && /Anchored for this conversation/.test(anchored.result ?? ""),
        `vault_commit anchored the guest's note in the guest's own scope (got ${JSON.stringify(anchored)})`,
      );
      const midnightFile = join(guestDir, "midnight.json");
      const midnightState = existsSync(midnightFile) ? (JSON.parse(readFileSync(midnightFile, "utf8")) as { commitments?: Record<string, { scope?: string }> }) : {};
      const commitments = Object.values(midnightState.commitments ?? {});
      check(commitments.length === 1 && Boolean(commitments[0]?.scope), `one scoped commitment is on record (got ${JSON.stringify(commitments)})`);

      // The guest asks for a proof, then anyone checks it over the public tunnel surface.
      const commitment = Object.keys(midnightState.commitments ?? {})[0] ?? "";
      check(/^[0-9a-f]{64}$/.test(commitment), `the commitment is 64 hex (got ${commitment})`);
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("vault_prove_reveal", { commitment, disclose: "existence" })], { stopReason: "toolUse" }),
        fauxAssistantMessage("Proved. Here is the whole attestation id."),
      ]);
      const proofEvent = {
        ...event,
        id: "evt_smoke_guest_2",
        data: {
          ...event.data,
          message: { ...event.data.message, id: "msg_smoke_guest_2", conversation_id: "conv_guest", remote_number: GUEST_PHONE, content: "Prove you remembered, without telling me what it says." },
        },
      };
      const beforeProof = guestOutbox.sent.length;
      const proofRes = await fetch(`${guestBase}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: encodeEvent(proofEvent), source: "front_door", conversation_id: "conv_guest" }),
      });
      check(proofRes.status === 200, `the guest's second envelope is accepted (got ${proofRes.status})`);
      await settle(() => guestOutbox.sent.length > beforeProof, 5000);
      const midnightAfter = JSON.parse(readFileSync(midnightFile, "utf8")) as { nullifiers?: Record<string, { disclosed?: number }> };
      const attestationId = Object.keys(midnightAfter.nullifiers ?? {})[0] ?? "";
      check(/^[0-9a-f]{64}$/.test(attestationId), `the proof left a single-use attestation id (got ${attestationId})`);
      check(Object.values(midnightAfter.nullifiers ?? {})[0]?.disclosed === 0, "the attestation discloses bare existence and no category");

      // The Inkbox tunnel reaches a second, loopback-only listener. The verifier is the
      // one read-only route on it besides /health and the webhook.
      const tunnel = await listenTunnelServer(guest, { signingKey: "smoke-signing-key", env: guestEnv, logger: quiet });
      const tunnelBase = `http://127.0.0.1:${(tunnel.address() as AddressInfo).port}`;
      try {
        const verified = await fetch(`${tunnelBase}/verify/${attestationId}`);
        const verifiedJson = (await verified.json()) as { valid?: boolean; disclosed?: number; singleUse?: boolean; mode?: string };
        check(verified.status === 200, `the public verifier answers 200 for the id (got ${verified.status})`);
        check(verifiedJson.valid === true && verifiedJson.disclosed === 0 && verifiedJson.singleUse === true, `the verifier reports a valid, single-use, bare-existence proof (got ${JSON.stringify(verifiedJson)})`);
        check(verifiedJson.mode === "mock", `the verifier reports the mode honestly (got ${verifiedJson.mode})`);
        const page = await fetch(`${tunnelBase}/verify/${attestationId}`, { headers: { accept: "text/html" } });
        const html = await page.text();
        check(page.status === 200 && html.includes("Proof verified") && html.includes(attestationId), "a browser gets a readable verification page");
        check((await fetch(`${tunnelBase}/status`)).status === 404, "the tunnel still hides the owner's surface");
        check((await fetch(`${tunnelBase}/verify/${"a".repeat(64)}`)).status === 404, "an unknown id is reported as no proof, not as an error");
      } finally {
        await new Promise<void>((resolve) => tunnel.close(() => resolve()));
      }
      const guestPrincipal = resolvePrincipal(
        { id: "msg_smoke_guest_1", conversationKey: "imessage:conv_guest", text: "hi", from: GUEST_PHONE, channel: "imessage", replyRef: {}, receivedAt: new Date().toISOString() } as InboundMessage,
        guest.config,
        new ContactStore(guest.state),
      );
      const prompt = guest.runtime.conversation("imessage:conv_guest", guestPrincipal).agent.state.systemPrompt;
      check(prompt.includes("a public demo agent built on Open Instinct"), "the guest prompt says this is a public demo agent");
      check(prompt.includes("is trying you out"), "the guest prompt describes the sender as a guest");
      check(!prompt.includes("Do not run tasks for them"), "the guest prompt does not turn the sender away");
      check(prompt.includes("Share nothing about Smoke Owner"), "the guest prompt still closes the owner's world");
      check(!prompt.includes(OWNER_PHONE), "the guest prompt carries no owner contact details");
      check(prompt.includes("vault.write"), "the guest's capabilities include the vault");
      check(!prompt.includes("memory.write"), "the guest's capabilities exclude the owner's notebook");
    } finally {
      await new Promise<void>((resolve) => guestServer.close(() => resolve()));
      await closeInkboxInbox(guest);
      await guest.close();
      rmSync(guestDir, { recursive: true, force: true });
    }

    console.log("status");
    const status = await get("/");
    check(status.json.agent === "Smoke" && status.json.model === "faux/faux-1", "status page names the agent and model");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeInkboxInbox(app);
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    console.log(`\n${failures.length} check(s) failed`);
    process.exit(1);
  }
  console.log("\nsmoke passed");
  process.exit(0);
}

async function settle(done: () => boolean, timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!done() && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
}

main().catch((err: Error) => {
  console.error(`smoke crashed: ${err.stack ?? err.message}`);
  process.exit(1);
});
