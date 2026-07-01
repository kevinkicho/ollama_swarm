// Cross-run proposal persistence.
// Stores improvement proposals in .swarm-improvements/proposals.jsonl
// so the brain accumulates knowledge across runs.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { ImprovementProposal } from "./brainOverseer.js";

export interface PersistedProposal extends ImprovementProposal {
  id: string;
  createdAt: number;
  status: "pending" | "applied" | "rejected";
  appliedAt?: number;
  rejectedAt?: number;
  rejectReason?: string;
}

const PROPOSALS_FILE = "proposals.jsonl";
const APPLIED_FILE = "applied.jsonl";

function getImprovementsDir(clonePath: string): string {
  return path.join(clonePath, ".swarm-improvements");
}

/**
 * Read all persisted proposals from disk.
 */
export async function readProposals(clonePath: string): Promise<PersistedProposal[]> {
  const filePath = path.join(getImprovementsDir(clonePath), PROPOSALS_FILE);
  if (!existsSync(filePath)) return [];

  try {
    const content = await readFile(filePath, "utf8");
    return content
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        try {
          return JSON.parse(line) as PersistedProposal;
        } catch {
          return null;
        }
      })
      .filter((p): p is PersistedProposal => p !== null);
  } catch {
    return [];
  }
}

/**
 * Append a proposal to the proposals file.
 */
export async function appendProposal(clonePath: string, proposal: ImprovementProposal): Promise<PersistedProposal> {
  const dir = getImprovementsDir(clonePath);
  await mkdir(dir, { recursive: true });

  const persisted: PersistedProposal = {
    ...proposal,
    id: `proposal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: Date.now(),
    status: "pending",
  };

  const filePath = path.join(dir, PROPOSALS_FILE);
  const line = JSON.stringify(persisted) + "\n";
  await writeFile(filePath, line, { flag: "a" });

  return persisted;
}

/**
 * Update a proposal's status (applied/rejected).
 */
export async function updateProposalStatus(
  clonePath: string,
  proposalId: string,
  status: "applied" | "rejected",
  reason?: string,
): Promise<void> {
  const proposals = await readProposals(clonePath);
  const updated = proposals.map((p) => {
    if (p.id !== proposalId) return p;
    return {
      ...p,
      status,
      ...(status === "applied" ? { appliedAt: Date.now() } : {}),
      ...(status === "rejected" ? { rejectedAt: Date.now(), rejectReason: reason } : {}),
    };
  });

  const dir = getImprovementsDir(clonePath);
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, PROPOSALS_FILE);
  const content = updated.map((p) => JSON.stringify(p)).join("\n") + "\n";
  await writeFile(filePath, content);
}

/**
 * Read applied proposals for dedup.
 */
export async function readAppliedProposals(clonePath: string): Promise<string[]> {
  const filePath = path.join(getImprovementsDir(clonePath), APPLIED_FILE);
  if (!existsSync(filePath)) return [];

  try {
    const content = await readFile(filePath, "utf8");
    return content.split("\n").filter((line) => line.trim().length > 0);
  } catch {
    return [];
  }
}

/**
 * Record a proposal as applied.
 */
export async function recordApplied(clonePath: string, proposalId: string): Promise<void> {
  const dir = getImprovementsDir(clonePath);
  await mkdir(dir, { recursive: true });

  const filePath = path.join(dir, APPLIED_FILE);
  const line = `${proposalId}\n`;
  await writeFile(filePath, line, { flag: "a" });
}
