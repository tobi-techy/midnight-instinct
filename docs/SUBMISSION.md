# Seal — submission brief

**One line.** A privacy-first personal agent: it remembers for you, and proves
things about your memories on Midnight without ever revealing them.

**Built for** the Akindo Wave Hacks buildathon, Midnight track. This repository
(`midnight-instinct`) is the submission.

## Authorship: a fork, and what is new in it

The base is [Open Instinct](https://github.com/mariagorskikh/open-instinct) by
Maria Gorskikh and contributors. That work is theirs and is carried over: the
agent runtime, the Inkbox identity and messaging layer, the trust tiers, the
gateway, the docs and the model plumbing.

Everything the buildathon asked for is new in this fork:

| New here | Where |
|---|---|
| Two Compact contracts. `memory-vault` holds opaque commitments and selective-disclosure attestations; `allowance-registry` holds owner-bound spend limits enforced by a circuit | `contracts/` |
| The agent-facing Midnight client, its tools and its private-state plumbing | `packages/midnight/` |
| Verifier path: `POST /verify` and `GET /verify/<attestationId>` on the adapter, and the agent's own read-only `GET /verify/<attestationId>` published through its tunnel, so a judge opens the link from a chat reply in a browser. Anyone checks a proof against the ledger with no wallet, no seed and no cooperation from the agent. A verifier can also hand the prover a challenge so a proof cannot be replayed for a different one | `deploy/midnight-devnet/src/adapter.ts`, `packages/midnight/src/client.ts`, `packages/server/src/http.ts`, `instinct midnight verify` |
| Allowance gate: `/allowance/check` plus a runtime check before every gated action (`purchase`, `travel.book`, `computer.use`, `apps.use`, `network.ask`) that fails closed when the ledger cannot be reached | `packages/core/src/runtime.ts`, `packages/core/src/policy.ts`, `packages/server/` |
| Preprod sync fix: the SDK pinned `shouldRetry: () => false`, so one dropped indexer socket was permanently fatal, and because wallet state is written only after a completed sync, every restart began again at genesis. An idempotent patch restores reconnect with a widened predicate, and progress, stall and checkpoint logging make a 17-hour first sync resumable | `deploy/midnight-devnet/scripts/patch-wallet-sdk.mjs`, `src/diagnostics.ts`, `src/progress.ts` |
| The LLM API gateway as a first-class model provider | `packages/core/src/model.ts`, `packages/server/src/boot.ts` |
| The Inkbox tunnel fix: `connect()` alone never dials the data plane, so a deployed agent advertised its tunnel URL and received nothing | `packages/inkbox/src/tunnel.ts`, `packages/server/src/main.ts`, `packages/cli/src/commands/dev.ts` |
| The tunnel hops over `node:http` instead of `fetch`, which rejected the `content-length` header Inkbox forwards with every delivery | `packages/inkbox/src/tunnel.ts` (`loopbackForwardHandler`) |

Commits on `midnight/main`: `d727522` (vault), `99d2172` (verifier and gate),
`8d6a61f` (sync fix), `88ceffe` (model gateway).

## The problem

People increasingly hand their memory to software: medications, finances,
relationships, private notes. Today that means a cloud database some operator
can read. The trust asked for is total, and it is unverifiable. The same is true
of an agent's spending: you either trust it or you don't.

## What we built

We took **Open Instinct**, a real personal agent you text on iMessage, and gave
it a shielded memory vault on Midnight. Four verbs:

1. **Commit** — a memory is saved locally and anchored as an opaque commitment
   on Midnight. The text never leaves the host.
2. **Prove** — the agent answers a yes/no question about a memory (does a health
   note exist?) by writing only a category code and a single-use nullifier.
3. **Verify** — anyone can check that proof against the ledger: no wallet, no
   seed, no cooperation from the agent. `instinct midnight verify <id>` reports
   the disclosed category and that the proof is single-use.
4. **Spend** — allowances are bound to their owner and enforced by a circuit, so
   a prompt-injected agent cannot exceed a limit. The runtime also checks the
   live allowance before a gated action runs, and fails closed if the ledger
   cannot be reached, so the limit holds outside the agent's own code.

The plaintext stays in a notebook: `MEMORY.md` for the owner, `memory/people/<hash>/MEMORY.md`
for anyone the agent talks to; the chain sees commitments, owner bindings,
a hiding commitment to each memory's category (the plain code appears only when
the owner attests it), and nullifiers. The full inventory is in
[PRIVACY-MODEL.md](PRIVACY-MODEL.md).

## Why this needs Midnight (and not just a database)

A normal private store can hide data from *others* but not prove anything about
it, and a normal chain can prove things but reveals the inputs. Midnight's
private state plus zero-knowledge proofs give both at once: the owner keeps the
plaintext, and a verifier gets a proof about it that reveals nothing else. The
commitment scheme is the platform's `persistentCommit`, and the privacy boundary
is enforced by the compiler via `disclose()`.

## Evidence it works

### On Preprod (public testnet), 2026-10-16

Real transactions, captured in `deploy/midnight-devnet/deployment.json`:

| Step | Artifact | Block |
|---|---|---|
| `memory-vault` deployed | `6e9d608a997d5642564cbaea2b0a93a45fae0b806ee5fb68e8e0b008c2f19f7f` | 3000850 |
| private memory committed | commitment `1443be15786d3ea083d668070d79ed3879399a710a81db624b564569329a6ac1` | 3000856 |
| selective-disclosure proof, category `health` | attestation `c91ebd08d0010b1a1aac921345ba5fe69354b87e910d346dd753573e7d352145` | 3000862 |
| `allowance-registry` deployed | `fd4bfac0d1ae522793050401ee9021bc7dfe27767745f5a3e954d15895d4afb1` | — |

