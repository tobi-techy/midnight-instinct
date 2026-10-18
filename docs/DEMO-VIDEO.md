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
works while the adapter is down, because that agent verifies its own proofs.

## The shots

| Time | On screen | Say |
|---|---|---|
| 0:00-0:15 | The repo README, Seal lockup | "Seal is a personal agent you text. It remembers for you, and proves things about your memories on Midnight without revealing them." |
| 0:15-0:35 | Phone: text Seal a private fact | "I tell it something private." Show the agent acknowledging it will keep it. |
| 0:35-0:55 | Terminal: the commit lands | "That memory is saved on my device and anchored on Midnight as an opaque commitment. The words never leave this machine." |
| 0:55-1:15 | `instinct midnight verify <attestationId>` | "Now a stranger checks the proof. No wallet, no seed, no cooperation from the agent." |
| 1:15-1:30 | The verify output, then the same id on the hosted page in a browser | "Valid health proof, single-use. It reveals the category I chose and nothing else, and it cannot be replayed. A stranger opens the link the agent put in its reply and sees the same read — the page is public and read-only, and it says which mode the agent is in." |
| 1:30-1:50 | The allowance commands, live | "Here is the part a policy file cannot promise." authorize $50, spend $20, then attempt $40. |
| 1:50-2:05 | `failed assert: over allowance` | "Refused by the circuit, not by the agent's code. Even a prompt-injected agent cannot talk its way past it." |
| 2:05-2:20 | README two-ledger diagram | "One ledger holds commitments and limits. The other holds my actual words. That split is the whole product." |
| 2:20-2:30 | Preprod addresses on screen | "Both contracts are live on Preprod, with 1011 tests behind them. The repo and the verify transcript are public." |

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
