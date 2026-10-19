# Demo video: shot list

Target 2:30. Record the screen, no face. Have the adapter already synced and warm before you
hit record, so nothing waits on a wallet sync.

## Before you record

```bash
# 1. Preprod adapter, warm (the wallet restores from checkpoints in a few minutes)
cd deploy/midnight-devnet
export $(grep -v '^#' .env.preprod | grep . | xargs)
npx tsx src/adapter.ts --network preprod     # wait for: vault handle ready / allowance handle ready

# 2. Terminal for the verify and allowance commands, same repo root
export MIDNIGHT_MODE=testnet
export MIDNIGHT_PROOF_URL=http://127.0.0.1:6400
export MIDNIGHT_CONTRACT_ADDRESS=6e9d608a997d5642564cbaea2b0a93a45fae0b806ee5fb68e8e0b008c2f19f7f
```

Have your phone mirrored or filmed alongside, with the Seal iMessage thread open. Have the
agent's own verifier open in a browser tab too (`https://sealai.inkboxwire.com/verify`); it
needs no adapter, because that agent verifies its own proofs, and the front door already
prefills the newest one (at the time of writing,
`https://sealai.inkboxwire.com/verify/6910e607567598e110eb582693b7e757e856375db84bd3479bcc7b4fd643ac3c`).

It does need the agent awake, because the agent serves the page:

```bash
cd ~/Development/open-instinct && set -a; . ./.env; set +a
A=143c0b5a-76a2-45b8-99e3-243151901a09
curl -s -m 20 -o /dev/null -w 'health %{http_code} ' https://sealai.inkboxwire.com/health
curl -s -m 20 -o /dev/null -w 'verify %{http_code}\n' https://sealai.inkboxwire.com/verify
```

Both must read `200` before you roll. `000` means the VM is asleep: send the agent one
iMessage and re-run; it answers `200` within seconds of a wake.

## The notebook beat: the exact commands

There is no shell on the VM, so show the files through the Maritime files API. This prints
one person's notebook, then the host's own, which is the whole isolation claim on screen:

```bash
cd ~/Development/open-instinct && set -a; . ./.env; set +a    # loads MARITIME_API_KEY; without it every call answers "Not authenticated"
A=143c0b5a-76a2-45b8-99e3-243151901a09
H=$(curl -s -m 20 "https://api.maritime.sh/api/agents/$A/files/list?path=/data/memory/people" \
     -H "authorization: Bearer $MARITIME_API_KEY" | python3 -c 'import json,sys;print(json.load(sys.stdin)["entries"][0]["name"])')
echo "--- this person's notebook ---"
curl -s "https://api.maritime.sh/api/agents/$A/files/download?path=/data/memory/people/$H/MEMORY.md" -H "authorization: Bearer $MARITIME_API_KEY"
echo "--- the host's own notebook ---"
curl -s "https://api.maritime.sh/api/agents/$A/files/download?path=/data/memory/MEMORY.md" -H "authorization: Bearer $MARITIME_API_KEY"
```

Run it as one paste: each new terminal starts without the environment, and a missing
`MARITIME_API_KEY` looks like a failure (`{"detail":"Not authenticated"}`) rather than an
unset variable.

## The shots

| Time | On screen | Say |
|---|---|---|
| 0:00-0:15 | The repo README, Seal lockup | "Seal is a personal agent you text. It remembers for you, and proves things about your memories on Midnight without revealing them." |
| 0:15-0:35 | Phone: text Seal a private fact. If you have a second number, have a second person text it too, then run the notebook beat above | "Everyone who texts Seal gets a personal agent of their own: a notebook of their own on this host, one per person, and a vault scope of their own. One person's notes never mix with another's, and none of mine are in the host's. I tell it something private here." |
| 0:35-0:55 | Terminal: the commit lands | "That memory is saved on my device and anchored on Midnight as an opaque commitment. The words never leave this machine." |
| 0:55-1:15 | `instinct midnight verify <attestationId>` | "Now a stranger checks the proof. No wallet, no seed, no cooperation from the agent." |
| 1:15-1:30 | The verify output, then the same id on the hosted page in a browser | "Valid health proof, single-use. It reveals the category I chose and nothing else, and it cannot be replayed. A stranger opens the link the agent put in its reply and sees the same read — the page is public and read-only, and it says which mode the agent is in." |
| 1:30-1:50 | The allowance commands, live | "Here is the part a policy file cannot promise." authorize $50, spend $20, then attempt $40. |
| 1:50-2:05 | `failed assert: over allowance` | "Refused by the circuit, not by the agent's code. Even a prompt-injected agent cannot talk its way past it." |
| 2:05-2:20 | README two-ledger diagram | "One ledger holds commitments and limits. The other holds my actual words. That split is the whole product." |
| 2:20-2:30 | Preprod addresses on screen | "Both contracts are live on Preprod, with 1015 tests behind them. The repo and the verify transcript are public." |