The committed memory was the sentence `"I take medication X daily"` and the
plaintext stayed on the host. Preprod holds the commitment, one attestation and
one nullifier.

The first Preprod sync applies ~1.66M dust events and took about **17 hours**. It
survived **30 indexer transport errors and 6 stalls**, the longest of them 479
minutes with no progress, and recovered from every one on its own. Before the
sync fix, the first of those would have ended the run.

### Live verification, with no wallet

Against those Preprod contracts, reading the public ledger only:

```
$ instinct midnight verify c91ebd08d0010b1a1aac921345ba5fe69354b87e910d346dd753573e7d352145
Verified — valid health proof (single-use, cannot be replayed)
  disclosed: health (code 1)
  single-use: yes (cannot be replayed)
  public URL: http://127.0.0.1:6400/verify/c91ebd08d0010b1a1aac921345ba5fe69354b87e910d346dd753573e7d352145
```

The raw read-only endpoint, same run:

```json
GET /verify/c91ebd08d0010b1a1aac921345ba5fe69354b87e910d346dd753573e7d352145
{"attestationId":"c91ebd08d0010b1a1aac921345ba5fe69354b87e910d346dd753573e7d352145",
 "valid":true,"disclosed":1,"singleUse":true,
 "network":"preprod",
 "contractAddress":"6e9d608a997d5642564cbaea2b0a93a45fae0b806ee5fb68e8e0b008c2f19f7f"}
```

It is not a rubber stamp. An unknown id comes back `valid: false`, and a
malformed one is rejected with a reason:

```json
GET /verify/0000000000000000000000000000000000000000000000000000000000000000
{"valid":false,"disclosed":0,"singleUse":false,...}

GET /verify/nothex
{"valid":false,...,"reason":"attestationId must be 64 hex chars"}
```

### The allowance gate on Preprod

Same contracts, same run. Every line below is a real Preprod transaction except
the last, which never became one:

```
POST /allowance/authorize { key, maxAmount: 5000 }  -> { "txHash": "000c85c8939d4374eefb0e748010c2aed920b72d0c96c0ad857912a8009c741a4a" }
POST /allowance/check     { key }                   -> { "active": true, "limitCents": 5000, "spentCents": 0 }
POST /allowance/spend     { key, amount: 2000 }     -> { "txHash": "00cb331274b28067bd5766cdebb4faeb27cbcc117b9af10da50237ab22db994da7" }
POST /allowance/check     { key }                   -> { "active": true, "limitCents": 5000, "spentCents": 2000 }
POST /allowance/spend     { key, amount: 4000 }     -> { "error": "failed assert: over allowance" }
```

The last line is the point. `$20` of a `$50` allowance was spent; a further
`$40` was refused **by the circuit**, not by the agent's code and not by a policy
file the agent could talk its way around.

### Other evidence

- Contracts compile with the Midnight Compact toolchain 0.31.1 (language 0.23):
  `pnpm run contracts:check`.
- **1014 tests across 10 packages**: core 236, apps 147, inkbox 149, server 110,
  cli 84, gateway 67, payments 66, network 65, computer 43, midnight 47. Plus
  **13 Compact-runtime simulator tests** (`deploy/midnight-devnet`, 2 files) and
  an indexer-backed end-to-end check.
- The agent's own client drives the chain through the REST adapter:
  `packages/midnight/scripts/adapter-roundtrip.mjs`.
- **A verifier link a judge can click.** The deployed agent serves
  `https://sealai.inkboxwire.com/verify`: a read-only page (and the same JSON for
  anything that is not a browser) that answers whether an attestation is recorded,
  which single category it disclosed and whether it is single-use. The front door
  prefills the newest proof the agent issued, and every proof reply carries its own
  link. The live agent anchors in `mock` mode and the page says so on every check;
  the chain evidence is the recorded Preprod run above.
- A runnable web console is served by the adapter at `http://127.0.0.1:6400`
  after `npm run adapter` inside `deploy/midnight-devnet`.
- Committed local devnet artifacts (node + indexer + proof server, 2026-10-14)
  remain in git history for offline reproduction.

## Mapping to the judging criteria

| Criterion | Where it shows |
|---|---|
| Engineering & implementation | `contracts/` (two Compact contracts, private state, `disclose()` boundaries), `packages/midnight/`, the adapter, the verifier path; genuine private state in `witnesses.ts` |
| Quality assurance & reliability | 1014 tests plus 13 simulator tests and an indexer-backed e2e check; the sync fix and its diagnostic layer, proven by the 17-hour Preprod run |
| Product & vision | a working agent, not a demo dApp; commit, prove, verify, spend is a coherent story |
| User experience & design | the primary UX is iMessage; a web console proves the same model visually |
| Communication | `docs/MIDNIGHT.md`, `ARCH-MIDNIGHT.md`, `PRIVACY-MODEL.md`, this brief |
| Business development & viability | allowances map to real spend-control demand; the vault is a reusable primitive |

## What separates Seal from a budget-proving agent

A budget agent proves one thing: that a number stayed under another number. Seal
keeps the agent's **whole memory** private and can prove facts about any of it on
demand, with the same machinery gating what the agent may spend. The proof is
single-use, category-only, and checkable by a stranger with no wallet.

## Viability and next steps

- **Preprod is done**, not planned: both contracts are deployed and producing
  real transactions. Mainnet is the same code with a different network config.
- **More circuits**: the adapter is generic over contract name, so a new private
  capability drops in without agent changes.
- **Selective disclosure as a product**: delegated proofs, agent-to-agent
  attestations and spend limits all sit on the same commit, prove, verify shape.
