// Print the wallet address for the configured network without syncing.
// Runs before `deploy` so the wallet can be funded from a faucet first; the
// generated seed is persisted (gitignored) and reused by deploy.
import { formatWalletBackupNotice, getOrCreateWallet, resolveNetwork } from './network';
import { createWallet } from './wallet';

const { network, config: networkConfig } = resolveNetwork();

console.log(`Network: ${network}`);
const WALLET = getOrCreateWallet(network);
const notice = formatWalletBackupNotice(WALLET, network);
if (notice) console.log(notice);

const ctx = await createWallet({ network, networkConfig, seed: WALLET.seed, restore: false });
console.log(`\nAddress: ${ctx.unshieldedKeystore.getBech32Address().toString()}`);
if (networkConfig.faucet) console.log(`Faucet:  ${networkConfig.faucet}`);
process.exit(0);
