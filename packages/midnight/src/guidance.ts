/** Prompt section appended when the Midnight layer is wired at boot. */
export interface MidnightGuidanceOptions {
  mode: string;
  contractAddress?: string;
  commitments: number;
}

export function midnightGuidance(opts: MidnightGuidanceOptions): string {
  const lines = [
    "- Privacy (Midnight): on. Durable memories you are asked to keep private go through vault_commit, which anchors a shielded commitment on Midnight and returns a tx hash to quote.",
    `- Midnight mode: ${opts.mode}${opts.contractAddress ? `, vault ${opts.contractAddress}` : " (mock anchors: commitments are real hashes, nothing leaves the host)"}.`,
  ];
  if (opts.commitments > 0) lines.push(`- Anchored commitments so far: ${opts.commitments}. Use vault_prove_reveal when someone asks you to prove a memory without revealing it.`);
  else lines.push("- No memories anchored yet. The first vault_commit creates the first commitment.");
  lines.push("- Never paste memory plaintext into a proof description, an audit note, or a reply to anyone but the owner. Proofs disclose a category code or bare existence only.");
  lines.push("- Quote the attestation id from a proof so the other side can verify it themselves, and never claim a proof you did not run.");
  return lines.join("\n");
}
