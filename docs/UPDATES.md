# Updates in this wave

This wave took Seal from contracts on a local devnet to a **deployed agent on
Midnight Preprod** that a stranger can text: the contracts produce real
transactions, the agent runs from this repository on a VM with no laptop
attached, and its iMessage surface is wired to the ledger. This wave also closed
out the submission requirements: Apache 2.0, provenance, compiled artifacts and
the deck.

## 1. Two Compact contracts

Compact 0.31.1, language 0.23.

- `memory-vault` — commit, attest, revoke. Opaque commitments, selective-disclosure
  attestations, nullifiers for single-use proofs, hidden category commitments.
- `allowance-registry` — owner-bound spend limits enforced **in-circuit**, so the
  limit holds outside the agent's own code.

## 2. Live Preprod run, 2026-10-16

Captured in `deploy/midnight-devnet/deployment.json`. All of these are real
Preprod transactions:

| Step | Value | Block |
|---|---|---|
| `memory-vault` deployed | contract `6e9d608a997d5642564cbaea2b0a93a45fae0b806ee5fb68e8e0b008c2f19f7f` | 3000850 |
| private memory committed | commitment `1443be15786d3ea083d668070d79ed3879399a710a81db624b564569329a6ac1` | 3000856 |
| selective-disclosure proof, category `health` | attest tx `0018f9a0486ddc5ecf924e0e7f1c33115d63433b9549b97d4a82b8ec264c78ecb2` | 3000862 |
| same attestation, public id | `c91ebd08d0010b1a1aac921345ba5fe69354b87e910d346dd753573e7d352145` | 3000862 |
| `allowance-registry` deployed | contract `fd4bfac0d1ae522793050401ee9021bc7dfe27767745f5a3e954d15895d4afb1` | — |

The committed memory was `"I take medication X daily"`. The plaintext never left
the device: Preprod holds one commitment, one attestation and one nullifier.

Note the two hashes on the third and fourth rows are the same event — the
attestation *transaction* and the attestation *id* the verifier uses. Earlier
write-ups mixed them; the verifier takes the id.

## 3. Agent wiring

The agent commits memories, answers verify requests, and routes every gated spend
through the allowance gate, which **fails closed** when the ledger is unreachable.

## 4. Reliability: the Preprod sync fix

The SDK pinned `shouldRetry: () => false`, so one dropped indexer socket was
permanently fatal, and because wallet state is written only after a completed
sync, every restart began again at genesis. An idempotent patch restores
reconnect, and progress, stall and checkpoint logging make the first sync
resumable.

The first Preprod sync applies ~1.66M dust events and took about **17 hours**. It
recovered **30 indexer transport errors and 6 stalls**, the longest 479 minutes
with no progress, without resyncing from genesis. Before the fix, the first of
those would have ended the run.

## 5. Verifier path

`POST /verify` and `GET /verify/<attestationId>` let anyone check a proof against
the ledger: **no wallet, no seed, no cooperation from the agent**. The verifier
can also hand the prover a challenge, so a proof cannot be replayed against a
different one. Unknown ids return `valid: false` and malformed ids are rejected
with a reason, so it is not a rubber stamp.

## 6. Submission requirements closed out

- **Apache 2.0** across the repository (`LICENSE`), with the upstream MIT license
  preserved as `LICENSE-MIT`. The dependency manifests and per-directory notices
  were brought in line.
- **Topics** include `midnightntwrk` and `midnight-network`.
- **Provenance**: the README states plainly what is new in this fork, with paths,
  first-commit dates (Oct 9–15, 2026) and the base commit it forked from (Oct 5).
- **Compiled contracts are committed**: `contracts/build/` and the prover keys
  under `deploy/midnight-devnet/contracts/managed/` were previously gitignored;
  they are now tracked, so the artifacts the buildathon asks for ship with the
  repo and `pnpm run contracts:check` passes from a clean clone.
- **The pitch deck ships as PDF** next to its PowerPoint source:
  `outputs/Seal-pitch-deck.pdf` (7 pages).

