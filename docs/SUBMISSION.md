# midnight-instinct — submission brief

**One line.** A privacy-first personal agent: it remembers for you, and proves
things about your memories on Midnight without ever revealing them.

## The problem

People increasingly hand their memory to software: medications, finances,
relationships, private notes. Today that means a cloud database some operator
can read. The trust asked for is total, and it is unverifiable. The same is true
of an agent's spending: you either trust it or you don't.

## What we built

We took **Open Instinct**, a real personal agent you text on iMessage, and gave
it a shielded memory vault on Midnight. Three verbs:

1. **Commit** — a memory is saved locally and anchored as an opaque commitment
   on Midnight. The text never leaves the host.
2. **Prove** — the agent answers a yes/no question about a memory (does a health
   note exist?) by writing only a category code and a single-use nullifier.
3. **Spend** — allowances are enforced by a circuit, so a prompt-injected agent
   cannot exceed a limit.

The plaintext stays in `MEMORY.md`; the chain sees commitments, an owner
binding, a category code, and nullifiers. The full inventory is in
[PRIVACY-MODEL.md](PRIVACY-MODEL.md).

## Why this needs Midnight (and not just a database)

A normal private store can hide data from *others* but not prove anything about
it, and a normal chain can prove things but reveals the inputs. Midnight's
private state plus zero-knowledge proofs give both at once: the owner keeps the
plaintext, and a verifier gets a proof about it that reveals nothing else. The
commitment scheme is the platform's `persistentCommit`, and the privacy boundary
is enforced by the compiler via `disclose()`.

## Evidence it works

- Contracts compile with the Midnight Compact toolchain 0.31.1 (language 0.23):
  `pnpm run contracts:check`.
- **Real transactions** on a local Midnight devnet (node + indexer + proof
  server), captured in `deploy/midnight-devnet/deployment.json`:
  deploy vault, `commit`, `attest`, deploy allowance.
- The agent's own client drives the chain through a REST adapter:
  `packages/midnight/scripts/adapter-roundtrip.mjs`.
- Three test layers: Compact-runtime **simulator** tests (7), the agent's
  runtime tests (13), the server suite (97), plus an indexer-backed e2e check.
- A **runnable web console** at `http://127.0.0.1:6400` after `npm run adapter`.

## Mapping to the judging criteria

| Criterion | Where it shows |
|---|---|
| Engineering & implementation | `contracts/`, `packages/midnight/`, the adapter; genuine private state in `witnesses.ts` |
| Quality assurance & reliability | simulator tests, e2e chain check, existing suites; mock mode keeps demos alive |
| Product & vision | a working agent, not a demo dApp; commit/prove/spend is a coherent story |
| User experience & design | the primary UX is iMessage; a web console proves the same model visually |
| Communication | `docs/MIDNIGHT.md`, `ARCH-MIDNIGHT.md`, `PRIVACY-MODEL.md`, this brief |
| Business development & viability | allowances map to real spend-control demand; the vault is a reusable primitive |

## Viability and next steps

- **Preprod/Mainnet**: the same code moves by configuration (Blockfrost token,
  funded wallet). `deploy/midnight-devnet/README.md` documents it.
- **More circuits**: the adapter is generic over contract name, so a new private
  capability drops in without agent changes.
- **Selective disclosure as a product**: the vault is the first of several
  capabilities (spend limits, delegated proofs, agent-to-agent attestations)
  built on the same commit → prove pattern.
