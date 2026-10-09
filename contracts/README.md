# Contracts (Midnight)

Compact sources for the Midnight private agent build. Two contracts, both kept
deliberately small so the circuits compile fast and the demo needs one proving
round-trip, not ten.

| Contract | Purpose | Status |
|---|---|---|
| `memory-vault.compact` | Shielded memory commitments + selective-disclosure attestations | hero |
| `allowance-registry.compact` | ZK-gated spending/permission allowances | stretch |

## Toolchain

- Language: Compact (TypeScript-derived), per https://docs.midnight.network/
- Local dev: https://github.com/midnightntwrk/midnight-local-dev
- Pin the compiler before testnet deploy and record it here:

```
compactc version: <fill in, e.g. 0.17.x>
local-dev image:  <fill in>
testnet:          <Midnight testnet name + block height at deploy>
```

If `compactc` reports a syntax drift against these sources, keep the semantics
(commit-once, attest-with-nullifier, spend-within-limit) and adjust the syntax;
the TS client in `packages/midnight` only depends on the circuit names and
argument shapes documented in each file header.

## What stays off-ledger

Memory text, exact spend amounts and owner identity never appear on-ledger.
The chain holds commitments (`bytes32`), blinders, category codes and running
spend totals. Preimages live in the agent host vault and the owner's wallet,
which is where proofs are generated.

## Build

```sh
compactc contracts/memory-vault.compact --output contracts/build/vault
compactc contracts/allowance-registry.compact --output contracts/build/allowances
node packages/midnight/scripts/prove-local.mjs   # commit -> attest round-trip
node packages/midnight/scripts/deploy-testnet.mjs # deploys vault (+allowances), writes addresses to <data>/midnight.json
```
