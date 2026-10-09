/**
 * Deploy the Open Instinct contracts to a Midnight network and run a real
 * commit -> attest round-trip, capturing every transaction id.
 *
 * Default target is `undeployed`, the local devnet from docker-compose.yml
 * (node + indexer + proof server, genesis wallet pre-funded). Pass --network
 * preview|preprod to target a public testnet (those need a funded wallet; see
 * README.md).
 *
 *   npm run setup      # docker up + compile + deploy
 *   npm run deploy     # deploy only (devnet must be running)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import * as Rx from 'rxjs';

import { resolveNetwork, getOrCreateWallet, formatWalletBackupNotice } from './network';
import { createWallet, persistWalletState, unshieldedToken, type WalletContext } from './wallet';
import { VAULT_PRIVATE_STATE_ID, vaultPrivateState, vaultWitnesses } from './witnesses';

import { deployContract, findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/compact-js';

// Required for the wallet SDK's indexer connection in Node.js.
(globalThis as unknown as { WebSocket: unknown }).WebSocket = WebSocket;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VAULT_DIR = path.resolve(__dirname, '..', 'contracts', 'managed', 'memory-vault');
const ALLOWANCE_DIR = path.resolve(__dirname, '..', 'contracts', 'managed', 'allowance-registry');
const OUT_FILE = path.resolve(__dirname, '..', 'deployment.json');
const DUST_WAIT_TIMEOUT_MS = 5 * 60 * 1000;

const hex = (u8: Uint8Array): string => Buffer.from(u8).toString('hex');
const sha256 = (s: string): Uint8Array => createHash('sha256').update(s, 'utf8').digest();

async function loadContract(dir: string): Promise<{ Contract: unknown; ledger: (s: unknown) => unknown }> {
  const modulePath = path.join(dir, 'contract', 'index.js');
  if (!fs.existsSync(modulePath)) {
    throw new Error(`Contract not compiled at ${modulePath}. Run: npm run compile`);
  }
  return (await import(pathToFileURL(modulePath).href)) as { Contract: unknown; ledger: (s: unknown) => unknown };
}

async function waitForProofServer(url: string, maxAttempts = 60, delayMs = 2000): Promise<boolean> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(3000) });
      return true;
    } catch (err) {
      const code = (err as { cause?: { code?: string }; code?: string })?.cause?.code ?? (err as { code?: string })?.code ?? '';
      if (code !== 'ECONNREFUSED' && code !== 'UND_ERR_CONNECT_TIMEOUT' && code !== 'UND_ERR_SOCKET') return true;
    }
    if (attempt < maxAttempts) {
      process.stdout.write(`\r  Waiting for proof server... (${attempt}/${maxAttempts})   `);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return false;
}

function walletProviders(ctx: WalletContext) {
  return {
    getCoinPublicKey: () => ctx.shieldedSecretKeys.coinPublicKey,
    getEncryptionPublicKey: () => ctx.shieldedSecretKeys.encryptionPublicKey,
    async balanceTx(tx: unknown, ttl?: Date) {
      const recipe = await ctx.wallet.balanceUnboundTransaction(
        tx as never,
        { shieldedSecretKeys: ctx.shieldedSecretKeys, dustSecretKey: ctx.dustSecretKey },
        { ttl: ttl ?? new Date(Date.now() + 30 * 60 * 1000) },
      );
      return ctx.wallet.finalizeRecipe(recipe);
    },
    submitTx: (tx: unknown) => ctx.wallet.submitTransaction(tx as never),
  };
}

function contractProviders(
  ctx: WalletContext,
  networkConfig: { indexer: string; indexerWS: string; proofServer: string },
  name: string,
  zkDir: string,
) {
  const privateStatePassword =
    process.env.PRIVATE_STATE_PASSWORD?.trim() || 'Local-Devnet-Development-Placeholder-1';
  const walletProvider = walletProviders(ctx);
  const zkConfigProvider = new NodeZkConfigProvider(zkDir);
  const accountId = ctx.unshieldedKeystore.getBech32Address().toString();
  return {
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: `${name}-private-state`,
      accountId,
      privateStoragePasswordProvider: () => privateStatePassword,
    }),
    publicDataProvider: indexerPublicDataProvider(networkConfig.indexer, networkConfig.indexerWS),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(networkConfig.proofServer, zkConfigProvider),
    walletProvider,
    midnightProvider: walletProvider,
  };
}

async function ensureDust(ctx: WalletContext): Promise<void> {
  const dustState = await Rx.firstValueFrom(ctx.wallet.state().pipe(Rx.filter((s) => s.isSynced)));
  const unregistered = dustState.unshielded.availableCoins.filter(
    (c) => !(c as { meta?: { registeredForDustGeneration?: boolean } }).meta?.registeredForDustGeneration,
  );
  if (unregistered.length > 0) {
    console.log(`  Registering ${unregistered.length} NIGHT UTXO(s) for DUST generation...`);
    const recipe = await ctx.wallet.registerNightUtxosForDustGeneration(
      unregistered,
      ctx.unshieldedKeystore.getPublicKey(),
      (payload) => ctx.unshieldedKeystore.signData(payload),
    );
    const finalized = await ctx.wallet.finalizeRecipe(recipe);
    await ctx.wallet.submitTransaction(finalized);
  }
  if (dustState.dust.balance(new Date()) === 0n) {
    console.log('  Waiting for DUST...');
    await Rx.firstValueFrom(
      ctx.wallet.state().pipe(
        Rx.throttleTime(5000),
        Rx.filter((s) => s.isSynced),
        Rx.filter((s) => s.dust.balance(new Date()) > 0n),
        Rx.timeout({ first: DUST_WAIT_TIMEOUT_MS }),
      ),
    );
  }
}

async function main(): Promise<void> {
  const { network, config: networkConfig } = resolveNetwork();
  const WALLET = getOrCreateWallet(network);
  const notice = formatWalletBackupNotice(WALLET, network);
  if (notice) console.log(notice);

  console.log(`\nDeploying Open Instinct contracts to: ${network}\n`);

  console.log('Creating wallet...');
  const ctx = await createWallet({ network, networkConfig, seed: WALLET.seed });
  console.log('  Syncing with network (first run can take minutes)...');
  const state = await ctx.wallet.waitForSyncedState();
  await persistWalletState(network, ctx);
  const address = ctx.unshieldedKeystore.getBech32Address().toString();
  const balance = state.unshielded.balances[unshieldedToken().raw] ?? 0n;
  console.log(`  Wallet ${address}\n  Balance ${balance.toLocaleString()} tNIGHT\n`);
  if (network === 'undeployed' && balance === 0n) {
    throw new Error('Genesis wallet has zero NIGHT; the devnet preset may not have minted. Try: docker compose down -v && npm run setup');
  }

  await ensureDust(ctx);
  console.log('  DUST ready.\n');

  if (!(await waitForProofServer(networkConfig.proofServer))) {
    throw new Error('Proof server not responding. Run: docker compose up -d');
  }

  const vaultMod = await loadContract(VAULT_DIR);
  const allowanceMod = await loadContract(ALLOWANCE_DIR);

  // ── Memory vault: deploy, then a real commit -> attest round-trip ──────────
  const privateState = vaultPrivateState(WALLET.seed);
  const vaultWitnessesImpl = vaultWitnesses();
  const vaultCompiled = CompiledContract.make('memory-vault', vaultMod.Contract as never).pipe(
    CompiledContract.withWitnesses(vaultWitnessesImpl as never),
    CompiledContract.withCompiledFileAssets(VAULT_DIR),
  );
  const vaultProviders = contractProviders(ctx, networkConfig, 'memory-vault', VAULT_DIR);

  console.log('─── Deploying memory-vault ────────────────────────────────────');
  const vaultDeployed = await deployContract(vaultProviders, {
    compiledContract: vaultCompiled as never,
    args: [],
    privateStateId: VAULT_PRIVATE_STATE_ID,
    initialPrivateState: privateState,
  } as never);
  const vaultAddress = vaultDeployed.deployTxData.public.contractAddress;
  console.log(`  address: ${vaultAddress}`);
  console.log(`  deploy tx: ${vaultDeployed.deployTxData.public.txId} (block ${vaultDeployed.deployTxData.public.blockHeight})\n`);

  const vault = await findDeployedContract(vaultProviders as never, {
    contractAddress: vaultAddress,
    compiledContract: vaultCompiled as never,
    privateStateId: VAULT_PRIVATE_STATE_ID,
    initialPrivateState: privateState,
  } as never);

  const memoryText = 'I take medication X daily';
  const preimage = sha256(memoryText);
  const salt = randomBytes(32);
  console.log('─── Committing a private memory ───────────────────────────────');
  console.log(`  plaintext (stays local): ${JSON.stringify(memoryText)}`);
  const commitCall = await vault.callTx.commit(preimage, salt);
  // The circuit return value lives on the private side of the call result
  // (the public side carries the transcript and next contract state).
  const commitment = commitCall.private.result as Uint8Array;
  console.log(`  commitment (on-chain): ${hex(commitment)}`);
  console.log(`  tx: ${commitCall.public.txId} (block ${commitCall.public.blockHeight})\n`);

  const attestationId = randomBytes(32);
  console.log('─── Selective-disclosure proof (category = health) ────────────');
  const attestCall = await vault.callTx.attest(commitment, attestationId, 1n);
  console.log(`  proof tx: ${attestCall.public.txId} (block ${attestCall.public.blockHeight})`);
  const ledgerState = await vaultProviders.publicDataProvider.queryContractState(vaultAddress);
  const board = vaultMod.ledger(ledgerState?.data) as {
    commitments: { size(): bigint };
    attestations: { size(): bigint };
    nullifiers: { size(): bigint };
  };
  console.log(`  on-chain: ${board.commitments.size()} commitment(s), ${board.attestations.size()} attestation(s), ${board.nullifiers.size()} nullifier(s)\n`);

  // ── Allowance registry (stretch) ───────────────────────────────────────────
  let allowanceAddress: string | undefined;
  let allowanceTx: string | undefined;
  try {
    const allowanceCompiled = CompiledContract.make('allowance-registry', allowanceMod.Contract as never).pipe(
      CompiledContract.withVacantWitnesses,
      CompiledContract.withCompiledFileAssets(ALLOWANCE_DIR),
    );
    const allowanceProviders = contractProviders(ctx, networkConfig, 'allowance-registry', ALLOWANCE_DIR);
    console.log('─── Deploying allowance-registry (stretch) ────────────────────');
    const deployed = await deployContract(allowanceProviders, {
      compiledContract: allowanceCompiled as never,
      args: [],
      privateStateId: 'allowanceRegistryPrivateState',
      initialPrivateState: {},
    } as never);
    allowanceAddress = deployed.deployTxData.public.contractAddress;
    allowanceTx = deployed.deployTxData.public.txId;
    console.log(`  address: ${allowanceAddress}`);
    console.log(`  deploy tx: ${allowanceTx}\n`);
  } catch (err) {
    console.log(`  allowance-registry skipped: ${err instanceof Error ? err.message : String(err)}\n`);
  }

  await persistWalletState(network, ctx);
  await ctx.wallet.stop();

  const record = {
    version: 1,
    network,
    deployedAt: new Date().toISOString(),
    deployer: address,
    memoryVault: {
      address: vaultAddress,
      deployTx: vaultDeployed.deployTxData.public.txId,
      deployBlock: vaultDeployed.deployTxData.public.blockHeight,
      commitTx: commitCall.public.txId,
      commitBlock: commitCall.public.blockHeight,
      commitment: hex(commitment),
      attestTx: attestCall.public.txId,
      attestBlock: attestCall.public.blockHeight,
      attestationId: hex(attestationId),
    },
    ...(allowanceAddress ? { allowanceRegistry: { address: allowanceAddress, deployTx: allowanceTx } } : {}),
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(record, null, 2) + '\n');
  console.log('─── Done ──────────────────────────────────────────────────────');
  console.log(`  Wrote ${OUT_FILE}`);
  console.log('  Set these in the agent environment:');
  console.log(`    MIDNIGHT_MODE=${network === 'undeployed' ? 'mock' : 'testnet'}`);
  console.log(`    MIDNIGHT_CONTRACT_ADDRESS=${vaultAddress}`);
  if (allowanceAddress) console.log(`    MIDNIGHT_ALLOWANCE_ADDRESS=${allowanceAddress}`);
  console.log('');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
