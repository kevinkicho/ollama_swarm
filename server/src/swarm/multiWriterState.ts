// Phase 2 (writeMode: multi): shared infrastructure for runners to
// collect hunk proposals during agent turns and reconcile at end.
//
// Usage in runners:
//   1. Create MultiWriterState at run start
//   2. In each agent turn (when writeMode: "multi"):
//      - Parse hunks or workingTree from agent response
//      - Call await state.addProposal(agent, response)
//   3. At end of discussion phase:
//      - Call state.reconcile(strategy, currentFiles)
//      - Apply reconciled hunks via wrapUpApplyPhase
//
// Git-native: workingTree finishes are snapshotted into full-file `write`
// hunks (disk content at proposal time) so reconcile/vote still works.

import { promises as fs } from "node:fs";
import path from "node:path";
import type { Agent } from "../services/AgentManager.js";
import type { Hunk } from "./blackboard/applyHunks.js";
import {
  reconcileHunks,
  type HunkProposal,
  type ReconciliationStrategy,
  type ReconciliationResult,
} from "./reconcileHunks.js";
import { parseWorkerResponse } from "./blackboard/prompts/worker.js";
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
   * Add a proposal from an agent's turn (hunks JSON or workingTree snapshot).
   */
  async addProposal(
    agent: Agent,
    responseText: string,
  ): Promise<{
    hunks: Hunk[];
    skipped: boolean;
    reason?: string;
    /** True when proposal came from workingTree / disk snapshot. */
    fromWorkingTree?: boolean;
  }> {
    // Empty expectedFiles = allow-all (multi-writer collects proposals for any path;
    // reconcile + wrap-up apply enforce final safety). See parseWorkerResponse.
    const text = extractText(responseText) ?? responseText;
    const parsed = parseWorkerResponse(text, []);

    if (!parsed.ok) {
      return { hunks: [], skipped: true, reason: parsed.reason };
    }

    if (parsed.skip) {
      return { hunks: [], skipped: true, reason: parsed.skip };
    }

    // Git-native: snapshot disk files into write hunks for reconciliation.
    if (
      parsed.workingTree === true
      || (parsed.hunks.length === 0 && (parsed.filesTouched?.length ?? 0) > 0)
    ) {
      const files = parsed.filesTouched ?? [];
      const writeHunks = await snapshotWorkingTreeAsWriteHunks(
        this.clonePath,
        files,
      );
      if (writeHunks.length === 0) {
        return {
          hunks: [],
          skipped: true,
          reason: "workingTree listed no readable files on disk",
          fromWorkingTree: true,
        };
      }
      this.proposals.push({
        agentId: agent.id,
        agentIndex: agent.index,
        hunks: writeHunks,
        timestamp: Date.now(),
      });
      return { hunks: writeHunks, skipped: false, fromWorkingTree: true };
    }

    if (parsed.hunks.length === 0) {
      return { hunks: [], skipped: true, reason: "no hunks produced" };
    }

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

  proposalCount(): number {
    return this.proposals.length;
  }

  /** Clear proposals (for testing or retry scenarios). */
  clear(): void {
    this.proposals = [];
  }
}

/** Read listed paths from clone and emit full-file write hunks. */
export async function snapshotWorkingTreeAsWriteHunks(
  clonePath: string,
  files: readonly string[],
): Promise<Hunk[]> {
  const out: Hunk[] = [];
  const seen = new Set<string>();
  for (const raw of files) {
    const file = raw.replace(/\\/g, "/").replace(/^\.\//, "").trim();
    if (!file || file.includes("..") || seen.has(file)) continue;
    seen.add(file);
    try {
      const abs = path.join(clonePath, file);
      const content = await fs.readFile(abs, "utf8");
      out.push({ op: "write", file, content });
    } catch {
      /* missing path — skip */
    }
  }
  return out;
}

/**
 * Build a prompt that instructs an agent to propose file changes during their turn.
 * Prefer git-native write/edit + workingTree when tools are available.
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
  lines.push(
    `PREFERRED (git-native): use write/edit tools on disk, then finish with:`,
  );
  lines.push(
    `{"workingTree":true,"message":"short subject","files":["path/to/file.ts"]}`,
  );
  lines.push("");
  lines.push(`FALLBACK — hunks envelope (search/replace):`);
  lines.push("");
  lines.push(`{`);
  lines.push(`  "hunks": [`);
  lines.push(
    `    { "op": "replace", "file": "path/to/file.ts", "search": "exact code to find", "replace": "new code" },`,
  );
  lines.push(
    `    { "op": "create", "file": "path/to/new.ts", "content": "file content" },`,
  );
  lines.push(
    `    { "op": "append", "file": "path/to/file.ts", "content": "text to append" }`,
  );
  lines.push(`  ]`);
  lines.push(`}`);
  lines.push("");
  lines.push(`Guidelines:`);
  lines.push(`- Prefer workingTree after real write/edit tool use.`);
  lines.push(`- For hunks: "replace" search must match EXACTLY once.`);
  lines.push(`- Keep changes minimal and atomic.`);
  lines.push(
    `If you cannot implement anything, return { "hunks": [], "skip": "reason" }`,
  );
  lines.push("");
  lines.push(`Now propose your changes:`);

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
  files: string[],
): Promise<Record<string, string | null>> {
  const result: Record<string, string | null> = {};
  for (const file of files) {
    try {
      const absPath = path.join(clonePath, file);
      result[file] = await fs.readFile(absPath, "utf8");
    } catch {
      result[file] = null;
    }
  }
  return result;
}
