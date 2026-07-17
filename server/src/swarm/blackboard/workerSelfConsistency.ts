/**
 * Hunk size repair + self-consistency K-vote + proposeCommit handoff.
 * Extracted from workerRunner.executeWorkerTodo.
 */

import type { Agent } from "../../services/AgentManager.js";
import type { Todo, CommitTier } from "./types.js";
import { applyHunks, type Hunk } from "./applyHunks.js";
import type { ProfileName } from "../../tools/ToolDispatcher.js";
import type { RunConfig } from "../SwarmRunner.js";
import type { TodoQueueWrappers } from "./todoQueueWrappers.js";
import {
  buildWorkerRepairPrompt,
  buildWorkerUserPrompt,
  parseWorkerResponse,
  validateHunkPayload,
  WORKER_SYSTEM_PROMPT,
  type WorkerSeed,
} from "./prompts/worker.js";
import { WORKER_HUNKS_JSON_SCHEMA } from "./prompts/jsonSchemas.js";
import { voteOnHunksWithJudge, type HunkVote, type JudgeFn } from "./hunkVoting.js";
import { buildJudgePrompt } from "./hunkJudgePrompt.js";
import { isPromptHaltError } from "./lifecycleState.js";
import { applyAndCommit } from "./WorkerPipeline.js";
import { realFilesystemAdapter, realGitAdapter, realVerifyAdapter } from "./v2Adapters.js";
import {
  buildDryRunFailurePromptAddendum,
  decideDryRunOutcome,
} from "../preflightDryRun.js";
import { EMIT_ONLY_PROFILE_ID } from "@ollama-swarm/shared/toolProfiles";
import {
  noteApplyMiss,
  noteRepairFailure,
  noteRepairSuccess,
} from "../applyIntegrityStats.js";
import { recordCycleFail } from "../cycleIntegrityStats.js";
import { applyOrGroundedRepair } from "../applyOrGroundedRepair.js";

export type SelfConsistencyOutcome = {
  outcome: "stale" | "aborted" | "pending-commit";
};

/**
 * After a repair re-prompt: accept repaired hunks only if pure applyHunks
 * succeeds against the given file map. Otherwise keep originals (fail-safe).
 * Pure + unit-testable — no I/O.
 */
export function acceptRepairedHunksIfApply(
  original: readonly Hunk[],
  repaired: readonly Hunk[],
  contents: Record<string, string | null>,
): { hunks: readonly Hunk[]; accepted: boolean; error?: string } {
  if (repaired.length === 0) {
    return { hunks: original, accepted: false, error: "empty repaired hunks" };
  }
  const dry = applyHunks(contents, repaired.slice() as Hunk[]);
  if (dry.ok) {
    return { hunks: repaired, accepted: true };
  }
  return { hunks: original, accepted: false, error: dry.error };
}

export interface WorkerSelfConsistencyCtx {
  isStopping: () => boolean;
  isDraining: () => boolean;
  getActive: () => RunConfig | undefined;
  getWrappers: () => TodoQueueWrappers;
  getWorkerPool: () => Agent[];
  getAuditor: () => Agent | undefined;
  getSelfConsistencyK: () => number;
  appendSystem: (msg: string) => void;
  appendAgent: (agent: Agent, text: string) => void;
  promptAgent: (
    agent: Agent,
    prompt: string,
    agentName: ProfileName,
    formatExpect: "json" | "free",
    ollamaFormat?: "json" | Record<string, unknown>,
    activity?: {
      kind?: string;
      label?: string;
      maxToolTurns?: number;
      mode?: "explore" | "emit";
      promptWallClockMs?: number;
    },
  ) => Promise<string>;
  bumpJsonRepairs: (agentId: string) => void;
  bumpPromptErrors: (agentId: string) => void;
  bumpRejectedAttempts: (agentId: string) => void;
  workerToolProfile: (kind: "hunk" | "build" | "read") => ProfileName;
}

/**
 * After a successful parse with hunks: size-repair if needed, optional K-vote,
 * then proposeCommit for auditor approval.
 */
