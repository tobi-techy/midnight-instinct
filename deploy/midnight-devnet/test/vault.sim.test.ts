/**
 * Contract simulator tests.
 *
 * Drives the memory-vault circuits through the Compact runtime directly — no
 * network, no proof server, no wallet. This is the off-chain counterpart to
 * `deploy.ts`: it exercises commit / attest / revoke semantics (bind-once,
 * owner binding, single-use nullifiers, revocation) against the real compiled
 * circuits.
 *
 *   npm test
 */
import { describe, expect, it } from 'vitest';
import {
  createCircuitContext,
  createConstructorContext,
  dummyContractAddress,
} from '@midnight-ntwrk/compact-runtime';
import { Contract, ledger } from '../contracts/managed/memory-vault/contract/index.js';
import { vaultWitnesses, type VaultPrivateState } from '../src/witnesses';

const b32 = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);

/* eslint-disable @typescript-eslint/no-explicit-any */
function setup(secret: Uint8Array): { contract: any; context: any } {
  const contract = new Contract(vaultWitnesses() as any);
  const constructorContext = createConstructorContext<VaultPrivateState>(
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

describe('memory vault circuits (simulator)', () => {
  const preimage = b32(10);
  const salt = b32(20);
  const attestationId = b32(30);

  it('commits a memory and stores a 32-byte active commitment', () => {
    const { contract, context } = setup(b32(1));
    const { result, context: next } = contract.circuits.commit(context, preimage, salt);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result).toHaveLength(32);
    const l = readLedger(next);
    expect(l.commitments.size()).toBe(1n);
    expect(l.commitments.member(result)).toBe(true);
    expect(l.active.lookup(result)).toBe(true);
  });

  it('is bind-once: the same preimage and salt cannot be committed twice', () => {
    const { contract, context } = setup(b32(1));
    const first = contract.circuits.commit(context, preimage, salt);
    expect(() => contract.circuits.commit(first.context, preimage, salt)).toThrow(/already committed/);
  });

  it('differs for different preimages and different salts', () => {
    const { contract, context } = setup(b32(1));
    const a = contract.circuits.commit(context, preimage, salt);
    const b = contract.circuits.commit(a.context, b32(11), salt);
    const c = contract.circuits.commit(b.context, preimage, b32(21));
    expect(a.result).not.toEqual(b.result);
    expect(a.result).not.toEqual(c.result);
  });

  it('attests a category and nullifies the attestation id', () => {
    const { contract, context } = setup(b32(1));
    const committed = contract.circuits.commit(context, preimage, salt);
    const attested = contract.circuits.attest(
      committed.context,
      committed.result,
      attestationId,
      1n,
    );
    const l = readLedger(attested.context);
    expect(l.attestations.lookup(attestationId)).toBe(1n);
    expect(l.nullifiers.lookup(attestationId)).toBe(true);
  });

  it('refuses to replay the same attestation id', () => {
    const { contract, context } = setup(b32(1));
    const committed = contract.circuits.commit(context, preimage, salt);
    const attested = contract.circuits.attest(committed.context, committed.result, attestationId, 1n);
    expect(() =>
      contract.circuits.attest(attested.context, committed.result, attestationId, 1n),
    ).toThrow(/already used/);
  });

  it('refuses an attestation from a different owner secret', () => {
    const { contract, context } = setup(b32(1));
    const committed = contract.circuits.commit(context, preimage, salt);
    const foreign = createCircuitContext(
      dummyContractAddress(),
      committed.context.currentZswapLocalState.coinPublicKey,
      committed.context.currentQueryContext.state,
      { ownerSecret: b32(9) } as VaultPrivateState,
    );
    expect(() =>
      contract.circuits.attest(foreign as any, committed.result, attestationId, 1n),
    ).toThrow(/not the owner/);
  });

  it('revokes a commitment so it can no longer be attested', () => {
    const { contract, context } = setup(b32(1));
    const committed = contract.circuits.commit(context, preimage, salt);
    const revoked = contract.circuits.revoke(committed.context, committed.result);
    const l = readLedger(revoked.context);
    expect(l.active.lookup(committed.result)).toBe(false);
    expect(() =>
      contract.circuits.attest(revoked.context, committed.result, attestationId, 1n),
    ).toThrow(/revoked/);
  });
});
