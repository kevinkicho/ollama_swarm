// Extracted from BlackboardRunner.ts — self-contained deliverable writer.
// Takes a narrow context object instead of referencing `this.*`.

import path from "node:path";
import type { Agent } from "../../services/AgentManager.js";
import type { RunConfig } from "../SwarmRunner.js";
import type { ExitContract, Todo } from "./types.js";
import type { TranscriptEntry } from "../../types.js";
import type { PerAgentStat, RunSummary } from "./summary.js";
import { buildPRDescription, type PRCommitEntry, type PRCriterionEntry } from "./prDescription.js";
import { detectAntiPatterns, formatAntiPatternsMarkdown } from "./diffCritic.js";
import { detectCoverageGaps, formatCoverageGapsMarkdown } from "./coverageGap.js";
import { writeDeliverable, runQualityPasses } from "../deliverable.js";

export interface DeliverableContext {
  cfg: RunConfig;
  runStartedAt: number | undefined;
  contract: ExitContract | undefined;
  transcript: TranscriptEntry[];
  autoRollbacks: Array<{
    criterionId: string;
    resetTo: string;
    commitsUnwound: string[];
    reason: string;
    refusedCollateral?: string[];
    timestamp: number;
  }>;
  planner: Agent | undefined;
  manager: { list: () => Agent[] };
  repos: { listRepoFiles: (p: string, opts?: { maxFiles?: number }) => Promise<string[]> };
  appendSystem: (msg: string, meta?: Record<string, unknown>) => void;
}

