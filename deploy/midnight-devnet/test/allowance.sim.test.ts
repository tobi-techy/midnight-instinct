/**
 * Allowance registry simulator tests.
 *
 * Same harness as `vault.sim.test.ts`, against the allowance circuits. The
 * point of these cases is the owner binding: authorize, spend and revoke each
 * take a public key hash, so without a witness-checked binding anyone reading
 * the ledger could revoke, drain or re-authorize someone else's allowance.
 *
 *   npm test
 */
import { describe, expect, it } from 'vitest';
import {
  createCircuitContext,
  createConstructorContext,
  dummyContractAddress,
} from '@midnight-ntwrk/compact-runtime';
import { Contract, ledger } from '../contracts/managed/allowance-registry/contract/index.js';
import { allowanceWitnesses, type AllowancePrivateState } from '../src/witnesses';

const b32 = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);

/* eslint-disable @typescript-eslint/no-explicit-any */
function setup(secret: Uint8Array): { contract: any; context: any } {
  const contract = new Contract(allowanceWitnesses() as any);
  const constructorContext = createConstructorContext<AllowancePrivateState>(
    { ownerSecret: secret },
    '00'.repeat(32),
  );
  const init = contract.initialState(constructorContext as any);
  const context = createCircuitContext(
    dummyContractAddress(),
    init.currentZswapLocalState.coinPublicKey,
    init.currentContractState.data,
    init.currentPrivateState,
  );
  return { contract, context };
}

const readLedger = (context: any): any => ledger(context.currentQueryContext.state);
/* eslint-enable @typescript-eslint/no-explicit-any */

describe('allowance registry circuits (simulator)', () => {
  const owner = b32(1);
  const key = b32(40);

  it('authorizes an allowance and records the running total on spend', () => {
    const { contract, context } = setup(owner);
    const authorized = contract.circuits.authorize(context, key, 5_000n);
    expect(readLedger(authorized.context).limits.lookup(key)).toBe(5_000n);

    const spent = contract.circuits.spend(authorized.context, key, 1_200n);
    const l = readLedger(spent.context);
    expect(l.spent.lookup(key)).toBe(1_200n);
    expect(l.active.lookup(key)).toBe(true);
  });

  it('refuses a spend past the limit', () => {
    const { contract, context } = setup(owner);
    const authorized = contract.circuits.authorize(context, key, 1_000n);
    expect(() => contract.circuits.spend(authorized.context, key, 1_001n)).toThrow(/over allowance/);
  });

  it('refuses to spend or revoke another owner’s allowance', () => {
    const { contract, context } = setup(owner);
    const authorized = contract.circuits.authorize(context, key, 5_000n);
    const foreign = createCircuitContext(
      dummyContractAddress(),
      authorized.context.currentZswapLocalState.coinPublicKey,
      authorized.context.currentQueryContext.state,
      { ownerSecret: b32(9) } as AllowancePrivateState,
    );
    expect(() => contract.circuits.spend(foreign as any, key, 100n)).toThrow(/not the allowance owner/);
    expect(() => contract.circuits.revoke(foreign as any, key)).toThrow(/not the allowance owner/);
  });

  it('refuses to re-authorize (and reset) another owner’s revoked allowance', () => {
    const { contract, context } = setup(owner);
    const authorized = contract.circuits.authorize(context, key, 5_000n);
    const revoked = contract.circuits.revoke(authorized.context, key);
    const foreign = createCircuitContext(
      dummyContractAddress(),
      revoked.context.currentZswapLocalState.coinPublicKey,
      revoked.context.currentQueryContext.state,
      { ownerSecret: b32(9) } as AllowancePrivateState,
    );
    expect(() => contract.circuits.authorize(foreign as any, key, 999_999n)).toThrow(/not the allowance owner/);

    // The owner can re-authorize, and the reset is theirs to make.
    const again = contract.circuits.authorize(revoked.context, key, 2_000n);
    const l = readLedger(again.context);
    expect(l.limits.lookup(key)).toBe(2_000n);
    expect(l.spent.lookup(key)).toBe(0n);
  });
});
