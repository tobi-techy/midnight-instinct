import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { StateDir } from "@open-instinct/core";
import type { InstinctConfig } from "@open-instinct/core";
import { createHttpServer, type HttpApp } from "../src/http.js";
import { ChatReplyBuffer } from "../src/console-outbox.js";

const config: InstinctConfig = {
  version: 1,
  owner: { name: "Maria", phones: ["+15550001111"], emails: [], timezone: "America/New_York" },
  agent: { name: "Smoke", handle: "smoke-instinct" },
  model: { primary: "faux/faux-1" },
  computer: { mode: "none" },
  apps: { enabled: false, toolkits: [] },
  features: { typingIndicators: true, tapbacks: true, journal: true },
};

function app(midnight?: HttpApp["midnight"]): HttpApp {
  const buffer = new ChatReplyBuffer();
  return {
    state: new StateDir(mkdtempSync(join(tmpdir(), "server-midnight-"))),
    chatBuffer: buffer,
    runtime: { handleInbound: async (msg) => ({ acked: true, reply: "", principal: { kind: "owner", id: "owner", tier: "owner", displayName: "Maria" }, conversationKey: msg.conversationKey }), stats: () => ({ conversations: 0, busy: 0 }) },
    scheduler: { toMaritimeSchedules: () => [] },
    config,
    appsConnected: [],
    startedAt: Date.now(),
    modelSpec: "faux/faux-1",
    ...(midnight ? { midnight } : {}),
  };
}

const servers: Array<{ close: (cb: () => void) => void }> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

async function serve(a: HttpApp): Promise<string> {
  const server = createHttpServer(a, { env: {}, logger: () => {} });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("GET /midnight/status", () => {
  it("404s when the Midnight layer is not configured", async () => {
    const base = await serve(app());
    const res = await fetch(`${base}/midnight/status`);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/midnight not configured/);
  });

  it("returns mode, contract and anchor counts when configured", async () => {
    const base = await serve(
      app({ mode: "testnet", contractAddress: "0xabc", commitments: 3, attestations: 1, allowances: 0 }),
    );
    const res = await fetch(`${base}/midnight/status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mode).toBe("testnet");
    expect(body.contractAddress).toBe("0xabc");
    expect(body.commitments).toBe(3);
    expect(body.attestations).toBe(1);
  });

  it("surfaces the Midnight block on the status page", async () => {
    const base = await serve(app({ mode: "mock", commitments: 2, attestations: 0, allowances: 0 }));
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect((await res.json()).midnight).toMatchObject({ mode: "mock", commitments: 2 });
  });
});
