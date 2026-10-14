# Midnight devnet + real deploy harness

This is a self-contained project that runs a **local Midnight network** (node,
indexer, proof server) in Docker and deploys the Open Instinct contracts to it
for real, producing genuine transaction ids. It is the "does it actually run
on Midnight" proof for the private-agent build.

It was scaffolded from [`create-mn-app`](https://www.npmjs.com/package/create-mn-app)
and then pointed at our two contracts. It is not part of the pnpm workspace
(`pnpm-workspace.yaml` only includes `packages/*`), so it keeps its own
`node_modules` and does not affect the agent build.

## What a run proves

`npm run deploy` executes the full Midnight pipeline end to end:

1. Boots a synced wallet against the local chain and registers NIGHT for DUST.
2. Deploys `memory-vault` — a real on-chain contract, real deploy transaction.
3. Calls `commit`: the circuit computes `persistentCommit(preimage, salt)` and
   stores the commitment. Real transaction.
4. Calls `attest`: the circuit records the disclosed category and nullifies the
   attestation id. Real transaction, real nullifier.
5. Deploys `allowance-registry` (the stretch contract).

Every id is written to `deployment.json`, for example:

```json
{
  "network": "undeployed",
  "memoryVault": {
    "address": "cd33b0e1…b78505",
    "deployTx": "00cfdfb0…f9b922c7",
    "commitTx": "00f80e2d…0ac6d632ba5d",
    "commitment": "47214035…b07e630c",
    "attestTx": "0071ed9d…415a70be4c"
  }
}
```

## Prerequisites

- Docker Desktop running
- Node.js 22+
- The Compact toolchain (`compact compile`) on `PATH`

## Quickstart

```bash
cd deploy/midnight-devnet
npm install           # ~212 packages, a few minutes
npm run setup         # docker up + compile + deploy
npm run test:e2e      # reconnects and reads the on-chain ledger
npm run check-balance # wallet + DUST balance
```

## Deploy to Preprod (public testnet)

Preprod is reached through [Blockfrost](https://blockfrost.io) — the
Midnight-hosted Preprod endpoints were retired on 2026-10-09. You need a
Blockfrost **Preprod** project id.

```bash
cd deploy/midnight-devnet
# 1. Put secrets in a gitignored file (.env.* is ignored):
#    BLOCKFROST_PROJECT_ID=preprod...
#    MIDNIGHT_WALLET_MNEMONIC="word word … word"   # optional; omit to generate one
set -a; source .env.preprod; set +a

npm run address -- --network preprod   # prints the deployment wallet address (and persists a generated seed)
# 2. Fund that address from the Preprod faucet, then:
npm run setup -- --network preprod   # proof server + compile + deploy
```

Notes:

- Only the proof server runs locally; the node and indexer are Blockfrost.
  The Midnight-hosted Preprod endpoints shut down from 22:00 UTC on 2026-10-09.
- A fresh wallet syncs from genesis (Preprod was at height 2,976,341 when this
  was written), which takes hours: the dust view alone replays ~1.7M events at
  a couple of hundred per second. `deploy` logs per-child progress
  (`SYNC_PROGRESS: shielded=… unshielded=… dust=…`, with what each has applied
  and how far behind it is) and checkpoints `.midnight-wallet-state/` every
  five minutes while it syncs, so an interruption resumes instead of starting
  over. The SDK may log
  `subscribeRuntimeVersion(): disconnected` — Blockfrost's RPC declines that
  node websocket subscription, and it is harmless; the wallet syncs from the
  indexer.
- The wallet syncs over a Blockfrost WebSocket, and that socket is dropped
  abnormally (close code `1006`) every few minutes during a long stream. The
  wallet SDK turns off graphql-ws's reconnect (`shouldRetry: () => false`), so a
  single drop used to fail the sync permanently — `waitForSyncedState()` never
  resolved and the run hung. `npm install` runs
  `scripts/patch-wallet-sdk.mjs` (also `npm run patch:sdk`), which restores the
  retry and logs `WS_RECONNECT: closed <code>` / `WS_RECONNECT: opened` so the
  recovery is visible. The same patch prints the error the SDK otherwise
  flattens into `Wallet.Sync` (`RAW_WS_ERROR: … code=1006 … CloseEvent`).
- `deploy` waits for the faucet (default 30 min, override with
  `MIDNIGHT_FAUCET_TIMEOUT_MS`) and for DUST (default 15 min,
  `MIDNIGHT_DUST_TIMEOUT_MS`). Interrupting here is cheap: the wallet has
  already synced and saved its state, so the next run skips the sync.
- Set `MIDNIGHT_WALLET_MNEMONIC` to reuse a wallet you already funded.

## Drive the chain from the agent

`npm run adapter` starts the REST service the agent's `local`/`testnet`
`MidnightClient` talks to (the contract in `docs/MIDNIGHT.md`). It owns the
wallet and the deployed handles, and turns each request into a real circuit
call:

```bash
npm run adapter &     # listens on http://127.0.0.1:6400
cd ../..
MIDNIGHT_PROOF_URL=http://127.0.0.1:6400 \
MIDNIGHT_CONTRACT_ADDRESS=$(node -e "console.log(require('./deploy/midnight-devnet/deployment.json').memoryVault.address)") \
node packages/midnight/scripts/adapter-roundtrip.mjs
```

That drives the agent's own client through a real commit → attest round-trip.

## Web console

The adapter also serves a runnable console at <http://127.0.0.1:6400>:

- commit a memory — the browser hashes it locally and sends only the digest and
  a random salt, so the words never leave the page;
- see the live on-chain state (commitments, attestations, nullifiers) read from
  the indexer;
- generate a selective-disclosure proof for any commitment and watch the tx.

## Simulator tests

`npm test` drives the vault circuits through the Compact runtime with no
network, proof server or wallet. It asserts the real semantics: bind-once
commitments, `persistentCommit` hiding, owner binding, single-use nullifiers and
revocation. `src/witnesses.ts` holds the private-state witness the circuits use.

## Tests (three layers)

| Command | Layer | Needs |
|---|---|---|
| `npm test` | circuits via the Compact runtime (simulator) | nothing |
| `npm run test:e2e` | deployed contract read through the indexer | running devnet |
| `npm run deploy` | full deploy + real commit → attest txs | running devnet |

`npm run setup` starts only what the target network needs, compiles both
contracts, and deploys. The local chain is ephemeral: `docker compose down -v`
wipes it and you get fresh ids.

### Services (local)

| Service | URL |
|---|---|
| Node RPC | `http://localhost:9944` |
| Indexer (GraphQL) | `http://localhost:8088/api/v4/graphql` |
| Proof server | `http://localhost:6300` |

The proof server runs locally on every network because it sees witness data in
the clear; the network never does.

## Deploy to a public testnet

Preprod and Mainnet are served by **Blockfrost** (the Midnight-hosted Preprod
endpoints were retired on 2026-10-09), so every request needs a token.

```bash
export BLOCKFROST_PROJECT_ID=nightpreprod…        # Midnight Preprod project
export MIDNIGHT_WALLET_MNEMONIC="…"               # a funded wallet, or leave unset to generate one
npm run setup -- --network preprod                # prints the faucet URL and waits for funding
```

The config appends the Blockfrost token to the indexer and node URLs for you
(`src/network.ts`). Fund the printed address from the
[Preprod faucet](https://midnight-tmnight-preprod.nethermind.dev), let NIGHT
register for DUST, then look the contract up on
[preprod.midnightexplorer.com](https://preprod.midnightexplorer.com/).

## Layout

- `src/wallet.ts`, `src/wallet-state.ts` — wallet construction and sync-state cache.
- `src/network.ts` — per-network endpoints, wallet seeds, Blockfrost token wiring.
- `src/witnesses.ts` — the vault's Compact witness (private state).
- `src/deploy.ts` — deploys both contracts and runs commit → attest.
- `src/adapter.ts` — the REST service the agent's runtime client calls, plus the console.
- `src/secret.ts` — the deterministic owner secret shared by deploy and adapter.
- `public/index.html` — the runnable web console.
- `test/vault.sim.test.ts` — simulator tests over the compiled circuits.
- `scripts/e2e-check.ts` — reconnects and asserts on-chain state.
- `docker-compose.yml` — the local node, indexer and proof server.

## Notes

- **Runtime dedupe.** `overrides` pins `@midnight-ntwrk/onchain-runtime-v3` to a
  single version. With two copies present, Midnight.js rejects the contract's
  `StateValue` with `expected instance of StateValue`.
- **Circuit return values** are read from `call.private.result`, not
  `call.public.result` (the public side carries the transcript and next state).
- The private-state encryption password defaults to a local-devnet placeholder;
  set `PRIVATE_STATE_PASSWORD` for anything non-local.
- Never commit `.midnight-wallet-state/`, `.midnight-seed.json`, or a real seed.