export async function writeBlackboardDeliverable(ctx: DeliverableContext): Promise<void> {
  if (!ctx.cfg.runId) return;

  let commits: PRCommitEntry[] = [];
  let touchedFiles: string[] = [];
  let diff = "";
  try {
    const { simpleGit } = await import("simple-git");
    const git = simpleGit(ctx.cfg.localPath);
    const startedAtIso = new Date(ctx.runStartedAt ?? Date.now()).toISOString();
    const log = await git.log({ "--since": startedAtIso });
    commits = log.all.map((c) => ({
      shaPrefix: c.hash.slice(0, 8),
      message: c.message,
      filesChanged: 0,
    }));
    if (commits.length > 0) {
      const baseRef = `HEAD~${commits.length}`;
      try {
        const namesOnly = await git.raw(["diff", "--name-only", baseRef, "HEAD"]);
        touchedFiles = namesOnly.split(/\r?\n/).filter((f) => f.trim().length > 0);
        diff = await git.raw(["diff", baseRef, "HEAD"]);
      } catch {
        touchedFiles = [];
        diff = "";
      }
    }
  } catch {
    // git unavailable or broken — proceed with empty commit list
  }

  const criteria = ctx.contract?.criteria ?? [];
  const latestVerdictByCriterionId = new Map<string, "verified" | "partial" | "false" | "unverifiable">();
  for (const e of ctx.transcript) {
    if (e.summary?.kind === "verifier_verdict" && e.summary.verdict) {
      // proposingAgentId is per-attempt; we want the LAST verdict per criterion.
      // The verifier_verdict envelope doesn't carry criterion ID directly —
      // it's tied to the todo description. Best-effort: skip when ambiguous.
    }
  }
  const prCriteria: PRCriterionEntry[] = criteria.map((c) => ({
    id: c.id,
    description: c.description,
    verdict:
      c.status === "met" ? "verified" :
      c.status === "wont-do" ? "unverifiable" :
      (latestVerdictByCriterionId.get(c.id) ?? "unmet"),
    ...(c.rationale ? { rationale: c.rationale } : {}),
  }));

  const stretchGoalsEntry = [...ctx.transcript].reverse().find((e) => e.summary?.kind === "stretch_goals");
  const stretchGoals: string[] =
    stretchGoalsEntry?.summary?.kind === "stretch_goals"
      ? stretchGoalsEntry.summary.goals
      : [];

  const verifyPassed: boolean | null = ctx.cfg.verifyCommand
    ? criteria.length === 0
      ? null
      : criteria.every((c) => c.status !== "wont-do")
    : null;

  const prMd = buildPRDescription({
    directive: ctx.cfg.userDirective ?? "",
    commits,
    verifyPassed,
    criteria: prCriteria,
    stretchGoals,
  });

  const antiPatterns = detectAntiPatterns(diff);

  let repoFiles: string[] = [];
  try {
    repoFiles = await ctx.repos.listRepoFiles(ctx.cfg.localPath, { maxFiles: 500 });
  } catch {
    repoFiles = [];
  }
  const gaps = detectCoverageGaps({
    directive: ctx.cfg.userDirective ?? "",
    criteriaExpectedFiles: criteria.map((c) => ({
      criterionId: c.id,
      expectedFiles: c.expectedFiles,
      verdict: c.status,
    })),
    touchedFiles,
    repoFiles,
  });

  const rollbackBody =
    ctx.autoRollbacks.length === 0
      ? ctx.cfg.autoRollback
        ? "_(no rollbacks fired — every criterion either met or had no attributed commits)_"
        : "_(auto-rollback disabled for this run; set `autoRollback: true` in cfg to enable)_"
      : ctx.autoRollbacks
          .map((r) => {
            if (r.commitsUnwound.length === 0) {
              return `- **${r.criterionId}** — ${r.reason}${r.refusedCollateral?.length ? ` (collateral: ${r.refusedCollateral.map((s) => s.slice(0, 8)).join(", ")})` : ""}`;
            }
            return `- **${r.criterionId}** — reset HEAD to \`${r.resetTo.slice(0, 8)}\`; unwound ${r.commitsUnwound.length} commit(s): ${r.commitsUnwound.map((s) => `\`${s.slice(0, 8)}\``).join(", ")}`;
          })
          .join("\n");

  const baseSections = [
    { title: "PR description", body: prMd },
    { title: "Anti-pattern findings (diff-aware critic)", body: formatAntiPatternsMarkdown(antiPatterns) },
    { title: "Coverage gaps", body: formatCoverageGapsMarkdown(gaps) },
    { title: "Auto-rollbacks fired", body: rollbackBody },
  ];

  const planner = ctx.planner ?? ctx.manager.list().find((a) => a.index === 1) ?? null;
  const sections = await runQualityPasses({
    baseSections,
    rubric: null,
    criticAgent: planner,
    manager: ctx.manager as any,
  });

  const result = writeDeliverable({
    preset: "blackboard",
    runId: ctx.cfg.runId,
    clonePath: ctx.cfg.localPath,
    title: "Blackboard run report",
    subtitle: `${commits.length} commit${commits.length === 1 ? "" : "s"} · ${criteria.filter((c) => c.status === "met").length}/${criteria.length} criteria met`,
    sections,
  });
  if (result.ok) {
    ctx.appendSystem(`Deliverable saved → ${result.filename}`, {
      kind: "deliverable",
      preset: "blackboard",
      filename: result.filename,
      fullPath: result.fullPath,
      bytes: result.bytes,
      sectionTitles: sections.map((s) => s.title),
    });

    // Canonical project-level copy using full runId (suggestion)
    try {
      const projectLogsDir = path.join(process.cwd(), "logs", ctx.cfg.runId);
      await import("node:fs/promises").then((fs) => fs.mkdir(projectLogsDir, { recursive: true }));
      const projDelivDir = path.join(projectLogsDir, "deliverable");
      await import("node:fs/promises").then((fs) => fs.mkdir(projDelivDir, { recursive: true }));
      const projPath = path.join(projDelivDir, result.filename);
      await import("node:fs/promises").then((fs) => fs.copyFile(result.fullPath, projPath));
      ctx.appendSystem(`Canonical project deliverable copied to ${projPath}`);
    } catch (e) {
      // best effort
    }
  } else {
    ctx.appendSystem(`Failed to write deliverable (${result.reason})`);
  }
}