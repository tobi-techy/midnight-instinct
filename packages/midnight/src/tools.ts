/**
 * Agent tools for the Midnight layer. Three hero tools plus the stretch
 * allowance tool. Capabilities reuse the existing policy table (vault.write,
 * memory.write, purchase) so the tier matrix in core/policy.ts keeps working:
 * by default only the owner commits or proves anything, and `vault_status` and
 * the allowance stay owner-only. On a public demo agent (config.agent.public) a
 * guest may commit and prove too, inside a vault scope of their own, so one
 * guest can never prove or read another's commitment.
 */
import { Type } from "typebox";
import { defineTool, textResult, type Principal, type RegisteredTool, type ToolContext, type ToolResultLike } from "@open-instinct/core";
import { categoryName } from "./commit.js";
import { OWNER_SCOPE, type MidnightClient } from "./client.js";
import type { ShieldedMemory } from "./memory.js";

export interface MidnightToolDeps {
  client: MidnightClient;
  shielded: ShieldedMemory;
  /** True on a public demo agent: unknown senders may use the vault in their own scope. */
  publicMode?: boolean;
  auditAppend?: (entry: { kind: "policy"; conversationKey?: string; principal?: string; detail: Record<string, unknown> }) => void;
  now?: () => Date;
}

function errorResult(text: string): ToolResultLike {
  return { content: [{ type: "text", text }], isError: true };
}

function isOwner(p: Principal): boolean {
  return p.kind === "owner";
}

/**
 * The vault scope this caller commits and proves in. The owner is always the owner
 * scope. A guest gets the scope of their own principal id, which the client hashes
 * before it reaches the state file. Anyone else has no scope and no vault access.
 */
