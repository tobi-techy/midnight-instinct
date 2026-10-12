/**
 * Deterministic vault owner secret.
 *
 * Both the deploy script and the runtime adapter derive the same secret from
 * the wallet seed, so the on-chain owner binding created at deploy time can be
 * re-proven at call time. It never leaves the machine; it is the witness the
 * `memory-vault` circuit hashes into the owner binding.
 */
import { createHash } from 'node:crypto';

export function ownerSecretFromSeed(seed: string): Uint8Array {
  return createHash('sha256').update(`open-instinct:owner-secret:${seed}`, 'utf8').digest();
}
