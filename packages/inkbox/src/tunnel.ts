/**
 * Drive an Inkbox tunnel listener.
 *
 * `connect()` only *builds* the listener: the data plane is dialled by
 * `serveForever()`, which reconnects with backoff until the listener is closed.
 * A listener that is never driven still reports a public URL, so the failure is
 * silent — the tunnel looks up, Inkbox logs the delivery, and nothing arrives.
 * Every place that opens a tunnel has to drive it.
 *
 * A permanent runtime failure (a rotated or mismatched secret) must not take the
 * host down with it: the agent keeps serving its owner surface, and the caller
 * decides how to report that the messaging channel is gone.
 */
import http from "node:http";

export interface DrivenTunnel {
  serveForever(): Promise<void>;
}

export interface TunnelRequestContext {
  signal?: AbortSignal;
}

export type TunnelFetchHandler = (
  request: Request,
  context?: TunnelRequestContext,
) => Promise<Response>;

/**
 * Build an in-process Fetch handler that proxies tunnel traffic to a loopback
 * HTTP server.
 *
 * This is the alternative to the SDK's `forwardTo` URL forwarding, which
 * proxies through `fetch`. On the deployed agent that path fails for every
 * webhook: Inkbox forwards a `content-length` header alongside a materialized
 * body, and undici rejects the combination with
 * `UND_ERR_INVALID_ARG: invalid content-length header`. The delivery then dies
 * as a 502 and the agent never sees the message. Driving the hop with
 * `node:http` sidesteps it, and the handler path is the same shape the runtime
 * already supports for in-process servers.
 *
 * Headers are copied explicitly rather than replayed: `content-length` and the
 * other framing headers are dropped so the HTTP client sets them from the body
 * it is actually about to write, and hop-by-hop headers are not carried across
 * the hop. The inbound body is already materialized and size-capped by the
 * runtime, so it is forwarded as-is and byte-for-byte — the webhook signature
 * is computed over those exact bytes.
 */
export function loopbackForwardHandler(port: number, host = "127.0.0.1"): TunnelFetchHandler {
  return async (request, context) => {
    const url = new URL(request.url);
    const headers: http.OutgoingHttpHeaders = {};
    request.headers.forEach((value, name) => {
      if (!DROP_REQUEST_HEADERS.has(name.toLowerCase())) headers[name] = value;
    });
    headers.host = `${host}:${port}`;

    const withBody = request.method !== "GET" && request.method !== "HEAD";
    const body = withBody ? Buffer.from(await request.arrayBuffer()) : undefined;

    return await new Promise<Response>((resolve, reject) => {
      const upstream = http.request(
        {
          host,
          port,
          method: request.method,
          path: `${url.pathname}${url.search}`,
          headers,
          ...(context?.signal ? { signal: context.signal } : {}),
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("error", reject);
          response.on("end", () => {
            const status = response.statusCode ?? 502;
            const outHeaders = new Headers();
            for (const [name, value] of Object.entries(response.headers)) {
              if (value === undefined || DROP_RESPONSE_HEADERS.has(name.toLowerCase())) continue;
              for (const one of Array.isArray(value) ? value : [value]) outHeaders.append(name, one);
            }
            // 204/205/304 must not carry a body, and fetch throws if they do.
            const bodyless = status === 204 || status === 205 || status === 304;
            resolve(new Response(bodyless ? null : Buffer.concat(chunks), { status, headers: outHeaders }));
          });
        },
      );
      upstream.on("error", reject);
      if (body !== undefined) upstream.write(body);
      upstream.end();
    });
  };
}

/** Framing and hop-by-hop headers the HTTP client owns on the way out. */
const DROP_REQUEST_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "host",
]);

/** Framing and hop-by-hop headers the runtime owns on the way back. */
const DROP_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
]);

export function driveTunnel(listener: DrivenTunnel, onError?: (message: string) => void): void {
  void listener.serveForever().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    onError?.(message);
  });
}