function vaultScopeOf(p: Principal, publicMode: boolean): string | undefined {
  if (isOwner(p)) return OWNER_SCOPE;
  if (publicMode && p.kind === "stranger") return p.id;
  return undefined;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function argText(args: unknown, key: string): string {
  const v = (args as Record<string, unknown> | undefined)?.[key];
  return typeof v === "string" ? clip(v, 80) : "";
}

export function midnightTools(deps: MidnightToolDeps): RegisteredTool[] {
  const { client, shielded } = deps;

  const commit = defineTool({
    name: "vault_commit",
    label: "Anchor memory on Midnight",
    description:
      "Save a durable memory AND anchor its shielded commitment on Midnight. The text stays on this host; the chain only gets an opaque hash plus a tx hash. Returns the commitment and tx hash to quote back. Owner only, except on a public demo agent where a guest may anchor inside their own scope.",
    parameters: Type.Object({
      text: Type.String({ description: "The memory to save, one or two sentences" }),
      category: Type.Optional(Type.String({ description: "health, finance, contact, preference or other (default other)" })),
    }),
    meta: { capabilities: ["vault.write"], group: "memory", describe: (a) => `vault_commit ${argText(a, "text")}` },
    execute: async ({ text, category }, ctx) => {
      const scope = vaultScopeOf(ctx.principal, deps.publicMode === true);
      if (!scope) return errorResult("Only the owner can anchor memories. Offer to pass the request to the owner instead.");
      const out = await shielded.remember(text, category, { scope });
      if (out.error) return { content: [{ type: "text", text: out.error }], isError: true };
      if (!out.saved) return errorResult("nothing to remember");
      const link = out.explorerUrl ? `\nVerify: ${out.explorerUrl}` : "";
      const line = out.notebook
        ? `Saved privately as a ${out.category} memory.`
        : `Anchored for this conversation as a ${out.category} memory; the text stays in the chat and the chain holds only the hash. Quote the commitment if you prove it later.`;
      return textResult(`${line} Commitment ${out.commitment} anchored on Midnight (tx ${out.txHash}, mode ${client.mode}).${link}`);
    },
  });

  const prove = defineTool({
    name: "vault_prove_reveal",
    label: "Prove a memory without revealing it",
    description:
      "Generate a Midnight selective-disclosure proof for an anchored memory. The verifier learns only the disclosed category (or bare existence), never the text. Give the commitment from vault_commit or vault_status. Owner only, except on a public demo agent where a guest may prove a commitment anchored in their own scope.",
    parameters: Type.Object({
      commitment: Type.String({ description: "64 hex chars from vault_commit" }),
      disclose: Type.Optional(Type.String({ description: "Category to disclose (health, finance, contact, preference, other) or 'existence' for proof-of-existence only (default)" })),
    }),
    meta: { capabilities: ["vault.write"], group: "memory", describe: (a) => `vault_prove_reveal ${argText(a, "commitment")}` },
    execute: async ({ commitment, disclose }, ctx) => {
      const scope = vaultScopeOf(ctx.principal, deps.publicMode === true);
      if (!scope) return errorResult("Only the owner can generate proofs. Offer to pass the request to the owner instead.");
      try {
        const proof = await client.prove({ commitment, scope, ...(disclose ? { disclose } : {}) });
        deps.auditAppend?.({ kind: "policy", conversationKey: ctx.conversationKey, principal: ctx.principal.id, detail: { tool: "vault_prove_reveal", attestationId: proof.attestationId, disclosed: proof.disclosed, txHash: proof.txHash, mode: proof.mode } });
        const link = proof.explorerUrl ? `\nVerify: ${proof.explorerUrl}` : "";
        return textResult(
          `Proof recorded on Midnight (tx ${proof.txHash}, mode ${proof.mode}). The verifier learns only this: ${proof.disclosedLabel} (${proof.disclosed === 0 ? "bare existence, no category" : `category code ${proof.disclosed}`}). Attestation id ${proof.attestationId} is single-use and cannot be replayed. Hand the whole id over so the other side can verify it themselves.${link}`,
        );
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  });

  const status = defineTool({
    name: "vault_status",
    label: "Midnight vault status",
    description: "Show the Midnight layer status: mode (mock, local, testnet), contract addresses, and counts of anchored commitments, proofs and allowances. Owner only.",
    parameters: Type.Object({}),
    meta: { capabilities: ["memory.write"], group: "memory" },
    execute: async (_args, ctx) => {
      if (!isOwner(ctx.principal)) return errorResult("Only the owner can inspect the vault.");
      const s = client.status();
      const lines = [
        `Midnight mode: ${s.mode}`,
        `Contract: ${s.contractAddress ?? "(none — mock anchors, nothing leaves the host)"}`,
        `Allowances contract: ${s.allowanceAddress ?? "(not deployed)"}`,
        `Commitments anchored: ${s.commitments}`,
        `Proofs issued: ${s.attestations}`,
        `Allowances: ${s.allowances}`,
      ];
      if (s.proofUrl) lines.push(`Proof server: ${s.proofUrl}`);
      return textResult(lines.join("\n"));
    },
  });

  const allowanceCheck = defineTool({
    name: "allowance_check",
    label: "Check a ZK-gated allowance",
    description:
      "Check (and record) a spend against an on-chain allowance for an (owner, spender, capability) triple. Returns allowed true/false with the running total. Missing or exhausted allowances return allowed:false, never an error, so the agent can ask the owner. Owner only. (Stretch: allowance-registry contract.)",
    parameters: Type.Object({
      spender: Type.String({ description: "Who spends: a contact id, agent handle, or capability consumer label" }),
      capability: Type.String({ description: "Capability being exercised, e.g. purchase, email.send" }),
      amountUsd: Type.Number({ description: "Amount in dollars" }),
    }),
    meta: {
      capabilities: ["purchase"],
      group: "system",
      amountUsd: (a) => {
        const v = (a as Record<string, unknown> | undefined)?.amountUsd;
        return typeof v === "number" && Number.isFinite(v) ? v : undefined;
      },
      describe: (a) => `allowance_check ${argText(a, "spender")} $${argText(a, "amountUsd")}`,
    },
    execute: async ({ spender, capability, amountUsd }, ctx) => {
      if (!isOwner(ctx.principal)) return errorResult("Only the owner can exercise allowances.");
      const ownerName = ctx.principal.displayName || "owner";
      const out = await client.checkSpend({ owner: ownerName, spender, capability, amountUsd });
      deps.auditAppend?.({ kind: "policy", conversationKey: ctx.conversationKey, principal: ctx.principal.id, detail: { tool: "allowance_check", allowed: out.allowed, spentUsd: out.spentUsd, limitUsd: out.limitUsd, txHash: out.txHash, reason: out.reason } });
      if (!out.allowed) {
        return textResult(`Allowance check FAILED: ${out.reason}. Do not proceed; ask the owner (ask_owner) or stop. Key ${out.key.slice(0, 16)}….`);
      }
      return textResult(`Allowance check passed: ${out.reason} (tx ${out.txHash ?? "n/a"}).`);
    },
  });

  return [commit, prove, status, allowanceCheck];
}

export { categoryName };
