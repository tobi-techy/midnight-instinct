/**
 * Error reporting for wallet sync.
 *
 * The wallet SDK nests its failures: the error you catch carries only a tag
 * ("Wallet.Sync"), and the real reason, a schema mismatch, a closed socket or a
 * rate limit, sits on `cause`. `String(err)` throws that away, which makes a
 * stalled sync indistinguishable from a broken endpoint.
 *
 * The SDK also hides the cause, so `scripts/patch-sdk-sync-logging.mjs` logs it
 * at the point it is raised. This module covers what reaches our own code.
 */

/** Flatten an error and its whole `cause` chain into one line. */
export function describeErrorChain(err: unknown): string {
  const seen = new Set<unknown>();
  const parts: string[] = [];

  let current: unknown = err;
  while (current !== null && current !== undefined && !seen.has(current)) {
    seen.add(current);
    const e = current as { message?: unknown; cause?: unknown; _tag?: unknown };
    const tag = typeof e._tag === 'string' ? `${e._tag}: ` : '';
    const message = typeof e.message === 'string' && e.message ? e.message : String(current);
    parts.push(`${tag}${message}`);
    current = e.cause;
  }

  return parts.length > 0 ? parts.join(' <- ') : String(err);
}

/**
 * Await a wallet sync, reporting the full cause chain if it fails.
 * Re-throws the original error so callers keep their existing handling.
 */
export async function syncWithDiagnostics<T>(label: string, sync: () => Promise<T>): Promise<T> {
  try {
    return await sync();
  } catch (err) {
    console.error(`${label}: ${describeErrorChain(err)}`);
    throw err;
  }
}
