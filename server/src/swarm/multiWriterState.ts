// Phase 2 (writeMode: multi): shared infrastructure for runners to
// collect hunk proposals during agent turns and reconcile at end.
//
// Usage in runners:
//   1. Create MultiWriterState at run start
//   2. In each agent turn (when writeMode: "multi"):
//      - Parse hunks from agent response
//      - Call state.addProposal(agent, hunks)
//   3. At end of discussion phase:
//      - Call state.reconcile(strategy, currentFiles)
//      - Apply reconciled hunks via wrapUpApplyPhase
//
// This module is deliberately runner-agnostic — the reconciliation
// logic is shared, but each runner controls when/where proposals
// are collected and which strategy to use.

import type { Agent } from "../services/AgentManager.js";
import type { Hunk } from "./blackboard/applyHunks.js";
import {
  reconcileHunks,
  type HunkProposal,
  type ReconciliationStrategy,
  type ReconciliationResult,
} from "./reconcileHunks.js";
import { parseWorkerResponse } from "./blackboard/prompts/worker.js";
import { collectAllFiles } from "./BaselineRunner.js";
import { extractText } from "./extractText.js";

export interface MultiWriterConfig {
  writeMode: "none" | "single" | "multi";
  conflictPolicy?: ReconciliationStrategy;
  clonePath: string;
}

export class MultiWriterState {
  private proposals: HunkProposal[] = [];
  private readonly clonePath: string;

  constructor(private readonly config: MultiWriterConfig) {
    this.clonePath = config.clonePath;
  }

  /**
   * Add a hunk proposal from an agent's turn.
   * Called during the discussion loop when an agent returns hunks.
   */
  addProposal(agent: Agent, responseText: string): { hunks: Hunk[]; skipped: boolean; reason?: string } {
    // Parse hunks from the agent response
    const allowedFiles = new Set<string>(); // Will be populated later
    const text = extractText(responseText) ?? responseText;
    const parsed = parseWorkerResponse(text, []);

    if (!parsed.ok) {
      return { hunks: [], skipped: true, reason: parsed.reason };
    }

    if (parsed.skip) {
      return { hunks: [], skipped: true, reason: parsed.skip };
    }

    if (parsed.hunks.length === 0) {
      return { hunks: [], skipped: true, reason: "no hunks produced" };
    }

    // Record the proposal
    this.proposals.push({
      agentId: agent.id,
      agentIndex: agent.index,
      hunks: parsed.hunks,
      timestamp: Date.now(),
    });

    return { hunks: parsed.hunks, skipped: false };
  }

  /**
   * Get all collected proposals.
   */
  getProposals(): HunkProposal[] {
    return [...this.proposals];
  }

  /**
   * Reconcile all proposals using the configured strategy.
   * Returns reconciled hunks ready for apply + commit.
   */
  async reconcile(
    currentFiles: Record<string, string | null>,
    strategy?: ReconciliationStrategy,
    winnerAgentId?: string,
  ): Promise<ReconciliationResult> {
    const actualStrategy = strategy ?? this.config.conflictPolicy ?? "merge";
    return reconcileHunks(this.proposals, actualStrategy, {
      currentFiles,
      winnerAgentId,
    });
  }

  /**
   * Check if multi-writer mode is active.
   */
  isActive(): boolean {
    return this.config.writeMode === "multi";
  }

  /**
   * Get count of proposals collected.
   */
  proposalCount(): number {
    return this.proposals.length;
  }

  /**
   * Clear proposals (for testing or retry scenarios).
   */
  clear(): void {
    this.proposals = [];
  }
}

/**
 * Build a prompt that instructs an agent to propose hunks during their turn.
 * Used in multi-writer mode where each agent can propose file modifications.
 */
export function buildMultiWriterPrompt(input: {
  directive: string;
  fileListing: string;
  context: string;
  rolePrompt?: string;
}): string {
  const lines: string[] = [];

  if (input.rolePrompt) {
    lines.push(input.rolePrompt);
    lines.push("");
  }

  lines.push(`## Your Task`);
  lines.push("");
  lines.push(input.directive);
  lines.push("");
  lines.push(`## Context from Discussion`);
  lines.push("");
  lines.push(input.context);
  lines.push("");
  lines.push(`## Repository Files`);
  lines.push("");
  lines.push(`The following files exist. You may modify any file in this list:`);
  lines.push("");
  lines.push(input.fileListing);
  lines.push("");
  lines.push(`## Output Format`);
  lines.push("");
  lines.push(`Return a JSON envelope of hunks (file modifications):`);
  lines.push("");
  lines.push(`\`\`\`json`);
  lines.push(`{`);
  lines.push(`  "hunks": [`);
  lines.push(`    { "op": "replace", "file": "path/to/file.ts", "search": "exact code to find", "replace": "new code" },`);
  lines.push(`    { "op": "create", "file": "path/to/new.ts", "content": "file content" },`);
  lines.push(`    { "op": "append", "file": "path/to/file.ts", "content": "text to append" }`);
  lines.push(`  ]`);
  lines.push(`}`);
  lines.push(`\`\`\``);
  lines.push("");
  lines.push(`Guidelines:`);
  lines.push(`- Use "replace" for existing files. \`search\` must match EXACTLY once.`);
  lines.push(`- Keep hunks minimal and atomic.`);
  lines.push(`- If you cannot implement anything, return \`{ "hunks": [], "skip": "reason" }\``);
  lines.push("");
  lines.push(`Now propose your hunks:`);

  return lines.join("\n");
}

/**
 * Default conflict policies per preset.
 * Matches each preset's decision-making model.
 */
export const DEFAULT_CONFLICT_POLICIES: Record<string, ReconciliationStrategy> = {
  council: "vote",
  moa: "pick",
  "map-reduce": "merge",
  "debate-judge": "judge",
  "orchestrator-worker": "sequential",
  "orchestrator-worker-deep": "sequential",
  "round-robin": "vote",
  "role-diff": "vote",
  stigmergy: "merge",
  blackboard: "sequential", // blackboard already has CAS
  baseline: "sequential",
};

/**
 * Helper to collect files for conflict detection.
 * Reads current file contents so sequential reconciliation can validate.
 */
export async function collectCurrentFiles(
  clonePath: string,
  files: string[]): Promise<Record<string, string | null>> {
  const result: Record<string, string | null> = {};

  for (const file of files) {
    try {
      const fs = await import("node:fs/promises");
      const absPath = require("node:path").join(clonePath, file);
      const content = await fs.readFile(absPath, "utf8");
      result[file] = content;
    } catch {
      result[file] = null; // File doesn't exist
    }
  }

  return result;
}