## 7. It runs, and judges can text it

The agent is deployed from this repository to a VM (the root `Dockerfile` is
what the platform builds). It is not a laptop session:

- the agent's identity is **@sealai**, reachable at `sealai@inkboxmail.com` and by
  iMessage;
- the container opens an Inkbox tunnel at `https://sealai.inkboxwire.com` and
  serves `GET /health` and `POST /webhooks/inkbox` on it, and nothing else;
- a live webhook subscription (`6f016093-df70-4507-9b90-b2f574a85225`) delivers
  `imessage.received` and seven related event types to that tunnel URL;
- the identity's webhook signing key is configured on the VM, so deliveries are
  verified before the agent acts on them.

One finding worth recording, because the documentation says otherwise: **no
admin key is needed for this.** An identity-scoped key can rotate its own webhook
signing key (`inkbox identity signing-key rotate <handle>`) and own its own
subscription. `docs/SELF-HOST.md` and `docs/INKBOX.md` claimed an org admin key
was required for an identity that already exists; that documentation bug is fixed.

## 8. Quality

- **987 tests pass across 10 packages, 0 failures** (verified 2026-10-18): core
  233, apps 147, inkbox 149, server 101, cli 84, gateway 67, payments 66, network
  65, computer 43, midnight 32. Plus the 13 Compact-runtime simulator tests and
  an indexer-backed end-to-end check in `deploy/midnight-devnet`.
- **CI is green on `main`**: `ci`, `secret-scan` and `build-images`. Both
  Dockerfiles were silently broken — they omitted the `packages/midnight`
  manifest, so the workspace build could not resolve it and the image build
  failed. Fixed and validated by building the image locally.
- **The gateway can adopt an existing identity** (`GATEWAY_ADOPT`,
  `GATEWAY_AGENT_ENV`), which is what let a deployed VM attach to the @sealai
  identity instead of minting a new one. Ten new tests.
- **The iMessage tunnel is driven, not just built.** `connect()` only builds an
  Inkbox tunnel listener; `serveForever()` is what dials the data plane, and
  nothing called it. The deployed agent therefore advertised its public tunnel
  URL, Inkbox logged every delivery against it, and not one of them arrived — the
  tunnel record read `currentlyConnected=false` for its whole life while the
  client happily printed a URL. `driveTunnel()` in `@open-instinct/inkbox` drives
  the listener and reports a fatal runtime error instead of rejecting the host;
  the server entrypoint and `instinct dev --tunnel` both use it. Four tests. With
  it, a replay of a real delivery answers `204`, the signature verifies against
  the identity's signing key, and the agent replies.
- **Only one live tunnel client per identity.** A second client (a laptop running
  `instinct dev --tunnel`, or a stray probe) takes the tunnel over; the superseded
  client stops reconnecting by design and needs a restart. Do not run a second one
  while the deployed agent is live.
- **The tunnel hop does not go through `fetch`.** With the runtime driven, every
  delivery still died as a `502 upstream-unreachable`. The SDK's `forwardTo` path
  proxies the request with `fetch`, and undici rejects the `content-length` header
  Inkbox forwards alongside a materialized body (`UND_ERR_INVALID_ARG: invalid
  content-length header`), so the webhook route never ran. The server and the CLI
  now pass an in-process Fetch handler that drives the loopback hop with
  `node:http`, forwarding the body byte-for-byte (the webhook signature is
  computed over those exact bytes) and re-deriving the framing headers on both
  sides. Four tests, including the regression case with an inbound
  `content-length`.

## 9. A guest agent, so anyone who texts gets an answer

The deployed agent is one person's agent, and it behaves like one. An unknown
number is a `stranger`: the prompt tells it to introduce itself once, offer to
pass a message to the owner and run no tasks. That is the correct behaviour for a
private agent, and it is why a judge texting @sealai got a polite brush-off.

For a judged demo we want the opposite, without opening the owner's agent. So the
core grew a **public demo mode**, and the demo runs as its own agent:

