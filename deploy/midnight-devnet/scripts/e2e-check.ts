/**
 * End-to-end check for the Open Instinct contracts on a running network.
 *
 * Reconnects to the deployed memory-vault, reads its on-chain ledger through
 * the indexer, and asserts a commitment and an attestation are actually
 * present. Exits non-zero on failure. Used by `npm run test:e2e`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';

import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { resolveNetwork } from '../src/network';

(globalThis as unknown as { WebSocket: unknown }).WebSocket = WebSocket;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VAULT_DIR = path.resolve(__dirname, '..', 'contracts', 'managed', 'memory-vault');
const DEPLOYMENT_FILE = path.resolve(__dirname, '..', 'deployment.json');

function fail(msg: string): never {
  console.error(`e2e-check failed: ${msg}`);
  process.exit(1);
}

async function main(): Promise<void> {
  if (!fs.existsSync(DEPLOYMENT_FILE)) fail('no deployment.json — run `npm run deploy` first');
  const record = JSON.parse(fs.readFileSync(DEPLOYMENT_FILE, 'utf8')) as {
    network: string;
    memoryVault: { address: string; commitment: string };
  };
  const address = record.memoryVault?.address;
  if (!address) fail('deployment.json has no memoryVault.address');

  const { network, config } = resolveNetwork();

  const ledgerModulePath = path.join(VAULT_DIR, 'contract', 'index.js');
  if (!fs.existsSync(ledgerModulePath)) fail('compiled contract missing — run `npm run compile`');
  const vault = (await import(pathToFileURL(ledgerModulePath).href)) as { ledger: (s: unknown) => unknown };

  const zkConfigProvider = new NodeZkConfigProvider(VAULT_DIR);
  const readOnlyProvider = {
    getCoinPublicKey: () => {
      throw new Error('e2e-check is read-only');
    },
    getEncryptionPublicKey: () => {
      throw new Error('e2e-check is read-only');
    },
    balanceTx: async () => {
      throw new Error('e2e-check is read-only');
    },
    submitTx: () => {
      throw new Error('e2e-check is read-only');
    },
  };
  const providers = {
    publicDataProvider: indexerPublicDataProvider(config.indexer, config.indexerWS),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(config.proofServer, zkConfigProvider),
    walletProvider: readOnlyProvider,
    midnightProvider: readOnlyProvider,
  };

  const state = await providers.publicDataProvider.queryContractState(address);
  if (!state) fail(`queryContractState returned null for ${address}`);

  const board = vault.ledger((state as { data: unknown }).data) as {
    commitments: { size(): bigint };
    attestations: { size(): bigint };
    nullifiers: { size(): bigint };
  };
  const commitments = Number(board.commitments.size());
  const attestations = Number(board.attestations.size());
  const nullifiers = Number(board.nullifiers.size());

  console.log('e2e-check passed');
  console.log(`   network:      ${network}`);
  console.log(`   contract:     ${address}`);
  console.log(`   commitments:  ${commitments}`);
  console.log(`   attestations: ${attestations}`);
  console.log(`   nullifiers:   ${nullifiers}`);
  if (commitments < 1) fail('expected at least one commitment on-chain');
  if (attestations < 1) fail('expected at least one attestation on-chain');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
