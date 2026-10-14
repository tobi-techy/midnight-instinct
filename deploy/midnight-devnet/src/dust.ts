/**
 * DUST funding for a wallet: register any unregistered NIGHT UTXOs so they
 * generate DUST, then wait until a spendable DUST balance exists.
 *
 * Both the deploy script and the long-running adapter need this. A wallet whose
 * NIGHT is not registered for DUST generation can still read ledger state, but
 * every transaction it tries to submit hangs waiting for a fee it can never
 * pay — so the adapter funds DUST on start instead of only during deploy.
 */
import * as Rx from 'rxjs';
import type { WalletContext } from './wallet';

export const DEFAULT_DUST_WAIT_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Bound a wallet SDK wait by its configured deadline. The SDK can stay pending
 * forever (a wallet that never emits a synced DUST state), which would take the
 * caller past the deadline it just printed to the operator.
 */
export function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out after ${Math.round(ms / 1000)}s waiting for ${what}`)),
      ms,
    );
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err as Error);
      },
    );
  });
}

export interface EnsureDustOptions {
  timeoutMs?: number;
  log?: (message: string) => void;
}

export async function ensureDust(ctx: WalletContext, opts: EnsureDustOptions = {}): Promise<void> {
  const timeoutMs =
    opts.timeoutMs ?? (Number(process.env.MIDNIGHT_DUST_TIMEOUT_MS) || DEFAULT_DUST_WAIT_TIMEOUT_MS);
  const log = opts.log ?? ((message: string) => console.log(message));

  const dustState = await Rx.firstValueFrom(ctx.wallet.state().pipe(Rx.filter((s) => s.isSynced)));
  const unregistered = dustState.unshielded.availableCoins.filter(
    (c) => !(c as { meta?: { registeredForDustGeneration?: boolean } }).meta?.registeredForDustGeneration,
  );
  if (unregistered.length > 0) {
    log(`  Registering ${unregistered.length} NIGHT UTXO(s) for DUST generation...`);
    // A registration built too soon after funding has no DUST yet to pay its own
    // fee and throws before signing. Wait until the NIGHT already generates
    // enough to cover the estimated fee (see the funding guide).
    try {
      const { fee } = await ctx.wallet.estimateRegistration(unregistered);
      log(`  Waiting for generated DUST to cover the registration fee (${fee})...`);
      await withDeadline(
        ctx.wallet.waitForGeneratedDust(unregistered, fee),
        timeoutMs,
        'DUST to cover the registration fee',
      );
    } catch (err) {
      log(`  (registration fee estimate unavailable: ${err instanceof Error ? err.message : String(err)}; proceeding)`);
    }
    const recipe = await ctx.wallet.registerNightUtxosForDustGeneration(
      unregistered,
      ctx.unshieldedKeystore.getPublicKey(),
      (payload) => ctx.unshieldedKeystore.signData(payload),
    );
    const finalized = await ctx.wallet.finalizeRecipe(recipe);
    await ctx.wallet.submitTransaction(finalized);
  }
  if (dustState.dust.balance(new Date()) === 0n) {
    log('  Waiting for DUST...');
    await Rx.firstValueFrom(
      ctx.wallet.state().pipe(
        Rx.throttleTime(5000),
        Rx.filter((s) => s.isSynced),
        Rx.filter((s) => s.dust.balance(new Date()) > 0n),
        Rx.timeout({ first: timeoutMs }),
      ),
    );
  }
}
