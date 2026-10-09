/**
 * `instinct midnight ...`: work with the Midnight privacy layer from the
 * terminal. status/list/prove read the same state file the agent uses, so they
 * work whether or not a server is running. init seeds a vault; deploy pushes
 * the contracts through a proof-server adapter.
 */
import { randomBytes } from "node:crypto";
import {
  MIDNIGHT_STATE_FILE,
  MidnightClient,
  midnightEnv,
  newPersistedState,
  type PersistedState,
} from "@open-instinct/midnight";
import { parse, str, type OptionSpec } from "../args.js";
import { table } from "../ansi.js";
import type { CliContext } from "../context.js";
import { CliError, UsageError } from "../io.js";

export const midnightOptions: OptionSpec = {
  disclose: { type: "string" },
  category: { type: "string" },
};

function readState(ctx: CliContext): PersistedState {
  const raw = ctx.state().readJson<PersistedState | undefined>(MIDNIGHT_STATE_FILE, undefined);
  if (raw && typeof raw === "object" && raw.version === 1) return raw;
  return newPersistedState("");
}

function clientOf(ctx: CliContext, state: PersistedState): MidnightClient {
  const cfg = midnightEnv(ctx.env) ?? { mode: "mock" as const };
  return new MidnightClient({
    env: cfg,
    state,
    vaultKey: state.vaultKey || "cli",
    save: (s) => ctx.state().writeJson(MIDNIGHT_STATE_FILE, s),
  });
}

function runInit(ctx: CliContext): number {
  const { c } = ctx;
  const state = ctx.state();
  const existing = state.readJson<PersistedState | undefined>(MIDNIGHT_STATE_FILE, undefined);
  if (existing && existing.vaultKey) {
    ctx.print(c.dim(`Midnight state already exists at ${state.path(MIDNIGHT_STATE_FILE)}`));
    return 0;
  }
  const fresh = newPersistedState(randomBytes(16).toString("hex"));
  state.writeJson(MIDNIGHT_STATE_FILE, fresh);
  ctx.print(`${c.green("Initialized")} Midnight state at ${state.path(MIDNIGHT_STATE_FILE)}`);
  ctx.print(c.dim("Mode is mock until you set MIDNIGHT_MODE=local|testnet and MIDNIGHT_PROOF_URL."));
  return 0;
}

function runStatus(ctx: CliContext): number {
  const { c } = ctx;
  const cfg = midnightEnv(ctx.env);
  const state = readState(ctx);
  const mode = cfg?.mode ?? "mock";
  ctx.print(c.bold("Midnight layer"));
  const rows: string[][] = [
    ["mode", mode],
    ["vault key", state.vaultKey ? `${state.vaultKey.slice(0, 12)}…` : "(none — run instinct midnight init)"],
    ["proof server", cfg?.proofUrl ?? "(none)"],
    ["vault contract", cfg?.contractAddress ?? "(mock anchors)"],
    ["allowances contract", cfg?.allowanceAddress ?? "(not deployed)"],
    ["commitments", String(Object.keys(state.commitments).length)],
    ["attestations", String(Object.keys(state.nullifiers).length)],
    ["allowances", String(Object.keys(state.allowances).length)],
  ];
  ctx.print(table(rows));
  return 0;
}

function runList(ctx: CliContext): number {
  const { c } = ctx;
  const state = readState(ctx);
  const entries = Object.entries(state.commitments);
  if (entries.length === 0) {
    ctx.print(c.dim("No commitments yet. The agent creates them with vault_commit."));
    return 0;
  }
  ctx.print(c.bold(`Commitments (${entries.length})`));
  ctx.print(
    table(
      entries.map(([commitment, row]) => [
        `${commitment.slice(0, 16)}…`,
        row.category,
        row.txHash,
        row.at.slice(0, 19).replace("T", " "),
      ]),
    ),
  );
  return 0;
}

