// Extracted from BlackboardRunner.ts — auto-rollback orchestrator.
// For every criterion ending at status="unmet" with attributed commits,
// tries to roll back those commits via git reset. Refuses when there's
// collateral (commits from OTHER criteria interleaved chronologically).

import type { ExitContract } from "./types.js";
import type { RunConfig } from "../SwarmRunner.js";
import { rollbackTodoCommits } from "./todoRollback.js";

export interface AutoRollbackEntry {
  criterionId: string;
  resetTo: string;
  commitsUnwound: string[];
  reason: string;
  refusedCollateral?: string[];
  timestamp: number;
}

export interface AutoRollbackContext {
  cfg: RunConfig;
  contract: ExitContract | undefined;
  commitsByCriterion: Map<string, string[]>;
  autoRollbacks: AutoRollbackEntry[];
  appendSystem: (msg: string) => void;
}

export async function runAutoRollbacks(ctx: AutoRollbackContext): Promise<void> {
  const { cfg } = ctx;
  if (!cfg) return;
  const criteria = ctx.contract?.criteria ?? [];
  const targets = criteria.filter(
    (c) => c.status === "unmet" && (ctx.commitsByCriterion.get(c.id)?.length ?? 0) > 0,
  );
  if (targets.length === 0) {
    ctx.appendSystem(`[auto-rollback] No criteria ended unmet with attributed commits — nothing to roll back.`);
    return;
  }
  const allAttributed = new Map<string, string[]>();
  for (const [criterionId, shas] of ctx.commitsByCriterion) {
    for (const sha of shas) {
      const list = allAttributed.get(sha) ?? [];
      if (!list.includes(criterionId)) list.push(criterionId);
      allAttributed.set(sha, list);
    }
  }
  for (const target of targets) {
    const shasToRollback = ctx.commitsByCriterion.get(target.id) ?? [];
    const collateral: string[] = [];
    for (const sha of shasToRollback) {
      const otherCriteria = (allAttributed.get(sha) ?? []).filter((cid) => cid !== target.id);
      for (const cid of otherCriteria) {
        const otherCrit = criteria.find((c) => c.id === cid);
        if (otherCrit && (otherCrit.status === "met" || otherCrit.status === "wont-do")) {
          if (!collateral.includes(sha)) collateral.push(sha);
        }
      }
    }
    if (collateral.length > 0) {
      ctx.appendSystem(
        `[auto-rollback] Refused for criterion ${target.id}: ${collateral.length} commit(s) shared with met/wont-do criteria (would wipe their work). Manual git intervention needed.`,
      );
      ctx.autoRollbacks.push({
        criterionId: target.id,
        resetTo: "",
        commitsUnwound: [],
        reason: "refused: collateral with met/wont-do criteria",
        refusedCollateral: collateral,
        timestamp: Date.now(),
      });
      continue;
    }
    const result = await rollbackTodoCommits({
      clonePath: cfg.localPath,
      commitShas: shasToRollback,
      reason: `Criterion ${target.id} ended unmet with attributed commits`,
    });
    if (result.ok) {
      ctx.appendSystem(
        `[auto-rollback] Criterion ${target.id} (unmet) → reset HEAD to ${result.resetTo?.slice(0, 8)}; commits unwound: ${shasToRollback.map((s) => s.slice(0, 8)).join(", ")}`,
      );
      ctx.autoRollbacks.push({
        criterionId: target.id,
        resetTo: result.resetTo ?? "",
        commitsUnwound: [...shasToRollback],
        reason: `criterion ended unmet`,
        timestamp: Date.now(),
      });
    } else {
      ctx.appendSystem(
        `[auto-rollback] Failed for criterion ${target.id}: ${result.error}`,
      );
      ctx.autoRollbacks.push({
        criterionId: target.id,
        resetTo: "",
        commitsUnwound: [],
        reason: `git reset failed: ${result.error}`,
        timestamp: Date.now(),
      });
    }
  }
}