// Patch the wallet SDK so a dropped indexer socket does not kill a long sync.
//
// Three problems, all in `node_modules`, all invisible from our code:
//
// 1. Diagnosis. A stalled sync surfaces as `SyncWalletError`, whose message is
//    the constant string "Wallet.Sync" and whose cause is already destroyed:
//    the indexer's WebSocket client converts every transport failure with
//    `new ServerError({ message: String(err) })`, so a real close event becomes
//    the literal text "[object Object]". We print the detail where it still
//    exists, which is how the failures were identified:
//
//      RAW_WS_ERROR: {} | code=1006 reason= type=close wasClean=false ctor=CloseEvent
//      RAW_WS_ERROR: {} | type=error message=read ECONNRESET ctor=ErrorEvent
//
//    Code 1006 is an abnormal close, and ECONNRESET is a dropped socket. Both
//    happen every minute or two during a long stream against Preprod.
//
// 2. Resilience. The SDK calls `createClient` from graphql-ws with
//    `shouldRetry: () => false`. Every transport failure is therefore
//    permanent: the sync stream fails and `waitForSyncedState()` never
//    resolves. graphql-ws's own default retries a transport close with
//    exponential backoff; restore that, widened to cover a socket error
//    (`ErrorEvent`) as well as a close. Log each reconnect so recovery is
//    visible.
//
// 3. Retry budget. `retryAttempts` defaults to 5 with a 2^n-second backoff, so
//    a brief outage (~30s of consecutive failures, or five in a row) still ends
//    a multi-hour sync. Raise the ceiling and cap the wait, so a long catch-up
//    survives flaky connectivity instead of dying on it.
//
// Runs from `postinstall`, so it survives a reinstall, and is idempotent: every
// target is checked for its marker, so a second run is a no-op. It never fails
// an install — if the SDK changes shape it warns and moves on, because losing
// these patches beats a broken dependency tree.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SDKS = path.resolve(HERE, "..", "node_modules", "@midnight-ntwrk");
const WALLETS = ["wallet-sdk-shielded", "wallet-sdk-dust-wallet", "wallet-sdk-unshielded-wallet"];
const WS_FILE = path.join(SDKS, "wallet-sdk-indexer-client", "dist", "effect", "WsSubscriptionClient.js");

let patched = 0;
let already = 0;
let skipped = 0;

/** Replace `original` with `replacement` once, or report why not. */
function patchFile(label, file, marker, original, replacement) {
  if (!existsSync(file)) {
    console.log(`patch-wallet-sdk: ${label} is not installed, skipped`);
    skipped += 1;
    return;
  }
  const source = readFileSync(file, "utf8");
  if (source.includes(marker)) {
    already += 1;
    return;
  }
  if (!source.includes(original)) {
    console.log(`patch-wallet-sdk: ${label} has an unexpected shape; not patched`);
    skipped += 1;
    return;
  }
  writeFileSync(file, source.replace(original, replacement));
  patched += 1;
}

/**
 * Apply the first `original` that matches. Lets one patch cover both a pristine
 * file and an earlier revision of this same patch, so an upgrade is idempotent.
 */
function patchAnyShape(label, file, marker, originals, replacement) {
  for (const original of originals) {
    if (existsSync(file) && readFileSync(file, "utf8").includes(original)) {
      patchFile(label, file, marker, original, replacement);
      return;
    }
  }
  patchFile(label, file, marker, originals[0], replacement);
}

/** Prepend a helper function to `file` unless it is already there. */
function ensureHelper(file, marker, text) {
  if (!existsSync(file)) return;
  const source = readFileSync(file, "utf8");
  if (source.includes(marker)) return;
  writeFileSync(file, text + source);
  console.log(`patch-wallet-sdk: added ${marker.replace("function ", "").replace("(", "")}`);
  patched += 1;
}

// ─── 1. The three wallet packages: name the sync failure ──────────────────────
// `SyncWalletError` is an empty tagged-error class; give it a constructor that
// prints its argument and cause, then delegates to the original constructor.
const SYNC_CLASS = `export class SyncWalletError extends Data.TaggedError('Wallet.Sync') {
}`;

const SYNC_CLASS_PATCHED = `export class SyncWalletError extends Data.TaggedError('Wallet.Sync') {
    constructor() {
        super(...arguments);
        // Diagnostics only. Never let logging break the wallet.
        try {
            const first = arguments[0];
            const cause = first && first.cause;
            console.error(
                'RAW_SYNC_ERROR:',
                (first && first.message) || String(first),
                '|',
                cause && (cause.message || String(cause)),
            );
        } catch (_) {
            /* ignore */
        }
    }
}`;

