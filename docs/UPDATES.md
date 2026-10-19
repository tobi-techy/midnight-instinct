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

- **1014 tests pass across 10 packages, 0 failures** (verified 2026-10-18): core
  236, apps 147, inkbox 149, server 110, cli 84, gateway 67, payments 66, network
  65, computer 43, midnight 47. Plus the 13 Compact-runtime simulator tests and
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

## 9. A public agent, so anyone who texts gets their own agent

The agent is one person's agent, and it behaved like one. An unknown number is a
`stranger`: the prompt tells it to introduce itself once, offer to pass a message to
the owner and run no tasks. That is the correct behaviour for a private agent, and it
is why a judge texting @sealai got a polite brush-off.

For a judged demo we want the opposite, without opening the owner's data. So the core
grew a **public mode**, and the deployed agent now runs it:

- `INSTINCT_AGENT_PUBLIC=1` (seeded into `config.agent.public`) marks an agent that
  answers anyone who messages it. An unknown sender gets a personal agent here:
  `converse` opens from `intro` to a full conversation, `web.read` opens, `memory.write`
  opens into a notebook of their own (section 13), the vault opens in their own scope
  (section 10), and the stranger rate limits rise from 3 conversations a day to 50.
  Everything about the owner stays closed: their notebook, profile, location, calendar,
  mail, contacts, plans, spend, files, computer and `network.*` capabilities are denied
  to a sender exactly as they are to a stranger, so a prompt injection into a public
  agent cannot reach the owner or the host.
- The prompt follows the policy, so the model is told it is a personal agent that
  belongs to whoever is talking, with that person's own notebook, rather than a demo
  the person is only trying out.