- `INSTINCT_AGENT_PUBLIC=1` (seeded into `config.agent.public`) marks an agent as
  a public surface. Unknown senders become **guests**: `converse` opens from
  `intro` to a full conversation, `memory.write` and `web.read` open, and the
  stranger rate limits rise from 3 conversations a day to 50. Everything about
  the owner stays closed: their profile, location, calendar, mail, contacts,
  plans, spend, files, computer and `network.*` capabilities are denied to a
  guest exactly as they are to a stranger, so a prompt injection into a public
  agent cannot reach the owner or the host.
- The prompt follows the policy, so the model is told it is a demo agent talking
  to a guest rather than a stranger to turn away.
- Flags are seed-only, like the other `INSTINCT_*` variables, and a tier written
  into `policy.json` is merged over the guest row instead of replacing it.

The plan is one identity and one VM for the guests, separate from the owner's
agent, so guests share that agent and its memory and never the owner's. Two
platform limits shape it, both verified on the account:

- the free plan allows **3 agents and 1 awake machine**. Waking the second agent
  returned `200` and put the primary to sleep, and starting the primary while the
  second was awake returned `429`. One agent is awake at a time, so the demo agent
  is woken before a judged window and the owner's agent sleeps meanwhile.
- creating an identity needs either an Inkbox **org admin key** (the Inkbox
  Console can mint one) or the **agent self-signup** flow, which needs no key and
  only a human confirming a code by email. An identity-scoped key gets `403` on
  identity creation: it manages its own identity and nothing else.

## How judges test the agent

1. Text **`connect @sealai`** to the Inkbox router at **+16504849720** (or, to
   test the memory vault directly, email `sealai@inkboxmail.com`).
2. Ask it to remember something, then ask it to prove a fact about that memory.
   The plaintext stays on the host; the reply is a proof reference you can check
   yourself.
3. Verify a proof with no wallet: run `instinct midnight verify <attestationId>`
   or read the public `GET /verify/<attestationId>`. A valid proof reports the
   disclosed category and that it is single-use; an unknown id reports invalid.

Two caveats, stated plainly:

- The VM runs on an `always_on` tier but with an **auto-sleep** policy. A message
  that arrives while the VM is asleep does not reach the agent. Turning sleep off
  is a paid add-on (`POST /agents/{id}/resize {"always_on": true}` answers
  `402 ... need a paid plan`), so we wake the agent before a judged window
  instead, and keep-awake is item 1 below.
- Every delivery is logged, and a delivery that arrived while the agent was
  asleep is recoverable: `inkbox webhook delivery list` then
  `inkbox webhook delivery replay <delivery-id>`. We exercised exactly that
  during the build — an email delivered at 10:42 while the VM was asleep
  recorded `502`, and replaying it after the wake produced `204` and a full
  model-written reply. No judge message is lost.

## What is next to build

1. **Keep the agent reachable.** A judged window should not depend on a sleep
   timer: either set the agent to never sleep where the platform allows it, or add
   reconnect-on-wake to the tunnel client so a resumed VM re-establishes its
   tunnel by itself, and a wake-on-delivery path so an inbound message can wake
   the VM rather than being dropped.
2. **The no-wallet web demo.** The read-only verifier is the most persuasive part
   of this project and it needs no wallet: turn `GET /verify/<id>` plus the
   adapter console into a hosted page that takes an attestation id and shows the
   ledger check. That is what judges and future users will click.
3. **First beta users texting Seal.** Real people committing real memories, with
   the privacy model under load — the plaintext, the categories and the
   nullifiers as they behave outside a demo.
4. **The spend gate guarding real purchases.** The circuit already refuses
   over-limit spends; the next step is a real payment rail behind it, so the
   failure mode is a declined purchase rather than a declined assertion.
5. **Mainnet.** The contracts are unchanged; mainnet is a network configuration
   and a fresh wallet. The current Preprod seed was exposed during development and
   must not be reused.
6. **Correct the admin-key documentation** and rotate development credentials.
