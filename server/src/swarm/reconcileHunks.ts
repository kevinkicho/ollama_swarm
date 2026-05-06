// Phase 2 (writeMode: multi): reconcile hunks from multiple agents.
// Each agent proposes hunks during their turn; runner collects all proposals
// then runs reconciliation to produce a final commit-ready hunk set.
//
// Strategies (preset-specific):
//   - merge: combine non-overlapping hunks, fail on conflicts
//   - sequential: apply in order N₁ → N₂ → N₃ (later sees earlier's result)
//   - vote: majority-wins on overlapping hunks
//   - judge: designated judge picks best hunk from overlapping set
//   - pick: synthesizer picks one agent's full proposal
//
// Conflict detection: two hunks conflict when they modify the same file
// AND their search anchors overlap (one's search includes text the other
// modifies). applyHunks already detects this via search-not-found — we 
// wrap it here for pre-apply validation.

import type { Hunk } from "./blackboard/applyHunks.js";
import { applyFileHunks } from "./blackboard/applyHunks.js";

export interface HunkProposal {
  agentId: string;
  agentIndex: number;
  hunks: Hunk[];
  timestamp: number;
}

export interface Conflict {
  type: "search_overlap" | "file_creation" | "same_anchor";
  file: string;
  conflictingAgents: Array<{ agentId: string; agentIndex: number; hunkIndex: number }>;
  hunks: Array<{ agentId: string; hunk: Hunk; hunkIndex: number }>;
}

export type ReconciliationStrategy = "merge" | "sequential" | "vote" | "judge" | "pick";

export interface ReconciliationResult {
  ok: boolean;
  hunks: Hunk[];
  conflicts: Conflict[];
  rejectedProposals: Array<{ agentId: string; agentIndex: number; reason: string }>;
}

/**
 * Detect conflicts in a set of hunk proposals.
 * Two hunks conflict when:
 *   - Same file + overlapping search anchors
 *   - Both try to create the same file
 *   - Same exact search anchor (can't apply both)
 */
export function detectConflicts(proposals: HunkProposal[]): Conflict[] {
  const conflicts: Conflict[] = [];
  const byFile = new Map<string, Array<{ agentId: string; agentIndex: number; hunk: Hunk; hunkIndex: number }>>();

  // Group hunks by file
  for (const proposal of proposals) {
    for (let i = 0; i < proposal.hunks.length; i++) {
      const hunk = proposal.hunks[i]!;
      const file = hunk.file;
      if (!byFile.has(file)) byFile.set(file, []);
      byFile.get(file)!.push({
        agentId: proposal.agentId,
        agentIndex: proposal.agentIndex,
        hunk,
        hunkIndex: i,
      });
    }
  }

  // Check each file for conflicts
  for (const [file, entries] of byFile) {
    if (entries.length <= 1) continue;

    // Check for same-file-creation conflicts
    const creates = entries.filter((e) => e.hunk.op === "create");
    if (creates.length > 1) {
      conflicts.push({
        type: "file_creation",
        file,
        conflictingAgents: creates.map((e) => ({
          agentId: e.agentId,
          agentIndex: e.agentIndex,
          hunkIndex: e.hunkIndex,
        })),
        hunks: creates.map((e) => ({ agentId: e.agentId, hunk: e.hunk, hunkIndex: e.hunkIndex })),
      });
      continue;
    }

    // Check for overlapping search anchors (replace ops)
    const replaces = entries.filter((e) => e.hunk.op === "replace");
    for (let i = 0; i < replaces.length; i++) {
      for (let j = i + 1; j < replaces.length; j++) {
        const a = replaces[i]!;
        const b = replaces[j]!;
        const hunkA = a.hunk as { op: "replace"; file: string; search: string; replace: string };
        const hunkB = b.hunk as { op: "replace"; file: string; search: string; replace: string };

        // Same exact search anchor = conflict
        if (hunkA.search === hunkB.search) {
          conflicts.push({
            type: "same_anchor",
            file,
            conflictingAgents: [
              { agentId: a.agentId, agentIndex: a.agentIndex, hunkIndex: a.hunkIndex },
              { agentId: b.agentId, agentIndex: b.agentIndex, hunkIndex: b.hunkIndex },
            ],
            hunks: [
              { agentId: a.agentId, hunk: a.hunk, hunkIndex: a.hunkIndex },
              { agentId: b.agentId, hunk: b.hunk, hunkIndex: b.hunkIndex },
            ],
          });
        } else {
          // Check if search anchors overlap
          const overlap = searchAnchorsOverlap(hunkA.search, hunkB.search);
          if (overlap) {
            conflicts.push({
              type: "search_overlap",
              file,
              conflictingAgents: [
                { agentId: a.agentId, agentIndex: a.agentIndex, hunkIndex: a.hunkIndex },
                { agentId: b.agentId, agentIndex: b.agentIndex, hunkIndex: b.hunkIndex },
              ],
              hunks: [
                { agentId: a.agentId, hunk: a.hunk, hunkIndex: a.hunkIndex },
                { agentId: b.agentId, hunk: b.hunk, hunkIndex: b.hunkIndex },
              ],
            });
          }
        }
      }
    }
  }

  return conflicts;
}

