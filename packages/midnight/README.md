# @open-instinct/midnight

Privacy layer for Open Instinct: a shielded memory vault, selective-disclosure
proofs, and ZK-gated allowances, anchored on Midnight.

## What it does

The agent already keeps memories as plain markdown the owner can read and edit.
This package adds a second, private dimension to every durable memory:

1. **`vault_commit`** saves the note locally *and* anchors an opaque 32-byte
   commitment on Midnight. The chain never sees the text.
2. **`vault_prove_reveal`** produces a selective-disclosure proof: the verifier
   learns only a category code (health, finance, …) or bare existence.
3. **`vault_status`** reports the mode, contract addresses and counts.
4. **`allowance_check`** (stretch) gates a spend against an on-chain allowance
   without revealing the exact amount.

## Modes

| Mode | Network | Use |
|---|---|---|
| `mock` | none | Default. Deterministic offline anchoring; demos, CI, smoke test. |
| `local` | midnight-local-dev | Full proving round-trip on your machine. |
| `testnet` | Midnight testnet | Real transactions with explorer links. |

Set `MIDNIGHT_MODE`, plus `MIDNIGHT_PROOF_URL` and `MIDNIGHT_CONTRACT_ADDRESS`
for local/testnet. See `docs/MIDNIGHT.md` in the repo root.

## Layout

- `src/client.ts` — `MidnightClient`: commit, prove, authorize, checkSpend, revoke.
- `src/commit.ts` — commitment helpers (`preimageOf`, mock `persistentCommit`, category codes).
- `src/memory.ts` — `ShieldedMemory`: wraps `MemoryStore`, never forks it.
- `src/tools.ts` — the four agent tools.
- `scripts/prove-local.mjs` — offline commit → prove → verify round-trip.
- `scripts/deploy-testnet.mjs` — deploy via the proof-server adapter.

## Scripts

```sh
node packages/midnight/scripts/prove-local.mjs      # offline, always works
node packages/midnight/scripts/deploy-testnet.mjs   # needs MIDNIGHT_PROOF_URL
```

## Privacy invariants

- Memory plaintext never leaves the host; only commitments and tx hashes do.
- Proofs disclose a category code or `0` (existence), never the text.
- Attestation ids are nullified on use, so a proof cannot be replayed.
- The spend amount is a witness, never a public ledger value.
