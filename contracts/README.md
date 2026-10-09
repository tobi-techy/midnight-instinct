# Contracts (Midnight)

Compact sources for the Midnight private agent build. Two contracts, both kept
deliberately small so the circuits compile fast and the demo needs one proving
round-trip, not ten.

| Contract | Purpose | Status |
|---|---|---|
| `memory-vault.compact` | Shielded memory commitments + selective-disclosure attestations | hero |
| `allowance-registry.compact` | ZK-gated spending/permission allowances | stretch |

Both are written against the idioms in the official
["Build a private smart contract"](https://docs.midnight.network/guides/build-a-private-smart-contract)
guide: `persistentCommit` for anything guessable, `disclose()` only on the
narrowest value that must cross into public state, and witnesses for the
owner's secret.

## Toolchain

- Language: Compact, per https://docs.midnight.network/
- Compiler: `compact compile` (Midnight Compact toolchain; the guide pins
  `pragma language_version 0.23`, which both sources use).
- Local dev: https://github.com/midnightntwrk/midnight-local-dev

Record the exact pins before a testnet deploy:

```
compact compile version: 0.31.1
language version:        0.23.0
ledger version:          ledger-8.0.2
runtime version:         0.16.0
```

Both contracts compile with `compact compile` 0.31.1. Build them with
`pnpm run contracts:build` (fast syntax check: `pnpm run contracts:check`).

If `compact compile` reports syntax drift against these sources, keep the
semantics (commit-once, attest-with-nullifier, spend-within-limit) and adjust
the syntax; the TS client in `packages/midnight` depends only on the circuit
names and argument shapes documented in each file header.

## Privacy model

- The circuit takes the memory's digest (`sha256(text)`) and a random salt as
  private inputs and stores only `persistentCommit(preimage, salt)`. The
  compiler accepts a `persistentCommit` result on the ledger without
  `disclose()`, because it is hiding by construction.
- The owner binding is `persistentCommit(ownerSecret, commitment)`: a witness
  supplies `ownerSecret`, so the ledger never learns who owns which memory.
- `attest` discloses only the category code and nullifies the attestation id on
  use, so a proof is single-use and reveals nothing but the category.
- Allowance limits and running totals are public (an allowance is a statement);
  what the circuit guarantees is that no spend can push the total past the
  limit, which the agent cannot forge even if prompt-injected.

## What stays off-ledger

Memory text, the owner's vault secret and the salt never appear on-ledger. The
chain holds commitments, an owner binding, category codes and running spend
totals. Preimages live in the agent host vault and the owner's device, which is
where proofs are generated.

## Build

```sh
compact compile contracts/memory-vault.compact contracts/build/memory-vault
compact compile contracts/allowance-registry.compact contracts/build/allowance-registry
node packages/midnight/scripts/prove-local.mjs     # commit -> attest round-trip (offline)
node packages/midnight/scripts/deploy-testnet.mjs  # deploys vault (+allowances), writes addresses to <data>/midnight.json
```