export async function finalizeWorkerHunks(
  ctx: WorkerSelfConsistencyCtx,
  agent: Agent,
  todo: Todo,
  seed: WorkerSeed,
  response: string,
  parsedIn: Extract<ReturnType<typeof parseWorkerResponse>, { ok: true }>,
  commitTierIn: CommitTier,
): Promise<SelfConsistencyOutcome> {
  let parsed = parsedIn;
  let commitTier = commitTierIn;

  if (parsed.hunks.length === 0) {
    ctx.getWrappers().failTodoQ(
      todo.id,
      "[v2] worker returned empty hunks with no skip reason",
      "hunk-empty",
    );
    ctx.bumpRejectedAttempts(agent.id);
    return { outcome: "stale" };
  }

  const sizeCheck = validateHunkPayload(parsed.hunks);
  if (!sizeCheck.ok) {
    ctx.bumpJsonRepairs(agent.id);
    ctx.appendSystem(
      `[${agent.id}] [v2] hunk payload oversized (${sizeCheck.reason}); issuing repair prompt.`,
    );
    let sizeRepair: string;
    try {
      sizeRepair = await ctx.promptAgent(
        agent,
        `${WORKER_SYSTEM_PROMPT}\n\n${buildWorkerRepairPrompt(response, sizeCheck.reason)}`,
        ctx.workerToolProfile("hunk"),
        "json",
        WORKER_HUNKS_JSON_SCHEMA,
        { kind: "worker", label: `hunk-size-repair ${todo.id.slice(0, 8)}` },
      );
    } catch (err) {
      if (isPromptHaltError(err, ctx.isStopping, ctx.isDraining)) {
        return { outcome: "aborted" };
      }
      const msg = err instanceof Error ? err.message : String(err);
      ctx.getWrappers().failTodoQ(todo.id, `[v2] hunk size repair prompt failed: ${msg}`, "repair");
      ctx.bumpPromptErrors(agent.id);
      ctx.bumpRejectedAttempts(agent.id);
      return { outcome: "stale" };
    }
    if (ctx.isStopping()) return { outcome: "aborted" };
    ctx.appendAgent(agent, sizeRepair);
    const repaired = parseWorkerResponse(sizeRepair, todo.expectedFiles);
    if (!repaired.ok || repaired.hunks.length === 0) {
      ctx.getWrappers().failTodoQ(
        todo.id,
        `[v2] hunk size repair failed: ${!repaired.ok ? repaired.reason : "empty hunks"}`,
        "hunk-oversized",
      );
      ctx.bumpRejectedAttempts(agent.id);
      return { outcome: "stale" };
    }
    const repairedSize = validateHunkPayload(repaired.hunks);
    if (!repairedSize.ok) {
      ctx.getWrappers().failTodoQ(
        todo.id,
        `[v2] hunk still oversized after repair: ${repairedSize.reason}`,
        "hunk-oversized",
      );
      ctx.bumpRejectedAttempts(agent.id);
      return { outcome: "stale" };
    }
    parsed = repaired;
    commitTier = "repair";
  }

  const k = ctx.getSelfConsistencyK();
  let hunksToCommit: readonly Hunk[] = parsed.hunks;
  if (k > 1) {
    const initialVotes: HunkVote[] = [{ workerId: `${agent.id}#1`, hunks: parsed.hunks }];
    const otherWorkers = ctx.getWorkerPool().filter((w) => w.id !== agent.id);
    const fanoutAgents: Agent[] = Array.from({ length: k - 1 }, (_, idx) => {
      if (otherWorkers.length === 0) return agent;
      return otherWorkers[idx % otherWorkers.length]!;
    });
    ctx.appendSystem(
      `[${agent.id}] [v2] self-consistency K=${k} fan-out across ${
        otherWorkers.length > 0
          ? `${new Set(fanoutAgents.map((a) => a.id)).size + 1} agents (${[agent.id, ...new Set(fanoutAgents.map((a) => a.id))].join(", ")})`
          : "1 agent (single-worker setup)"
      }`,
    );
    const extraPromises = Array.from({ length: k - 1 }, (_, idx) =>
      ctx
        .promptAgent(
          fanoutAgents[idx]!,
          `${WORKER_SYSTEM_PROMPT}\n\n${buildWorkerUserPrompt(seed)}`,
          ctx.workerToolProfile("hunk"),
          "json",
          WORKER_HUNKS_JSON_SCHEMA,
        )
        .then((resp) => ({
          ok: true as const,
          idx: idx + 2,
          response: resp,
          workerId: fanoutAgents[idx]!.id,
        }))
        .catch((err) => ({
          ok: false as const,
          idx: idx + 2,
          err,
          workerId: fanoutAgents[idx]!.id,
        })),
    );
    const settled = await Promise.allSettled(extraPromises);
    if (ctx.isStopping()) return { outcome: "aborted" };
    for (const s of settled) {
      if (s.status === "rejected") continue;
      const r = s.value;
      if (!r.ok) {
        ctx.appendSystem(
          `[${r.workerId}] [v2] self-consistency attempt ${r.idx}/${k} prompt failed: ${
            r.err instanceof Error ? r.err.message : String(r.err)
          } — excluded from vote`,
        );
        continue;
      }
      const sourceAgent = ctx.getWorkerPool().find((w) => w.id === r.workerId) ?? agent;
      ctx.appendAgent(sourceAgent, r.response);
      const extraParsed = parseWorkerResponse(r.response, todo.expectedFiles);
      if (!extraParsed.ok) {
        ctx.appendSystem(
          `[${r.workerId}] [v2] self-consistency attempt ${r.idx}/${k} parse failed: ${extraParsed.reason} — excluded from vote`,
        );
        continue;
      }
      if (extraParsed.skip || extraParsed.hunks.length === 0) {
        ctx.appendSystem(
          `[${r.workerId}] [v2] self-consistency attempt ${r.idx}/${k} declined or empty — excluded from vote`,
        );
        continue;
      }
      initialVotes.push({ workerId: `${r.workerId}#${r.idx}`, hunks: extraParsed.hunks });
    }

    const judgeAgent = ctx.getAuditor() ?? agent;
    const judgeFn: JudgeFn = async (candidates) => {
      if (ctx.isStopping()) return null;
      const judgePrompt = buildJudgePrompt({
        todoDescription: todo.description,
        expectedFiles: todo.expectedFiles,
        candidates,
      });
      let judgeResponse: string;
      try {
        judgeResponse = await ctx.promptAgent(
          judgeAgent,
          judgePrompt,
          ctx.workerToolProfile("read"),
          "json",
          {
            type: "object",
            properties: {
              winner: { type: "integer", minimum: 1, maximum: candidates.length },
            },
            required: ["winner"],
          },
        );
        ctx.appendAgent(judgeAgent, judgeResponse);
      } catch (err) {
        ctx.appendSystem(
          `[${agent.id}] [v2] LLM-judge call failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      }
      try {
        const j = JSON.parse(judgeResponse);
        const winnerIdx = typeof j.winner === "number" ? j.winner : -1;
        if (winnerIdx < 1 || winnerIdx > candidates.length) return null;
        return candidates[winnerIdx - 1]!.id;
      } catch (err) {
        ctx.appendSystem(
          `⚠ worker [judge-parse]: ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      }
    };

    const verdict = await voteOnHunksWithJudge(initialVotes, judgeFn);
    ctx.appendSystem(
      `[${agent.id}] [v2] self-consistency vote: ${verdict.agreementCount}/${verdict.totalConsidered} agreed` +
        ` · ${verdict.distinctShapes} distinct shape(s)` +
        ` · ${verdict.unanimous ? "unanimous" : verdict.hasMajority ? "majority" : `tiebreak=${verdict.tiebreak}`}`,
    );
    if (!verdict.winner) {
      ctx.getWrappers().failTodoQ(
        todo.id,
        "[v2] self-consistency: zero eligible votes after K attempts",
      );
      ctx.bumpRejectedAttempts(agent.id);
      return { outcome: "stale" };
    }
    hunksToCommit = verdict.winner;
  }

  // Grounded apply preflight via shared applyOrGroundedRepair (RR-A).
  // Never propose hunks that pure apply failed unless repair dry-run accepts.
  const cfg = ctx.getActive();
  const clonePathForRepair = cfg?.localPath?.trim() ?? "";
  if (clonePathForRepair && hunksToCommit.length > 0) {
    const fsForRepair = realFilesystemAdapter(clonePathForRepair);
    const contents: Record<string, string | null> = {};
    for (const file of todo.expectedFiles) {
      try {
        contents[file] = await fsForRepair.read(file);
      } catch {
        contents[file] = null;
      }
    }
    const runIdForStats = cfg?.runId;
    const grounded = await applyOrGroundedRepair({
      hunks: hunksToCommit.slice() as Hunk[],
      currentTextsByFile: contents,
      expectedFiles: [...todo.expectedFiles],
      readFile: async (p) => {
        try {
          return await fsForRepair.read(p);
        } catch {
          return null;
        }
      },
      callModel: async (repairPrompt) => {
        ctx.appendSystem(
          `[${agent.id}] [apply-miss] applyOrGroundedRepair — grounded hunk repair (no literature)`,
        );
        try {
          const repairResponse = await ctx.promptAgent(
            agent,
            `${WORKER_SYSTEM_PROMPT}\n\n${repairPrompt}`,
            EMIT_ONLY_PROFILE_ID,
            "json",
            WORKER_HUNKS_JSON_SCHEMA,
            {
              kind: "worker",
              label: `hunk-repair ${todo.id.slice(0, 8)}`,
              maxToolTurns: 1,
              mode: "emit",
            },
          );
          if (repairResponse) ctx.appendAgent(agent, repairResponse);
          return repairResponse ?? "";
        } catch (err) {
          if (isPromptHaltError(err, ctx.isStopping, ctx.isDraining)) {
            throw err;
          }
          throw err;
        }
      },
      maxGroundedRepairs: 1,
    });

    if (ctx.isStopping()) return { outcome: "aborted" };

    if (grounded.ok && grounded.hunks) {
      if (grounded.repaired) {
        const originalMissKind = grounded.miss?.kind ?? "other";
        noteApplyMiss(originalMissKind, runIdForStats);
        noteRepairSuccess(runIdForStats);
        hunksToCommit = grounded.hunks;
        commitTier = "repair";
        ctx.appendSystem(
          `[${agent.id}] [apply-miss] ` +
            (grounded.deterministicCandidate
              ? "deterministic uniqueCandidates[0] ok"
              : "hunk repair dry-run ok") +
            " — proposing repaired hunks",
        );
      }
      // pure apply ok with no repair: keep original hunksToCommit
    } else {
      const originalMissKind = grounded.miss?.kind ?? "other";
      noteApplyMiss(originalMissKind, runIdForStats);
      if (grounded.repairAttempts > 0) {
        noteRepairFailure(runIdForStats);
      }
      const failMsg = (grounded.error ?? "apply dry-run failed").slice(0, 500);
      if (grounded.miss) {
        try {
          ctx.getWrappers().setLastApplyMissQ(todo.id, {
            file: grounded.miss.file,
            kind: grounded.miss.kind,
            op: grounded.miss.op,
            needle: grounded.miss.needle,
            matchCount: grounded.miss.matchCount,
            message: grounded.miss.message,
            uniqueCandidates: grounded.miss.uniqueCandidates,
            nearbyExcerpt: grounded.miss.nearbyExcerpt,
            at: Date.now(),
          });
        } catch {
          /* optional */
        }
      }
      ctx.appendSystem(
        `[${agent.id}] [apply-miss] unrepaired dry-run fail — failing todo (not proposing)`,
      );
      ctx.getWrappers().failTodoQ(todo.id, failMsg, "hunk-fail");
      recordCycleFail(failMsg, runIdForStats);
      ctx.bumpRejectedAttempts(agent.id);
      return { outcome: "stale" };
    }
  }

  // Q10: optional pre-flight verify dry-run before proposeCommit.
  // Requires cfg.preflightDryRun + cfg.verifyCommand. Applies hunks,
  // runs verify, reverts always — never leaves dirty tree or commits.
  const verifyCommand = cfg?.verifyCommand?.trim();
  if (cfg?.preflightDryRun && verifyCommand) {
    const clonePath = cfg.localPath ?? "";
    ctx.appendSystem(
      `[${agent.id}] [preflightDryRun] applying ${hunksToCommit.length} hunk(s) + \`${verifyCommand}\` (revert after)`,
    );
    try {
      const dry = await applyAndCommit({
        todoId: todo.id,
        workerId: agent.id,
        expectedFiles: todo.expectedFiles,
        hunks: hunksToCommit,
        fs: realFilesystemAdapter(clonePath),
        git: realGitAdapter(clonePath),
        verify: realVerifyAdapter(clonePath, verifyCommand),
        auditorApproved: true,
        dryRunOnly: true,
        expectedAnchors: todo.expectedAnchors,
        runId: cfg?.runId,
      });
      if (!dry.ok) {
        const reason = dry.reason;
        const retriesSoFar = Number((todo as unknown as { retries?: number }).retries) || 0;
        const exitMatch = /exited (?:with code |non-zero:?\s*)(-?\d+)/i.exec(reason);
        const exitCode = exitMatch ? Number(exitMatch[1]) : NaN;
        const outcome = decideDryRunOutcome({
          result: {
            ok: false,
            exitCode: Number.isFinite(exitCode) ? exitCode : 1,
            stderr: reason,
          },
          retriesSoFar,
        });
        const addendum = buildDryRunFailurePromptAddendum({
          exitCode: Number.isFinite(exitCode) ? exitCode : 1,
          stderr: reason,
          retriesSoFar,
        });
        if (outcome === "skip") {
          ctx.getWrappers().skipTodoQ(
            todo.id,
            `[preflightDryRun] verify exhausted retries — ${reason.slice(0, 400)}`,
          );
          ctx.appendSystem(
            `[${agent.id}] [preflightDryRun] skip after ${retriesSoFar} retries: ${reason.slice(0, 200)}`,
          );
        } else {
          ctx.getWrappers().failTodoQ(
            todo.id,
            `[preflightDryRun] verify failed — replan\n${addendum}`,
            "hunk-fail",
          );
          ctx.appendSystem(
            `[${agent.id}] [preflightDryRun] replan (${retriesSoFar} prior): ${reason.slice(0, 200)}`,
          );
        }
        ctx.bumpRejectedAttempts(agent.id);
        return { outcome: "stale" };
      }
      ctx.appendSystem(
        `[${agent.id}] [preflightDryRun] verify ok (${dry.filesWritten.length} file(s) would change) — proposing for auditor`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.appendSystem(`[${agent.id}] [preflightDryRun] exception: ${msg}`);
      ctx.getWrappers().failTodoQ(
        todo.id,
        `[preflightDryRun] exception: ${msg}`,
        "hunk-fail",
      );
      ctx.bumpRejectedAttempts(agent.id);
      return { outcome: "stale" };
    }
  }

  try {
    ctx.getWrappers().proposeCommitQ(
      todo.id,
      hunksToCommit as readonly unknown[],
      todo.expectedFiles,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.appendSystem(`[${agent.id}] proposeCommit failed: ${msg}`);
    ctx.getWrappers().failTodoQ(todo.id, `proposeCommit failed: ${msg}`, "hunk-fail");
    ctx.bumpRejectedAttempts(agent.id);
    return { outcome: "stale" };
  }
  ctx.appendSystem(
    `[${agent.id}] ✓ proposed ${hunksToCommit.length} hunk(s) for todo ${todo.id.slice(0, 8)} — awaiting auditor approval`,
  );
  void commitTier; // retained for future auditor-gated commit metrics
  return { outcome: "pending-commit" };
}