async function runProve(ctx: CliContext, argv: string[]): Promise<number> {
  const { values, positionals } = parse("midnight", argv, midnightOptions);
  const commitment = positionals[1];
  if (!commitment) throw new UsageError("usage: instinct midnight prove <commitment> [--disclose health|finance|contact|preference|other|existence]", "midnight");
  const state = readState(ctx);
  if (!state.vaultKey) throw new CliError("No vault key. Run `instinct midnight init` first.");
  const client = clientOf(ctx, state);
  const disclose = str(values, "disclose");
  try {
    const proof = await client.prove({ commitment, ...(disclose ? { disclose } : {}) });
    const link = proof.explorerUrl ? `\nVerify: ${proof.explorerUrl}` : "";
    ctx.print(ctx.c.green("Proof recorded") + ` (mode ${proof.mode})`);
    ctx.print(`  disclosed: ${proof.disclosedLabel} (${proof.disclosed === 0 ? "bare existence" : `code ${proof.disclosed}`})`);
    ctx.print(`  attestation: ${proof.attestationId}`);
    ctx.print(`  tx: ${proof.txHash}${link}`);
    return 0;
  } catch (err) {
    throw new CliError(err instanceof Error ? err.message : String(err));
  }
}

async function runDeploy(ctx: CliContext): Promise<number> {
  const { c } = ctx;
  const proofUrl = ctx.env.MIDNIGHT_PROOF_URL?.trim().replace(/\/+$/, "");
  if (!proofUrl) throw new CliError("MIDNIGHT_PROOF_URL is not set. See packages/midnight/scripts/deploy-testnet.mjs for the checklist.");
  const deploy = async (name: string): Promise<{ address: string; txHash: string }> => {
    const res = await (ctx.io.fetchImpl ?? globalThis.fetch)(`${proofUrl}/deploy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contract: name }),
    });
    const text = await res.text();
    if (!res.ok) throw new CliError(`deploy ${name}: HTTP ${res.status} ${text.slice(0, 200)}`);
    const body = JSON.parse(text) as { address?: string; txHash?: string };
    if (!body.address || !body.txHash) throw new CliError(`deploy ${name}: response had no address/txHash`);
    return { address: body.address, txHash: body.txHash };
  };
  const vault = await deploy("memory-vault");
  ctx.print(`${c.green("Deployed")} memory-vault -> ${vault.address} (tx ${vault.txHash})`);
  let allowances: { address: string; txHash: string } | undefined;
  try {
    allowances = await deploy("allowance-registry");
    ctx.print(`${c.green("Deployed")} allowance-registry -> ${allowances.address} (tx ${allowances.txHash})`);
  } catch (err) {
    ctx.print(c.yellow(`allowance-registry skipped: ${err instanceof Error ? err.message : String(err)}`));
  }
  const state = readState(ctx);
  state.vaultKey ||= randomBytes(16).toString("hex");
  ctx.state().writeJson(MIDNIGHT_STATE_FILE, state);
  ctx.print();
  ctx.print("Add to your environment:");
  ctx.print(`  MIDNIGHT_MODE=testnet`);
  ctx.print(`  MIDNIGHT_PROOF_URL=${proofUrl}`);
  ctx.print(`  MIDNIGHT_CONTRACT_ADDRESS=${vault.address}`);
  if (allowances) ctx.print(`  MIDNIGHT_ALLOWANCE_ADDRESS=${allowances.address}`);
  return 0;
}

export async function runMidnight(ctx: CliContext, argv: string[]): Promise<number> {
  const { positionals } = parse("midnight", argv, midnightOptions);
  const [sub] = positionals;
  switch (sub) {
    case undefined:
    case "status":
      return runStatus(ctx);
    case "init":
      return runInit(ctx);
    case "list":
      return runList(ctx);
    case "prove":
      return runProve(ctx, argv);
    case "deploy":
      return runDeploy(ctx);
    default:
      throw new UsageError(`Unknown midnight subcommand "${sub}". Use init, deploy, status, list or prove.`, "midnight");
  }
}