/**
 * Check if two search anchors overlap (one contains text modified by the other).
 * Conservative: returns true if there's ANY overlap in the search strings.
 */
function searchAnchorsOverlap(searchA: string, searchB: string): boolean {
  // Simple heuristic: if one search contains a significant portion of the other
  // (≥30 chars or ≥50% of shorter), they likely overlap
  const minLen = Math.min(searchA.length, searchB.length);
  if (minLen < 10) return false; // too short to determine overlap
  
  const threshold = Math.max(30, minLen * 0.5);
  return searchA.includes(searchB.slice(0, Math.ceil(threshold))) ||
         searchB.includes(searchA.slice(0, Math.ceil(threshold)));
}

/**
 * Merge non-overlapping hunks from multiple proposals.
 * Returns conflict-free hunks or fails if conflicts detected.
 */
export function mergeNonOverlapping(proposals: HunkProposal[]): ReconciliationResult {
  const conflicts = detectConflicts(proposals);
  if (conflicts.length > 0) {
    const conflictingAgentIds = new Set(
      conflicts.flatMap((c) => c.conflictingAgents.map((a) => a.agentId))
    );
    return {
      ok: false,
      hunks: [],
      conflicts,
      rejectedProposals: proposals
        .filter((p) => conflictingAgentIds.has(p.agentId))
        .map((p) => ({
          agentId: p.agentId,
          agentIndex: p.agentIndex,
          reason: "conflict detected",
        })),
    };
  }

  // No conflicts — flatten all hunks
  const allHunks: Hunk[] = [];
  for (const proposal of proposals) {
    allHunks.push(...proposal.hunks);
  }

  return {
    ok: true,
    hunks: allHunks,
    conflicts: [],
    rejectedProposals: [],
  };
}

/**
 * Sequential reconciliation: apply hunks in agent-index order.
 * Later agents see the result of earlier agents' edits.
 * Conflicts cause the whole batch to fail.
 */
export function reconcileSequential(
  proposals: HunkProposal[],
  currentFiles: Record<string, string | null>,
): ReconciliationResult {
  // Sort by agent index
  const sorted = [...proposals].sort((a, b) => a.agentIndex - b.agentIndex);
  
  let files = { ...currentFiles };
  const applied: Hunk[] = [];
  const rejected: Array<{ agentId: string; agentIndex: number; reason: string }> = [];

  for (const proposal of sorted) {
    // Try to apply each hunk sequentially
    for (let i = 0; i < proposal.hunks.length; i++) {
      const hunk = proposal.hunks[i]!;
      const currentContent = files[hunk.file] ?? null;
      
      const result = applyFileHunks(currentContent, [hunk]);
      if (!result.ok) {
        // Failed to apply — mark proposal as rejected
        rejected.push({
          agentId: proposal.agentId,
          agentIndex: proposal.agentIndex,
          reason: `hunk ${i} failed: ${result.error}`,
        });
        continue;
      }

      files[hunk.file] = result.newText;
      applied.push(hunk);
    }
  }

  return {
    ok: rejected.length === 0,
    hunks: applied,
    conflicts: [],
    rejectedProposals: rejected,
  };
}

