/**
 * Midnight runtime adapter.
 *
 * The small REST service the agent's `local`/`testnet` MidnightClient talks to
 * (the contract documented in docs/MIDNIGHT.md). It owns the wallet and the
 * deployed contract handles, and turns each request into a real circuit call,
 * returning a transaction id. The agent process never holds a seed phrase.
 *
 * Run it after `npm run setup` (which writes deployment.json):
 *   npm run adapter
 *
 * Then point the agent at it:
 *   MIDNIGHT_MODE=local
 *   MIDNIGHT_PROOF_URL=http://127.0.0.1:6400
 *   MIDNIGHT_CONTRACT_ADDRESS=<memoryVault.address>
 *
 * Endpoints:
 *   POST /commit              { contract, preimage, salt }              -> { commitment, txHash }
 *   POST /attest              { commitment, attestationId, category }   -> { txHash }
 *   POST /allowance/authorize { key, maxAmount }                        -> { txHash }
 *   POST /allowance/spend     { key, amount }                           -> { txHash }
 *   POST /allowance/revoke    { key }                                   -> { txHash }
 *   POST /deploy              { contract }                              -> { address, txHash }
 *   GET  /health
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';

import { resolveNetwork, getOrCreateWallet } from './network';
import { createWallet } from './wallet';
import { ownerSecretFromSeed } from './secret';

import { deployContract, findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/compact-js';

(globalThis as unknown as { WebSocket: unknown }).WebSocket = WebSocket;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VAULT_DIR = path.resolve(__dirname, '..', 'contracts', 'managed', 'memory-vault');
const ALLOWANCE_DIR = path.resolve(__dirname, '..', 'contracts', 'managed', 'allowance-registry');
const DEPLOYMENT_FILE = path.resolve(__dirname, '..', 'deployment.json');
const PORT = Number(process.env.MIDNIGHT_ADAPTER_PORT ?? 6400);

const hexToBytes = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'));
const bytesToHex = (u8: Uint8Array): string => Buffer.from(u8).toString('hex');

async function loadModule(dir: string): Promise<{ Contract: unknown; ledger: (s: unknown) => unknown }> {
  return (await import(pathToFileURL(path.join(dir, 'contract', 'index.js')).href)) as {
    Contract: unknown;
    ledger: (s: unknown) => unknown;
  };
}

function providerSet(ctx: Awaited<ReturnType<typeof createWallet>>, cfg: { indexer: string; indexerWS: string; proofServer: string }, name: string, zkDir: string) {
  const walletProvider = {
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
  const zkConfigProvider = new NodeZkConfigProvider(zkDir);
  return {
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: `${name}-private-state`,
      accountId: ctx.unshieldedKeystore.getBech32Address().toString(),
      privateStoragePasswordProvider: () =>
        process.env.PRIVATE_STATE_PASSWORD?.trim() || 'Local-Devnet-Development-Placeholder-1',
    }),
    publicDataProvider: indexerPublicDataProvider(cfg.indexer, cfg.indexerWS),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(cfg.proofServer, zkConfigProvider),
    walletProvider,
    midnightProvider: walletProvider,
  };
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try {
        resolve(data ? (JSON.parse(data) as Record<string, unknown>) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
}

async function main(): Promise<void> {
  if (!fs.existsSync(DEPLOYMENT_FILE)) {
    throw new Error('deployment.json not found. Run `npm run setup` first.');
  }
  const record = JSON.parse(fs.readFileSync(DEPLOYMENT_FILE, 'utf8')) as {
    memoryVault?: { address?: string };
    allowanceRegistry?: { address?: string };
  };
  const vaultAddress = record.memoryVault?.address;
  const allowanceAddress = record.allowanceRegistry?.address;
  if (!vaultAddress) throw new Error('deployment.json has no memoryVault.address');

  const { network, config } = resolveNetwork();
  const WALLET = getOrCreateWallet(network);
  console.log('Adapter: building wallet...');
  const ctx = await createWallet({ network, networkConfig: config, seed: WALLET.seed });
  console.log('Adapter: syncing (first run can take minutes)...');
  await ctx.wallet.waitForSyncedState();
  console.log('Adapter: wallet synced.');

  const ownerSecret = ownerSecretFromSeed(WALLET.seed);
  const vaultMod = await loadModule(VAULT_DIR);

  // Discover any existing vault private state in the store: if the store does
  // not yet hold ownerSecret, findDeployedContract seeds it from the value we
  // pass, so the deploy-time binding can be re-proven.
  const vaultCompiled = CompiledContract.make('memory-vault', vaultMod.Contract as never).pipe(
    CompiledContract.withWitnesses({
      ownerSecret: ({ privateState }: { privateState: { ownerSecret: Uint8Array } }) =>
        [privateState, privateState.ownerSecret] as [unknown, Uint8Array],
    } as never),
    CompiledContract.withCompiledFileAssets(VAULT_DIR),
  );
  const vaultProviders = providerSet(ctx, config, 'memory-vault', VAULT_DIR);
  const vault = await findDeployedContract(vaultProviders as never, {
    contractAddress: vaultAddress,
    compiledContract: vaultCompiled as never,
    privateStateId: 'memoryVaultPrivateState',
    initialPrivateState: { ownerSecret },
  } as never);
  console.log(`Adapter: vault handle ready at ${vaultAddress}`);

  let allowance: Awaited<ReturnType<typeof findDeployedContract>> | undefined;
  if (allowanceAddress) {
    try {
      const allowanceMod = await loadModule(ALLOWANCE_DIR);
      const allowanceCompiled = CompiledContract.make('allowance-registry', allowanceMod.Contract as never).pipe(
        CompiledContract.withVacantWitnesses,
        CompiledContract.withCompiledFileAssets(ALLOWANCE_DIR),
      );
      const allowanceProviders = providerSet(ctx, config, 'allowance-registry', ALLOWANCE_DIR);
      allowance = await findDeployedContract(allowanceProviders as never, {
        contractAddress: allowanceAddress,
        compiledContract: allowanceCompiled as never,
        privateStateId: 'allowanceRegistryPrivateState',
        initialPrivateState: {},
      } as never);
      console.log(`Adapter: allowance handle ready at ${allowanceAddress}`);
    } catch (err) {
      console.warn(`Adapter: allowance handle unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const server = createServer(async (req, res) => {
    const url = req.url ?? '/';
    if (req.method === 'GET' && url === '/health') {
      return send(res, 200, { status: 'ok', mode: network, vault: vaultAddress });
    }
    if (req.method !== 'POST') return send(res, 404, { error: 'not found' });

    try {
      const body = await readBody(req);
      switch (url) {
        case '/commit': {
          const preimage = hexToBytes(String(body.preimage));
          const salt = hexToBytes(String(body.salt));
          const call = await vault.callTx.commit(preimage as never, salt as never);
          return send(res, 200, {
            commitment: bytesToHex(call.private.result as Uint8Array),
            txHash: call.public.txId,
          });
        }
        case '/attest': {
          const call = await vault.callTx.attest(
            hexToBytes(String(body.commitment)) as never,
            hexToBytes(String(body.attestationId)) as never,
            BigInt(Number(body.category)) as never,
          );
          return send(res, 200, { txHash: call.public.txId });
        }
        case '/allowance/authorize': {
          if (!allowance) return send(res, 503, { error: 'allowance contract not deployed' });
          const call = await (allowance as never as { callTx: Record<string, (...a: unknown[]) => Promise<{ public: { txId: string } }>> }).callTx
            .authorize(hexToBytes(String(body.key)), BigInt(Number(body.maxAmount)));
          return send(res, 200, { txHash: call.public.txId });
        }
        case '/allowance/spend': {
          if (!allowance) return send(res, 503, { error: 'allowance contract not deployed' });
          const call = await (allowance as never as { callTx: Record<string, (...a: unknown[]) => Promise<{ public: { txId: string } }>> }).callTx
            .spend(hexToBytes(String(body.key)), BigInt(Number(body.amount)));
          return send(res, 200, { txHash: call.public.txId });
        }
        case '/allowance/revoke': {
          if (!allowance) return send(res, 503, { error: 'allowance contract not deployed' });
          const call = await (allowance as never as { callTx: Record<string, (...a: unknown[]) => Promise<{ public: { txId: string } }>> }).callTx
            .revoke(hexToBytes(String(body.key)));
          return send(res, 200, { txHash: call.public.txId });
        }
        case '/deploy': {
          // Contracts are deployed by `npm run setup`; report the recorded ones.
          const name = String(body.contract);
          if (name === 'memory-vault') return send(res, 200, { address: vaultAddress, txHash: 'already-deployed' });
          if (name === 'allowance-registry' && allowanceAddress) {
            return send(res, 200, { address: allowanceAddress, txHash: 'already-deployed' });
          }
          return send(res, 404, { error: `unknown contract ${name}` });
        }
        default:
          return send(res, 404, { error: `unknown endpoint ${url}` });
      }
    } catch (err) {
      return send(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`\nMidnight adapter listening on http://127.0.0.1:${PORT}`);
    console.log(`  network: ${network}`);
    console.log(`  vault:   ${vaultAddress}`);
    if (allowanceAddress) console.log(`  allowance: ${allowanceAddress}`);
    console.log('\nPoint the agent at it with MIDNIGHT_MODE=local and MIDNIGHT_PROOF_URL=http://127.0.0.1:' + PORT);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
