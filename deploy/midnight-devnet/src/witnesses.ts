/**
 * Compact witnesses for the Open Instinct contracts.
 *
 * The witness is the bridge between the contract's private state and the
 * circuit: it lives on the owner's device and is never sent to the network. For
 * the memory vault the only witness is `ownerSecret`, the high-entropy secret
 * the circuit hashes into the per-commitment owner binding. It is derived
 * deterministically from the wallet seed so a deploy-time commitment can be
 * re-proven later without storing the secret anywhere else.
 *
 * Unit-tested by `test/vault.sim.test.ts`, which drives the circuits through
 * the Compact runtime (a simulator) with no network.
 */
import { ownerSecretFromSeed } from './secret.js';

export interface VaultPrivateState {
  ownerSecret: Uint8Array;
}

export const VAULT_PRIVATE_STATE_ID = 'memoryVaultPrivateState';

/** The witness implementation the generated `Contract` expects. */
export function vaultWitnesses() {
  return {
    ownerSecret: ({ privateState }: { privateState: VaultPrivateState }): [VaultPrivateState, Uint8Array] => [
      privateState,
      privateState.ownerSecret,
    ],
  };
}

/** Build the vault's private state for a given wallet seed. */
export function vaultPrivateState(seed: string): VaultPrivateState {
  return { ownerSecret: ownerSecretFromSeed(seed) };
}
