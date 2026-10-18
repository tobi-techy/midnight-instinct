# Akindo Wave Hacks: entry text, paste-ready

Everything the entry asks for, in the order the form asks for it. Fields that can only be
filled after the deploy or the recording are marked **FILL IN**.

## Tagline (one line, no trailing period)

> A personal agent you text that remembers privately and proves it on Midnight.

## Short description

> Seal is a privacy-first personal agent. You text it on iMessage; it remembers what you tell
> it, and it can prove facts about those memories on Midnight without revealing them. The
> memory text never leaves your machine: the chain holds a commitment, a category attestation
> you chose to disclose, and a single-use nullifier.

## What is new here

> Two Compact contracts (`memory-vault`, `allowance-registry`), an agent-facing Midnight client
> with per-sender vault scopes, a verifier anyone can use with no wallet and no seed, and a
> spend limit a circuit enforces rather than an agent's own code.

## Links

| Field | Value |
|---|---|
| GitHub repository | https://github.com/tobi-techy/midnight-instinct |
| Submission brief | https://github.com/tobi-techy/midnight-instinct/blob/main/docs/SUBMISSION.md |
| Live demo (the agent's verifier) | https://sealai.inkboxwire.com/verify |
| Pre-filled proof link (issued by the live agent) | https://sealai.inkboxwire.com/verify/6910e607567598e110eb582693b7e757e856375db84bd3479bcc7b4fd643ac3c |
| Landing page | **FILL IN** if you have a hosted page; the README above is the fallback. |
| Video | **FILL IN** after recording (target 2:30, shot list: `docs/DEMO-VIDEO.md`) |
| Contracts on Preprod | `memory-vault` `6e9d608a997d5642564cbaea2b0a93a45fae0b806ee5fb68e8e0b008c2f19f7f`; `allowance-registry` `fd4bfac0d1ae522793050401ee9021bc7dfe27767745f5a3e954d15895d4afb1` |
| Recorded Preprod proof | attestation `c91ebd08d0010b1a1aac921345ba5fe69354b87e910d346dd753573e7d352145`, verified read-only by the adapter |
| Tests | 1011 across 10 packages, 0 failures, plus 13 Compact-runtime simulator tests |

## How it works

> Your words stay in `MEMORY.md` on the host. A 32-byte hiding commitment to each memory goes
> to Midnight when you ask it to remember something. When you ask it to prove a fact, the
> circuit emits a selective-disclosure attestation: the verifier learns whether the memory
> exists and at most one category you chose, and the attestation carries a nullifier so it
> cannot be replayed. Allowances are the same idea applied to money: the owner authorizes a
> ceiling on chain, the circuit refuses anything over it, and the agent fails closed when the
> ledger cannot be reached.

## Judge steps (three steps, copy this verbatim)

1. **Text the agent.** Send `connect @sealai` to **+16504849720** on iMessage (or email
   `sealai@inkboxmail.com`), then ask it to remember something private. It confirms without
   echoing the text back anywhere public.
2. **Ask it to prove.** "Prove that you remember it, without telling me what it says." It
   replies with an attestation id and a link.
3. **Check the proof yourself.** Open the link, or paste the id at
   https://sealai.inkboxwire.com/verify. No wallet, no seed, no cooperation from the agent:
   the page reads the ledger and reports whether the attestation is recorded, which single
   category it disclosed, and that it is single-use. An unknown id reports `valid: false`.

Two things stated plainly, because judges deserve them:

- The live agent anchors in `mock` mode, so its own proofs are real hashes and real
  single-use nullifiers with no transaction submitted; the verify page says so on every
  check. The on-chain evidence is the recorded Preprod run (contracts above, attestation
  `c91ebd08…`), reproducible from `deploy/midnight-devnet/`.
- The agent wakes on demand and can sleep between windows. If a message goes unanswered,
  send one more; deliveries are logged and replayable, so nothing is lost.

## Long description (if the form has a big field)

> Seal is a personal agent you reach over iMessage and email, built on Open Instinct. It keeps
> a durable memory of what you tell it, and this fork gives that memory a privacy layer on
> Midnight: two Compact contracts, a shielded vault and an owner-bound allowance registry.
>
> When you ask it to remember something private, it saves the text locally and anchors a
> hiding commitment on chain. When you ask it to prove a fact about that memory, it emits a
> selective-disclosure attestation that reveals one bit of meaning at most, plus a nullifier
> that makes the proof single-use. Verification needs no wallet, no seed and no cooperation
> from the agent: an HTTP GET against the ledger answers whether the attestation is recorded,
> what it disclosed and whether it was already spent.
>
> Spending runs through the same discipline. An allowance is a ceiling the owner authorizes on
> chain; the circuit refuses an over-limit spend with a failed assertion, so even a
> prompt-injected agent cannot talk its way past it, and the runtime fails closed when the
> ledger is unreachable.
>
> What is deliberately not claimed: the live demo agent anchors in mock mode, and the chain
> half of the story is a recorded Preprod run of both contracts, shipped in `docs/SUBMISSION.md`
> with addresses, transaction counts and the raw verifier transcript.