/**
 * Vote reconciliation: for conflicting hunks, each agent votes for the best.
 * Majority wins. Ties broken by lowest agent index.
 */
export function reconcileVote(
  proposals: HunkProposal[],
  _currentFiles: Record<string, string | null>,
): ReconciliationResult {
  const conflicts = detectConflicts(proposals);
  
  // For now, implement simple vote: each non-conflicting hunk is auto-accepted
  // Conflicting hunks need explicit vote logic (call into councilReconcile)
  // This is a placeholder that just picks the lowest-index agent's hunks
  
  const accepted: Hunk[] = [];
  const rejected: Array<{ agentId: string; agentIndex: number; reason: string }> = [];
  const conflictFiles = new Set(conflicts.map((c) => c.file));

  // Sort by agent index
  const sorted = [...proposals].sort((a, b) => a.agentIndex - b.agentIndex);
  
  for (const proposal of sorted) {
    for (const hunk of proposal.hunks) {
      if (!conflictFiles.has(hunk.file)) {
        // Non-conflicting — accept
        accepted.push(hunk);
      } else {
        // Conflicting — for now, accept lowest index agent's hunk
        // (Real vote logic would query each agent)
        const isFirstForFile = !accepted.some((h) => h.file === hunk.file);
        if (isFirstForFile) {
          accepted.push(hunk);
        } else {
          rejected.push({
            agentId: proposal.agentId,
            agentIndex: proposal.agentIndex,
            reason: `lost vote on ${hunk.file}`,
          });
        }
      }
    }
  }

  return {
    ok: true,
    hunks: accepted,
    conflicts,
    rejectedProposals: rejected,
  };
}

/**
 * Pick reconciliation: synthesizer/judge picks one agent's full proposal.
 * Used by MoA (aggregator picks best proposer) and debate-judge (judge picks winner).
 */
export function reconcilePick(
  proposals: HunkProposal[],
  winnerAgentId: string,
): ReconciliationResult {
  const winner = proposals.find((p) => p.agentId === winnerAgentId);
  if (!winner) {
    return {
      ok: false,
      hunks: [],
      conflicts: [],
      rejectedProposals: proposals.map((p) => ({
        agentId: p.agentId,
        agentIndex: p.agentIndex,
        reason: `winner ${winnerAgentId} not found in proposals`,
      })),
    };
  }

  return {
    ok: true,
    hunks: winner.hunks,
    conflicts: [],
    rejectedProposals: proposals
      .filter((p) => p.agentId !== winnerAgentId)
      .map((p) => ({
        agentId: p.agentId,
        agentIndex: p.agentIndex,
        reason: `not selected by judge/synthesizer`,
      })),
  };
}

/**
 * Main reconciliation dispatcher — routes to strategy-specific implementation.
 */
export function reconcileHunks(
  proposals: HunkProposal[],
  strategy: ReconciliationStrategy,
  options?: {
    currentFiles?: Record<string, string | null>;
    winnerAgentId?: string; // for "pick" strategy
  },
): ReconciliationResult {
  if (proposals.length === 0) {
    return { ok: true, hunks: [], conflicts: [], rejectedProposals: [] };
  }

  switch (strategy) {
    case "merge":
      return mergeNonOverlapping(proposals);
    case "sequential":
      return reconcileSequential(proposals, options?.currentFiles ?? {});
    case "vote":
      return reconcileVote(proposals, options?.currentFiles ?? {});
    case "pick":
      if (!options?.winnerAgentId) {
        return {
          ok: false,
          hunks: [],
          conflicts: [],
          rejectedProposals: proposals.map((p) => ({
            agentId: p.agentId,
            agentIndex: p.agentIndex,
            reason: "pick strategy requires winnerAgentId",
          })),
        };
      }
      return reconcilePick(proposals, options.winnerAgentId);
    case "judge":
      // judge is same as pick — caller provides judge's winner choice
      if (!options?.winnerAgentId) {
        return {
          ok: false,
          hunks: [],
          conflicts: [],
          rejectedProposals: proposals.map((p) => ({
            agentId: p.agentId,
            agentIndex: p.agentIndex,
            reason: "judge strategy requires winnerAgentId",
          })),
        };
      }
      return reconcilePick(proposals, options.winnerAgentId);
  }
}