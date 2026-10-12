/**
 * Compact witnesses for the Open Instinct contracts.
 *
 * The witness is the bridge between the contract's private state and the
 * circuit: it lives on the owner's device and is never sent to the network. Both
 * contracts use the same `ownerSecret` idiom — `memory-vault` hashes it into the
 * per-commitment owner binding, `allowance-registry` into the per-allowance
 * binding — the high-entropy secret the circuits hash into those bindings. It
 * is derived deterministically from the wallet seed so a deploy-time binding can
 * be re-proven later without storing the secret anywhere else.
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

export interface AllowancePrivateState {
  ownerSecret: Uint8Array;
}

export const ALLOWANCE_PRIVATE_STATE_ID = 'allowanceRegistryPrivateState';

/**
 * The allowance registry binds every circuit to the same owner secret, so a
 * third party reading a public key off the ledger cannot spend, revoke or
 * re-authorize someone else's allowance.
 */
export function allowanceWitnesses() {
  return {
    ownerSecret: ({ privateState }: { privateState: AllowancePrivateState }): [AllowancePrivateState, Uint8Array] => [
      privateState,
      privateState.ownerSecret,
    ],
  };
}

/** Build the allowance registry's private state for a given wallet seed. */
export function allowancePrivateState(seed: string): AllowancePrivateState {
  return { ownerSecret: ownerSecretFromSeed(seed) };
}
