/**
 * Report wallet sync progress.
 *
 * `waitForSyncedState()` resolves only once all three child wallets have caught
 * up to the tip they know about, and it says nothing while they do. A long
 * catch-up therefore looks exactly like a stalled one — which is how the first
 * Preprod attempts hid a failing sync, and how a healthy one looked too.
 *
 * The facade exposes its state as an observable, so we can print what each
 * child wallet has applied while it works, and shout when nothing moves: the
 * dust view was seen to stop advancing for half an hour while shielded and
 * unshielded carried on, and the run then failed with only "Wallet.Sync" in the
 * log. The child states nest their progress differently (`shielded.state.progress`
 * vs `unshielded.progress`), so this reads through both shapes.
 */
import { throttleTime } from 'rxjs';

import type { WalletContext } from './wallet';

interface Progress {
  readonly appliedId?: bigint;
  readonly appliedIndex?: bigint;
  readonly highestTransactionId?: bigint;
  readonly highestRelevantWalletIndex?: bigint;
  readonly highestIndex?: bigint;
  readonly isConnected?: boolean;
  isStrictlyComplete?(): boolean;
}

interface ChildState {
  readonly state?: { readonly progress?: Progress };
  readonly progress?: Progress;
}

interface FacadeStateLike {
  readonly shielded?: ChildState;
  readonly unshielded?: ChildState;
  readonly dust?: ChildState;
  readonly isSynced?: boolean;
}

const CHILD_KINDS = ['shielded', 'unshielded', 'dust'] as const;

function progressOf(child: ChildState | undefined): Progress | undefined {
  return child?.state?.progress ?? child?.progress;
}

function appliedOf(child: ChildState | undefined): string {
  const progress = progressOf(child);
  return String(progress?.appliedId ?? progress?.appliedIndex ?? '?');
}

/** One child wallet's position, as `applied/highest (behind n)`. */
function describe(kind: string, child: ChildState | undefined): string {
  const progress = progressOf(child);
  if (!progress) return `${kind}=?`;

  const applied = progress.appliedId ?? progress.appliedIndex;
  const highest =
    progress.highestTransactionId ?? progress.highestRelevantWalletIndex ?? progress.highestIndex;
  const behind = applied !== undefined && highest !== undefined ? String(highest - applied) : '?';
  const flags = [
    progress.isStrictlyComplete?.() ? 'complete' : undefined,
    progress.isConnected === false ? 'disconnected' : undefined,
  ].filter((flag): flag is string => flag !== undefined);

  return `${kind}=${applied ?? '?'}/${highest ?? '?'} (behind ${behind}${
    flags.length > 0 ? `, ${flags.join(', ')}` : ''
  })`;
}

/**
 * Log sync progress every `everyMs` ms while the wallet works, and warn when
 * nothing has moved for `stallAfterMs`. Returns a function that stops it.
 */
export function reportSyncProgress(
  wallet: WalletContext['wallet'],
  everyMs = 15_000,
  stallAfterMs = 10 * 60_000,
): () => void {
  const started = Date.now();
  let lastPositions = '';
  let lastChangeAt = started;
  let warnedStall = false;

  const subscription = wallet
    .state()
    .pipe(throttleTime(everyMs, undefined, { leading: true, trailing: true }))
    .subscribe({
      next: (state) => {
        const facadeState = state as unknown as FacadeStateLike;
        const seconds = Math.round((Date.now() - started) / 1000);
        const elapsed = `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
        const children = CHILD_KINDS.map((kind) => describe(kind, facadeState[kind]));
        const synced = facadeState.isSynced ? ' synced' : '';
        console.error(`SYNC_PROGRESS: [${elapsed}]${synced} ${children.join('  ')}`);

        const positions = CHILD_KINDS.map((kind) => appliedOf(facadeState[kind])).join('|');
        if (positions !== lastPositions) {
          lastPositions = positions;
          lastChangeAt = Date.now();
          warnedStall = false;
          return;
        }

        const stalledFor = Date.now() - lastChangeAt;
        if (!facadeState.isSynced && !warnedStall && stalledFor > stallAfterMs) {
          warnedStall = true;
          console.error(
            `SYNC_STALLED: nothing applied for ${Math.round(stalledFor / 60_000)}m — ${children.join('  ')}`,
          );
        }
      },
      error: () => {
        /* the sync path reports its own failures */
      },
    });

  return () => subscription.unsubscribe();
}