## If you only have 60 seconds

Cut the allowance beat and the Preprod addresses; keep the personal-agent half, which is
the part nobody else in the room has:

| Time | On screen | Say |
|---|---|---|
| 0:00-0:08 | Phone: you text Seal a private fact | "Seal is a personal agent you text. I tell it something private." |
| 0:08-0:20 | Terminal: the notebook beat above, both `MEMORY.md` files, side by side | "Everyone who texts it gets their own notebook on the host. Mine is mine; the host's is untouched. No other agent does this." |
| 0:20-0:32 | Terminal: `instinct midnight verify <attestationId>` | "It can prove a fact about that memory without revealing it, and a stranger checks the proof with no wallet and no seed." |
| 0:32-0:45 | The same id on the hosted page in a browser | "Single-use, one category, and the page says the mode honestly. The chain never sees the words." |
| 0:45-0:60 | README two-ledger diagram, then the repo | "Commitments and limits on one ledger, my actual words on my machine. Both contracts are live on Preprod, with 1015 tests behind them." |

## If something goes wrong mid-take

- **No reply while rolling.** Do not restart. Say "the agent sleeps when idle; watch this",
  send a second message. It wakes and answers, and it reads as deliberate rather than broken.
- **The verify page does not load.** The agent went back to sleep. Send a message, reload.
- **A proof fails.** Read what the page says and say so plainly. Never dress it up.

## What to say, and what not to

- Say **mock mode** once, out loud, the way the page does. The on-chain evidence is the
  recorded Preprod run; claiming a live transaction is the one line a judge can catch.
- Never show the host's chat surface or the admin API on screen.
- The strongest sentence available is the isolation one: *one person's notes never enter
  another person's notebook or the host's*, and the notebook beat proves it on screen with
  two files.

## Exact commands for the two live beats

Verify (expect the validated output):

```bash
instinct midnight verify c91ebd08d0010b1a1aac921345ba5fe69354b87e910d346dd753573e7d352145
```

Allowance, using a 64-hex key (any 32 bytes; this one is `sha256("seal-demo-1")`):

```bash
K=$(python3 -c "import hashlib;print(hashlib.sha256(b'seal-demo-1').hexdigest())")
A=http://127.0.0.1:6400
curl -s -X POST $A/allowance/authorize -H 'content-type: application/json' -d "{\"key\":\"$K\",\"maxAmount\":5000}"; echo
curl -s -X POST $A/allowance/check     -H 'content-type: application/json' -d "{\"key\":\"$K\"}"; echo
curl -s -X POST $A/allowance/spend     -H 'content-type: application/json' -d "{\"key\":\"$K\",\"amount\":2000}"; echo
curl -s -X POST $A/allowance/check     -H 'content-type: application/json' -d "{\"key\":\"$K\"}"; echo
curl -s -X POST $A/allowance/spend     -H 'content-type: application/json' -d "{\"key\":\"$K\",\"amount\":4000}"; echo
```

The last line must read `{"error":"... failed assert: over allowance"}`. If you re-run the whole
sequence, use a fresh key (change the string in the hash) or the authorize step will see an
allowance that already spent $20.

## One line to say out loud

Mandate proves an agent's budget. Seal keeps the agent's whole memory private and proves facts
about it.
