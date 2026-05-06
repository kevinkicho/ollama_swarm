// 2026-05-03 (Phase D of shared-layer refactor): the finally close-out
// block 8 discussion runners had near-identically copied. Pre-extraction
// state (the audit's Pattern 3):
//   1. End-of-run reflection (runEndReflection): 6/8 use lead agent
//      (index 1); Debate uses index 3 (judge) with index-1 fallback;
//      MoA omits reflection entirely.
//   2. writeSummary: every runner.
//   3. killAll + setPhase("completed"): every runner; MoA additionally
//      guards setPhase with `phase !== "failed"` because its loop
//      sets phase=failed inline on aggregator failures.
//
// Each runner's contextSummary string for runEndReflection is bespoke
// (`${preset} preset · ${role-noun-roster} · ran X/Y ${unit}s`) but
// the structure is identical — accommodated via a buildReflectionContext
// hook callback.
//
// CALLER STILL OWNS: writeSummary itself, because it touches private
// `summaryWritten` + `startedAt` fields. Helper takes writeSummary as
// a callback fired between reflection and killAll.

import { runEndReflection } from "./runEndReflection.js";
import { formatPortReleaseLine } from "./runSummary.js";
import { scoreRun, appendOutcomeHistory, outcomeToMarkdown, type RunOutcome } from "./outcomeScorer.js";
import type { Agent, AgentManager } from "../services/AgentManager.js";
import type { RunConfig } from "./SwarmRunner.js";
import type { SwarmPhase } from "../types.js";

/** Hooks for per-preset variation in the finally close-out. */
export interface CloseOutHooks {
  /** Pick the agent for runEndReflection. Return null to skip
   *  reflection (MoA case). When omitted, defaults to skipping. */
  pickReflectionAgent?: (manager: AgentManager) => Agent | null;
  /** Build runEndReflection's contextSummary string. Called only when
   *  pickReflectionAgent returned an agent. Defaults to a bare
   *  preset-name fallback if omitted (rare — runners should provide). */
  buildReflectionContext?: (state: { round: number; earlyStopDetail?: string }) => string;
  /** Optional: returns true to fire setPhase("completed"). Defaults to
   *  always true (every runner except MoA which guards on
   *  `phase !== "failed"`). */
  shouldSetCompleted?: (currentPhase: SwarmPhase) => boolean;
}

export interface CloseOutOpts {
  cfg: RunConfig;
  crashMessage?: string;
  stopping: boolean;
  earlyStopDetail?: string;
  round: number;
  currentPhase: SwarmPhase;
  manager: AgentManager;
  appendSystem: (text: string) => void;
  setPhase: (phase: SwarmPhase) => void;
  /** writeSummary callback — fired AFTER reflection + outcome scoring but
   *  BEFORE killAll. Caller-owned because it touches private fields. */
  writeSummary: () => Promise<void>;
  hooks: CloseOutHooks;
  /** Transcript entries at run-end (for outcome scoring context). */
  transcript?: Array<{ text: string; role: string }>;
  /** Final deliverable text (synthesis or summary). If absent, scoring
   *  uses the last transcript entries as context. */
  deliverableText?: string;
  /** Wall-clock ms for the outcome record. */
  wallClockMs?: number;
  /** Emit function for the outcome_scored event. */
  emitOutcome?: (outcome: RunOutcome) => void;
  /** Token totals from run-end summary for outcome record. */
  totalPromptTokens?: number;
  totalResponseTokens?: number;
}

/** Shared finally close-out. Calling pattern in each runner:
 *
 *      } finally {
 *        await runDiscussionCloseOut({
 *          cfg, crashMessage, stopping: this.stopping,
 *          earlyStopDetail: this.earlyStopDetail, round: this.round,
 *          currentPhase: this.phase, manager: this.opts.manager,
 *          appendSystem: (t) => this.appendSystem(t),
 *          setPhase: (p) => this.setPhase(p),
 *          writeSummary: () => this.writeSummary(cfg, crashMessage),
 *          hooks: {
 *            pickReflectionAgent: (m) => m.list().find((a) => a.index === 1) ?? null,
 *            buildReflectionContext: (s) =>
 *              `Council preset · ${cfg.agentCount} drafters · ran ${s.round}/${cfg.rounds} rounds${s.earlyStopDetail ? ` · early-stop: ${s.earlyStopDetail}` : ""}`,
 *          },
 *        });
 *      }
 */
export async function runDiscussionCloseOut(opts: CloseOutOpts): Promise<void> {
  // 1. Reflection (gated on natural completion + runId + hook provides agent).
  if (
    !opts.crashMessage &&
    !opts.stopping &&
    opts.cfg.runId &&
    opts.hooks.pickReflectionAgent
  ) {
    const agent = opts.hooks.pickReflectionAgent(opts.manager);
    if (agent) {
      const ctxSummary = opts.hooks.buildReflectionContext
        ? opts.hooks.buildReflectionContext({
            round: opts.round,
            earlyStopDetail: opts.earlyStopDetail,
          })
        : `${opts.cfg.preset} preset`;
      await runEndReflection({
        agent,
        preset: opts.cfg.preset,
        runId: opts.cfg.runId,
        clonePath: opts.cfg.localPath,
        contextSummary: ctxSummary,
        log: (msg) => opts.appendSystem(msg),
      }).catch(() => {
        // Reflection failure is non-fatal — runs still complete.
      });
    }
  }

  // 1.5 Outcome scoring (Direction 1 Phase 1). Fires when cfg.rubricGrading
  // is enabled and the run completed naturally (no crash/stop).
  if (
    !opts.crashMessage &&
    !opts.stopping &&
    opts.cfg.runId &&
    opts.cfg.rubricGrading &&
    opts.hooks.pickReflectionAgent
  ) {
    const agent = opts.hooks.pickReflectionAgent(opts.manager);
    if (agent) {
      const runOutput =
        opts.deliverableText ??
        (opts.transcript && opts.transcript.length > 0
          ? opts.transcript
              .filter((e) => e.role === "agent")
              .slice(-3)
              .map((e) => e.text)
              .join("\n\n")
          : "");
      if (runOutput) {
        const outcome = await scoreRun({
          agent,
          preset: opts.cfg.preset as import("./SwarmRunner.js").PresetId,
          runId: opts.cfg.runId,
          clonePath: opts.cfg.localPath,
          userDirective: opts.cfg.userDirective ?? "",
          runOutput,
          agentCount: opts.cfg.agentCount,
          rounds: opts.round,
          wallClockMs: opts.wallClockMs ?? 0,
          totalPromptTokens: opts.totalPromptTokens ?? 0,
          totalResponseTokens: opts.totalResponseTokens ?? 0,
          log: (msg) => opts.appendSystem(msg),
        }).catch(() => null);

        if (outcome) {
          opts.emitOutcome?.(outcome);
          await appendOutcomeHistory(opts.cfg.localPath, outcome).catch(() => {});
          opts.appendSystem(outcomeToMarkdown(outcome));
        }
      }
    }
  }

  // 2. writeSummary (caller-owned; we just invoke).
  await opts.writeSummary();

  // 3. killAll + setPhase("completed") (gated on !stopping).
  if (!opts.stopping) {
    const killResult = await opts.manager.killAll();
    opts.appendSystem(formatPortReleaseLine(killResult));
    const shouldComplete = opts.hooks.shouldSetCompleted
      ? opts.hooks.shouldSetCompleted(opts.currentPhase)
      : true;
    if (shouldComplete) {
      opts.setPhase("completed");
    }
  }
}