- The end-to-end smoke test (`pnpm smoke`, the real app booted with Pi's faux model)
  covers the sender path: the same unknown number that is turned away on a private agent
  gets a conversation, a note filed in their own notebook, a scoped vault commit, a
  proof, and a verifier page that answers over the tunnel listener, while the prompt
  still carries no owner contact details. A second unknown number gets a second
  notebook, and neither can see the other's.
- `INSTINCT_AGENT_NAME` and `INSTINCT_AGENT_PUBLIC` now override an existing
  `config.json`, the way `INSTINCT_MODEL` already did. Without that, a hosted agent
  could not be renamed or opened by the platform running it: the flags were silently
  ignored because the file wins on every later boot.
- The voice is kept in the repository (`deploy/demo-agent/PERSONA.md`) and installed as
  the deployed agent's `PERSONA.md`, because `INSTINCT_PERSONA` only seeds a first boot
  and this agent already had one.

**One agent, a notebook per person; no second identity.** The first plan was a second
identity and a second VM for the public side, and it is dropped. It needed an Inkbox org
admin key, and the free plan allows **3 agents and 1 awake machine**: waking the second
agent returned `200` and put the primary to sleep, while starting the primary while the
second was awake returned `429`. One agent is awake at a time, so a separate demo agent
would have meant waking it before every judged window and leaving the owner's agent
asleep anyway. The deployed agent is the public one instead: it has no owner memory and
no owner phone configured, so the sender path is the only path anyone reaches, and there
is nothing private behind it. What separates people is not a second process but the
notebook each of them gets (section 13).

That leaves the sleep caveat, which is real and documented for judges: a message that
arrives while the agent is asleep does not reach it, the delivery records `502`, and
replaying it after a wake (`inkbox webhook delivery list`, then
`inkbox webhook delivery replay <delivery-id>`) produces the reply. Turning sleep off is
a paid add-on, so we wake the agent before a judged window instead.

## 10. The vault, for whoever is talking

The submission tells judges to "ask it to prove a fact about that memory", and on a
private agent only the owner can: `vault_commit` and `vault_prove_reveal` refused
anyone else, so that step failed on a public agent. Three changes fixed it.

- A new `vault.write` capability carries the two vault tools. `memory.write` is the
  notebook, and opening it is a separate decision with a separate answer (section 13):
  it also gates `memory_read`, so opening it carelessly is how a sender would reach the
  owner's `MEMORY.md`.
- On a public agent, anyone who texts may commit and prove inside a vault scope of their
  own. `MidnightClient` records the scope on the commitment and binds the salt to it, so
  two people anchoring the same words with the same salt still get different
  commitments. Nobody can prove another scope's commitment, the state file stores a hash
  of the sender rather than the sender, and a committed plaintext never enters the
  owner's notebook: it stays in the conversation. `vault_status` and `allowance_check`
  stay owner-only.
- The proof reply hands over the whole attestation id instead of a truncated one, and the
  Midnight guidance and the persona say to quote it so the other side can verify.

The end-to-end smoke test covers the sender path with the vault wired in mock mode: the
sender's note is anchored, `midnight.json` holds one scoped commitment, the owner's
`MEMORY.md` stays clean, and the prompt lists both `vault.write` and `memory.write` —
the latter pointing at that person's own notebook.

## 11. A verifier link a judge can click

The verifier already existed as a CLI command and as the adapter's `GET /verify/<id>` at
`127.0.0.1:6400` — useful to us, invisible to anyone else. The agent now serves the read
itself:

- `GET /verify/<attestationId>` on the agent, next to `/health`. A browser gets a page: what
  the id is, whether the ledger holds it, which single category it disclosed, that it is
  single-use, and the mode it ran in. Anything else gets the same facts as JSON. An unknown
  id is `valid: false` with a `404` rather than an error, and an id that is not 64 hex never
  reaches the ledger.
- The route is one of the three the Inkbox tunnel exposes (`isTunnelRoute`), so
  `https://<handle>.inkboxwire.com/verify/<id>` works from any browser. This is safe by
  construction: verifying a proof reveals only what the prover chose to disclose. `/chat`,
  `/status`, `/schedules`, `/midnight/status` and the OAuth callbacks still answer `404` on
  the tunnel listener, which the smoke test asserts.
- `GET /verify` is the front door: a form prefilled with the newest attestation this agent
  issued, so a reader always has a proof to check. `GET /verify?id=<64 hex>` hands off to the
  proof page, which is how a reply, a slide or a bookmark carries a pre-filled link. It is
  live at `https://sealai.inkboxwire.com/verify`.
- `MIDNIGHT_VERIFY_URL` (the agent's tunnel host) puts the link in the proof reply next to
  the attestation id, and the Midnight guidance tells the model to hand over both. Without
  it, replies carry the bare id exactly as before.

Honest about what it proves: in `mock` mode the commitment is a real sha256 and the
nullifier is real, but no transaction was submitted, so the page says so in as many words.
On `local`/`testnet` the page is a read through the adapter to the ledger. Either way the
plaintext never leaves the host.

The smoke test now runs the whole loop: an unknown number commits a memory as themselves, asks
for a proof, and the proof is then checked through the tunnel listener — JSON and page — with
the owner's surface still hidden.

## 12. What runs where, and what it proves

Worth stating without decoration, because a judge will ask:

- **The deployed agent anchors in `mock` mode.** Its commitments are real sha256
  commitments, its nullifiers are real single-use nullifiers, and its vault scope per sender
  is real; the only thing missing is a submitted transaction. The verifier page says so in
  as many words on every check, so nothing overstates what a link proves. Live example from
  the deployed agent: `https://sealai.inkboxwire.com/verify/6910e607567598e110eb582693b7e757e856375db84bd3479bcc7b4fd643ac3c`
  reports `valid: true`, `disclosed: health`, `singleUse: true`, `mode: mock`.
- **The deployed agent is a public agent.** It is named Seal, runs
  `INSTINCT_AGENT_PUBLIC=1`, and its `PERSONA.md` is the voice in
  `deploy/demo-agent/PERSONA.md`, so an unknown number gets a personal agent with their
  own notebook and the vault rather than a stranger with a brush-off. Both
  `INSTINCT_AGENT_NAME` and `INSTINCT_AGENT_PUBLIC` now override an existing
  `config.json` the way `INSTINCT_MODEL` already did — without that, a hosted agent could
  not be renamed or opened by the platform running it.
- **The chain evidence is the Preprod deployment of 2026-10-16.** Both contracts are live
  (`memory-vault` `6e9d608a…`, `allowance-registry` `fd4bfac0…`), Preprod holds the
  commitment `1443be15…` to `"I take medication X daily"`, one health attestation
  `c91ebd08d0010b1a1aac921345ba5fe69354b87e910d346dd753573e7d352145`, and its nullifier. The
  recorded `instinct midnight verify` output and the raw `GET /verify/…` JSON are in
  [SUBMISSION.md](SUBMISSION.md).
- **Why the agent is not pointed at Preprod itself.** The adapter needs the ZK proof server
  (6300) plus a Blockfrost-backed indexer and a funded wallet, it listens on `127.0.0.1:6400`,
  and the first indexer sync applies ~1.66M dust events (17 hours on this machine). A
  Maritime VM reaches none of that, and `MIDNIGHT_MODE=testnet` without a reachable adapter
  would fail every commit. Pointing the agent at a chain is a configuration change, not code:
  set `MIDNIGHT_MODE=testnet`, `MIDNIGHT_PROOF_URL=<adapter>`,
  `MIDNIGHT_CONTRACT_ADDRESS=6e9d608a…` and the same `MIDNIGHT_VERIFY_URL`, and the verifier
  page starts reading Preprod — including the recorded `c91ebd08…` id.

So the demo runs end to end on the live agent (commit, prove, public verify) and the chain
half of the story is the recorded Preprod run, reproducible from `deploy/midnight-devnet/`.

## 13. A notebook per person, so "personal" is literal

The last thing that did not fit the pitch: the agent answered everyone, but it kept one
memory. Two people texting it shared a notebook, and a sender's notes had nowhere to go at
all, because `memory.write` was the owner's file. "A personal agent" should mean what it
says, so memory is now one notebook per person.

- `MemoryStore.forPerson(state, key)` puts a person's notebook at
  `memory/people/<sha256(key)[0:32]>/MEMORY.md`, with their journal beside it under
  `journal/`. The folder name is a hash, so a directory listing does not spell out who
  they are. `key` is the person's address when they have one (their phone or email) and
  their principal id otherwise, so the same phone keeps one notebook whether it is a
  stranger or a saved contact.
- The store is resolved per principal, in two places that cannot be bypassed:
  `coreTools` takes a `memoryFor(principal)` resolver, and `memory_read`, `memory_write`
  and `journal_append` use it for every read and write. The owner always resolves to the
  owner's store whatever the resolver says, so the resolver only ever has to know how to
  key a non-owner. `boot.ts` wires it on a public agent and leaves it out on a private one.
- The prompt follows: on a public agent a non-owner gets *their own* notebook in the system
  prompt under `## <name>'s notebook (kept for them on this host)`, with the instruction
  never to mix it with anyone else's or with the host's, and the owner's digest is not
  reachable from that conversation at all.
- `PUBLIC_GUEST_TIER` now opens `memory.write` for a sender on a public agent, exactly
  because that capability is now person-scoped. The owner's notebook stays closed: nothing
  in the tier table hands a non-owner the owner's store, and `owner.profile.preferences`
  is still denied.
- Tests prove the isolation rather than assuming it: `packages/core/test/memory.test.ts`
  (two people, two paths, same person the same path), `core-tools.test.ts` (the resolver
  sends a person's write to their own file, the owner's write to `MEMORY.md`),
  `runtime.test.ts` (person A's note appears in A's prompt and never in B's or the owner's,
  end to end through a real inbound message with the real tools registered), and `pnpm
  smoke` drives two unknown numbers through the HTTP surface and checks both notebooks plus
  the untouched `MEMORY.md`.
- The persona in `deploy/demo-agent/PERSONA.md` says it in the agent's own words: everyone
  who messages you gets a personal agent of their own here, with their own notebook on this
  host. `docs/PRIVACY-MODEL.md` and `docs/PERMISSIONS.md` describe where that notebook sits
  and what it does not touch.

Live evidence from the deployed agent, after a real iMessage from a number the agent had
never seen:

```
/data/memory/people/41b4d5882439a902ef8489798bb9dd31/MEMORY.md
  Alex mentions that they sail on weekends.

/data/memory/MEMORY.md          (the host's own notebook, unchanged)
  I take medication X daily.
```

One message, one new notebook, nothing of the sender in the owner's file and nothing of the
owner in theirs. The folder is the sha256 of their number, so a listing shows a hash rather
than who they are.

What this does not change: the owner's agent is still private by default (no `public`, no
notebooks for anyone else), and a notebook is a file on the same host, not an encrypted
store. A hosted public agent should be its own machine and its own identity — which is
exactly how the deployed one runs: `e8a73c0` is deployed to the live agent and CI is green
on it, so the verifier at `https://sealai.inkboxwire.com/verify` and the notebook path below
are the same build.

## How judges test the agent

1. Text **`connect @sealai`** to the Inkbox router at **+16504849720** (or, to
   test the memory vault directly, email `sealai@inkboxmail.com`).
2. Tell it your name and something it should remember, ask it what it knows about
   you, then ask it to prove a fact about a memory. The plaintext stays on the
   host; the reply is a proof reference you can check yourself.
3. Verify a proof with no wallet: open the link the reply gives you
   (`https://sealai.inkboxwire.com/verify/<attestationId>`) or run
   `instinct midnight verify <attestationId>`. A valid proof reports the
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
2. **The adapter console.** The agent hosts its own verifier now; what is still
   missing is the browse-all surface — a page on the proof-server adapter that
   lists recent attestations and their ledger state, for a judge who wants to
   look around instead of pasting one id.
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