for (const name of WALLETS) {
  patchFile(
    `${name} SyncWalletError`,
    path.join(SDKS, name, "dist", "v1", "WalletError.js"),
    "RAW_SYNC_ERROR",
    SYNC_CLASS,
    SYNC_CLASS_PATCHED,
  );
}

// ─── 2. The indexer WS client: keep the transport error ───────────────────────
// `toClientOrServerError` collapses anything that is not a GraphQL error array
// into `String(err)`. Print the object before it is lost.
patchFile(
  "indexer WsSubscriptionClient transport error",
  WS_FILE,
  "__oiLogWsError",
  `: new ServerError({ message: String(err) });`,
  `: (__oiLogWsError(err), new ServerError({ message: String(err) }));`,
);

// ─── 3. The indexer WS client: reconnect instead of dying ─────────────────────
// Log each reconnect. Anchored on the closing brace, so it must run before the
// retry policy below inserts options in the same place.
patchFile(
  "indexer WsSubscriptionClient reconnect logging",
  WS_FILE,
  "WS_RECONNECT",
  "keepAlive: config.keepAlive ?? 15_000 }",
  "keepAlive: config.keepAlive ?? 15_000, on: { opened: () => console.error('WS_RECONNECT: opened'), closed: (ev) => console.error('WS_RECONNECT: closed', ev && ev.code) } }",
);

// Retry a transport failure instead of treating it as fatal.
patchAnyShape(
  "indexer WsSubscriptionClient socket retry",
  WS_FILE,
  "__oiRetryableTransport",
  ["shouldRetry: () => false", "shouldRetry: (ev) => __oiRetryableClose(ev)"],
  "shouldRetry: (ev) => __oiRetryableTransport(ev)",
);

// Log when the indexer ends a subscription. The SDK's backpressure state
// machine treats a completion as end-of-stream unless the source is paused, so
// an early server-side completion ends that wallet's sync silently: the dust
// view sat at applied 236,363 of 1,658,011 for half an hour like this.
patchFile(
  "indexer WsSubscriptionClient subscription completion",
  WS_FILE,
  "WS_SUBSCRIBE_COMPLETE",
  "complete: onComplete,",
  "complete: () => { console.error('WS_SUBSCRIBE_COMPLETE'); onComplete(); },",
);

// It defaults to five attempts; a multi-hour sync needs a bigger budget.
patchFile(
  "indexer WsSubscriptionClient retry policy",
  WS_FILE,
  "retryAttempts: 100",
  "keepAlive: config.keepAlive ?? 15_000",
  "keepAlive: config.keepAlive ?? 15_000, retryAttempts: 100, retryWait: __oiRetryWait",
);

ensureHelper(
  WS_FILE,
  "function __oiLogWsError(",
  `function __oiLogWsError(err) {
    try {
        let json;
        try {
            json = JSON.stringify(err, Object.getOwnPropertyNames(err ?? {}));
        } catch (_) {
            json = '<unserialisable>';
        }
        const fields = [];
        if (err && typeof err === 'object') {
            for (const key of ['code', 'reason', 'type', 'message', 'name', 'wasClean']) {
                const value = err[key];
                if (value !== undefined) fields.push(key + '=' + (typeof value === 'string' ? value : String(value)));
            }
            const ctor = err.constructor && err.constructor.name;
            if (ctor) fields.push('ctor=' + ctor);
            if (Array.isArray(err)) fields.push('isArray=true len=' + err.length);
        }
        console.error('RAW_WS_ERROR:', json, '|', fields.join(' '));
    } catch (_) {
        /* never break the wallet */
    }
}

`,
);

ensureHelper(
  WS_FILE,
  "function __oiRetryableTransport(",
  `function __oiRetryableTransport(ev) {
    // Retry anything that is a transport failure: a CloseEvent (numeric code,
    // e.g. 1006) or a socket ErrorEvent (e.g. "read ECONNRESET"). graphql-ws's
    // own default covers only the close form, and the SDK covered neither.
    if (!ev || typeof ev !== 'object') return false;
    if (typeof ev.code === 'number') return true;
    return ev.type === 'error';
}

function __oiRetryWait(retries) {
    // The default wait is 2^retries seconds, so a handful of failures in a row
    // stalls for minutes. Cap it: a long sync prefers many short retries.
    const seconds = Math.min(2 ** retries, 20);
    return new Promise((resolve) => setTimeout(resolve, seconds * 1000 + Math.floor(Math.random() * 1000)));
}

`,
);

if (patched > 0) console.log(`patch-wallet-sdk: patched ${patched} target(s)`);
if (already > 0) console.log(`patch-wallet-sdk: ${already} already patched`);
if (skipped > 0) console.log(`patch-wallet-sdk: ${skipped} skipped (see above)`);
