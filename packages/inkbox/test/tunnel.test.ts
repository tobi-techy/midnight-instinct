import http from "node:http";
import { describe, expect, it, vi } from "vitest";
import { driveTunnel, loopbackForwardHandler } from "../src/tunnel.js";

/** Let a rejected promise's `.catch` handler run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("driveTunnel", () => {
  it("drives the listener runtime exactly once", async () => {
    const serveForever = vi.fn(async () => undefined);
    driveTunnel({ serveForever });
    await settle();
    expect(serveForever).toHaveBeenCalledTimes(1);
  });

  it("does not reject the host when the runtime fails permanently", async () => {
    const serveForever = vi.fn(async () => {
      throw new Error("secret rotated");
    });
    expect(() => driveTunnel({ serveForever })).not.toThrow();
    await settle();
    expect(serveForever).toHaveBeenCalledTimes(1);
  });

  it("reports a fatal runtime error to the caller", async () => {
    const serveForever = vi.fn(async () => {
      throw new Error("secret rotated");
    });
    const onError = vi.fn();
    driveTunnel({ serveForever }, onError);
    await settle();
    expect(onError).toHaveBeenCalledWith("secret rotated");
  });

  it("reports a non-Error rejection without throwing", async () => {
    const serveForever = vi.fn(async () => {
      throw "socket closed";
    });
    const onError = vi.fn();
    driveTunnel({ serveForever }, onError);
    await settle();
    expect(onError).toHaveBeenCalledWith("socket closed");
  });
});

/** A loopback listener standing in for the agent's webhook-only server. */
async function serve(listener: http.RequestListener): Promise<{ port: number; close(): Promise<void> }> {
  const server = http.createServer(listener);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return { port: address.port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

describe("loopbackForwardHandler", () => {
  it("forwards the method, path, query, body and headers of a signed webhook POST", async () => {
    const seen: { method?: string; url?: string; body?: string; headers?: http.IncomingHttpHeaders } = {};
    const target = await serve((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        seen.method = req.method;
        seen.url = req.url;
        seen.body = Buffer.concat(chunks).toString("utf8");
        seen.headers = req.headers;
        res.writeHead(204);
        res.end();
      });
    });
    try {
      const body = '{"hello":1}';
      const handler = loopbackForwardHandler(target.port);
      const response = await handler(
        new Request("https://sealai.inkboxwire.com/webhooks/inkbox?delivery=1", {
          method: "POST",
          // Inkbox forwards the framing headers it received; they must not
          // survive the hop, and the body must arrive byte-for-byte.
          headers: { "content-type": "application/json", "content-length": String(body.length), "x-inkbox-request-id": "r" },
          body,
        }),
      );
      expect(response.status).toBe(204);
      expect(seen.method).toBe("POST");
      expect(seen.url).toBe("/webhooks/inkbox?delivery=1");
      expect(seen.body).toBe(body);
      expect(seen.headers?.["x-inkbox-request-id"]).toBe("r");
      expect(seen.headers?.["content-type"]).toBe("application/json");
      expect(seen.headers?.host).toBe(`127.0.0.1:${target.port}`);
    } finally {
      await target.close();
    }
  });

  it("returns a body-less response for 204 so the runtime can replay it", async () => {
    const target = await serve((_req, res) => {
      res.writeHead(204, { "content-length": "7" });
      res.end();
    });
    try {
      const response = await loopbackForwardHandler(target.port)(new Request("http://agent.example.com/health"));
      expect(response.status).toBe(204);
      expect(await response.text()).toBe("");
    } finally {
      await target.close();
    }
  });

  it("passes a response body and headers back, minus the framing headers", async () => {
    const target = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "application/json", connection: "keep-alive" });
      res.end('{"ok":true}');
    });
    try {
      const response = await loopbackForwardHandler(target.port)(new Request("http://agent.example.com/health"));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/json");
      expect(await response.json()).toEqual({ ok: true });
    } finally {
      await target.close();
    }
  });

  it("rejects when the loopback listener is gone", async () => {
    const target = await serve((_req, res) => res.end("ok"));
    const port = target.port;
    await target.close();
    await expect(loopbackForwardHandler(port)(new Request("http://agent.example.com/health"))).rejects.toThrow();
  });
});
