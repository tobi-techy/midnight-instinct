# Privacy model: exactly what is private and what is public

This is the precise answer to "which parts require privacy". Every piece of
data the system touches is listed below with its classification, where it
lives, why it needs that classification, and the mechanism that enforces it.

The guiding rule is **privacy by default, disclosure on purpose**: a value is
private unless a verifier must learn it, and it only becomes public through an
explicit `disclose()` at a ledger write or circuit return.

## Memory vault

| Data | Class | Where it lives | Why | Mechanism |
|---|---|---|---|---|
| Memory text | **Private** | Device / `MEMORY.md` | Revealing it defeats the product; it is the thing the owner is protecting | Never leaves the host or the browser; only its digest enters the circuit |
| Preimage (`sha256(text)`) | **Private** | Circuit input | A memory is often guessable, so a bare hash is brute-forceable | Fed to `persistentCommit(preimage, salt)`, which hides it |
| Salt | **Private** | Device | Hides the preimage so equal memories don't collide visibly and guesses can't be matched | 32 random bytes; the hiding value in `persistentCommit` |
| Owner secret | **Private** | Witness (device) | Links a commitment to its owner; leaking it lets others forge ownership proofs | Supplied by a witness; hashed into the owner binding |
| Commitment | Public (safe) | Midnight ledger | The anchor everyone references; opaque | `persistentCommit(preimage, salt)` output |
| Owner binding | Public (safe) | Midnight ledger | Lets the owner re-prove control without revealing who they are | `persistentCommit(ownerSecret, commitment)` |
| Category code (1–5) | **Disclosed on proof by choice** | Midnight ledger | This is the single fact the verifier asked for | `disclose(category)` in `attest` |
| Attestation nullifier | Public (safe) | Midnight ledger | Makes a proof single-use so it cannot be replayed | Set to `true` in `attest`; reuse is rejected |
| Revocation flag | Public (safe) | Midnight ledger | Lets the owner retire a memory | `active[commitment] = false` in `revoke` |

## Allowances (stretch)

| Data | Class | Why | Mechanism |
|---|---|---|---|
| Authorized maximum | **Public by design** | An allowance is a statement, like a card limit | `limits[key]`, written with `disclose(maxAmount)` |
| Running total | **Public by design** | Inferable from a public limit plus spends; we publish it honestly | `spent[key]` |
| Individual spend amount | **Public via the total** | Cannot be hidden while the running total is public; we disclose it rather than pretend | `disclose(amount)` in `spend` |
| The rule "never exceed the limit" | Enforced, not published | This is what the circuit guarantees | `assert(amount <= remaining)` |

## What is deliberately *not* protected

Honesty matters more than a longer table. These are outside the privacy
boundary:

- **Existence and timing.** The ledger shows that *some* commitment was made
  and when. It does not show whose or what.
- **The disclosed category.** A health proof tells the verifier the memory is a
  health note. That is the point of the proof.
- **Allowance amounts.** As above, public by construction.
- **Transport metadata.** Whatever the messaging channel (iMessage) and host
  expose is outside this layer.

## Threat model

| Adversary | Cannot | Because |
|---|---|---|
| A verifier | Learn the memory text or any other category | Only the disclosed category and a nullifier are written |
| A verifier replaying a proof | Reuse one attestation as two | The attestation id is nullified on first use |
| Another user of the same contract | Commit or attest against the owner's memories | Owner binding is a commitment to a witness-held secret |
| A prompt-injected agent | Overspend an allowance | The limit is enforced by the circuit, not by agent code |
| Someone with the ledger | Open a commitment | It is a hiding commitment; the preimage and salt stay local |
| The network | See witnesses | The proof server holds witnesses and runs on the owner's machine |
| Someone with the device | — | Device compromise reveals plaintext; the layer protects against the *network*, not the host. The host is the trust anchor. |

## Where each guarantee is implemented

- Contract: `contracts/memory-vault.compact`, `contracts/allowance-registry.compact`
- Witnesses: `deploy/midnight-devnet/src/witnesses.ts`
- Off-chain semantics: `deploy/midnight-devnet/test/vault.sim.test.ts` (simulator)
- Live transactions: `deploy/midnight-devnet/src/deploy.ts`, `src/adapter.ts`
