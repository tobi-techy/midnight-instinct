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
export interface DrivenTunnel {
  serveForever(): Promise<void>;
}

export function driveTunnel(listener: DrivenTunnel, onError?: (message: string) => void): void {
  void listener.serveForever().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    onError?.(message);
  });
}
