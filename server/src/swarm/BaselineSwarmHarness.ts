// T-Item-1 (2026-05-04): parallel-clone-to-K-subdirs baseline harness.
//
// Composes K BaselineRunner instances, each in its own clone subdir,
// running in parallel. After all settle, scores by (hunks_applied +
// 5 × verify_passed); promotes the winner's clone to the canonical
// path; cleans up loser subdirs.
//
// Implements SwarmRunner so the orchestrator can swap it in for
// BaselineRunner transparently when cfg.baselineAttempts > 1.
//
// Cost shape: K parallel attempts means K × per-attempt token cost,
// but ≈max(per-attempt time) wall-clock instead of sum. Quota walls
// can hit all K simultaneously — surface with a clear message + fail
// the harness (don't try to recover; user re-runs).

import path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import type {
  SwarmEvent,
  SwarmPhase,
  SwarmStatus,
  TranscriptEntry,
} from "../types.js";
import type { RunConfig, RunnerOpts, SwarmRunner } from "./SwarmRunner.js";
import { BaselineRunner, type BaselineResult } from "./BaselineRunner.js";
import { formatChatReceipt } from "./chatReceipt.js";

interface AttemptResult {
  attempt: number;
  destPath: string;
  /** Settled per-attempt outcome. Null when the inner runner crashed
   *  during start() (cleanup needed but no result to score on). */
  result: BaselineResult | null;
  score: number;
  /** Set on the winner so cleanup loop skips it. */
  isWinner: boolean;
  /** Set when the runner failed (e.g. clone failed); cleanup still
   *  attempted but at lower priority. */
  failed: boolean;
}

/** Pure scoring formula. Verify-passed weighed at +5 (strong positive
 *  signal), verify-failed at -3 (penalize broken commits but don't
 *  out-weigh the hunk delivery itself). null verify (nothing to verify
 *  against, e.g. doc-only repo) treated as neutral. Higher = better. */
export function scoreBaselineResult(result: BaselineResult | null): number {
  if (!result) return -1; // crashed attempts never win
  const verifyBonus =
    result.verifyPassed === true ? 5 : result.verifyPassed === false ? -3 : 0;
  return result.hunksApplied + verifyBonus;
}

/** Pure winner-pick: highest score wins, tie broken by lowest attempt#
 *  (fairness: earlier-launched attempts win ties). Returns null when
 *  the input is empty. Failed attempts (clone crash etc.) are filtered
 *  out by the caller before this runs. */
export function pickWinnerAttempt<T extends { attempt: number; score: number }>(
  attempts: readonly T[],
): T | null {
  if (attempts.length === 0) return null;
  return [...attempts].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.attempt - b.attempt;
  })[0]!;
}

/** Pure safety check: a candidate cleanup path must live strictly under
 *  the parent dir (not be the parent itself, not be a sibling). Used
 *  by cleanupAttempts() to refuse to rm anything outside the harness's
 *  own subdirs even if AttemptResult.destPath is malformed. */
export function isPathSafelyUnderParent(
  candidate: string,
  parent: string,
): boolean {
  return candidate.startsWith(parent + path.sep);
}

export class BaselineSwarmHarness implements SwarmRunner {
  private transcript: TranscriptEntry[] = [];
  private phase: SwarmPhase = "idle";
  private stopping = false;
  private active?: RunConfig;
  private startedAt?: number;
  /** Track the inner runners so stop() can propagate. */
  private innerRunners: BaselineRunner[] = [];

  constructor(private readonly opts: RunnerOpts) {}

  status(): SwarmStatus {
    return {
      phase: this.phase,
      round: 0,
      repoUrl: this.active?.repoUrl,
      localPath: this.active?.localPath,
      model: this.active?.model,
      agents: this.opts.manager.toStates(),
      transcript: [...this.transcript],
      streaming: this.opts.manager.getPartialStreams(),
    };
  }

  injectUser(
    text: string,
    opts?: { intent?: "suggest" | "steer" | "ask"; targetAgent?: string },
  ): void {
    const intent = opts?.intent ?? "steer";
    const entry: TranscriptEntry = {
      id: randomUUID(),
      role: "user",
      text,
      ts: Date.now(),
      intent,
      ...(opts?.targetAgent ? { targetAgent: opts.targetAgent } : {}),
    };
    this.transcript.push(entry);
    this.opts.emit({ type: "transcript_append", entry });
    this.appendSystem(formatChatReceipt(intent, opts?.targetAgent));
  }

  isRunning(): boolean {
    return (
      this.phase !== "idle" &&
      this.phase !== "stopped" &&
      this.phase !== "completed" &&
      this.phase !== "failed"
    );
  }

  async start(cfg: RunConfig): Promise<void> {
    if (this.isRunning()) {
      throw new Error("A swarm is already running. Stop it first.");
    }
    this.transcript = [];
    this.stopping = false;
    this.active = cfg;
    this.startedAt = Date.now();

    const K = Math.max(1, Math.min(5, cfg.baselineAttempts ?? 1));
    if (K === 1) {
      // Fall back to plain BaselineRunner; no parallel needed. The
      // harness becomes a thin pass-through.
      this.appendSystem(
        `[T-Item-1 parallel-clone baseline] K=1 → falling through to plain BaselineRunner.`,
      );
      const single = new BaselineRunner(this.opts);
      this.innerRunners.push(single);
      await single.start(cfg);
      // Mirror inner runner's terminal phase. BaselineRunner.start()
      // is fire-and-forget (kicks loop()); poll briefly until phase
      // settles or 30s elapses.
      const waitStart = Date.now();
      while (single.isRunning() && Date.now() - waitStart < 30 * 60_000) {
        await new Promise((r) => setTimeout(r, 500));
      }
      this.setPhase(single.status().phase);
      return;
    }

    void this.runHarness(cfg, K).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.appendSystem(`Baseline harness crashed: ${msg}`);
      this.setPhase("failed");
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.setPhase("stopping");
    // Propagate stop to inner runners (each kills its agent + sets phase)
    await Promise.all(this.innerRunners.map((r) => r.stop().catch(() => {})));
    this.setPhase("stopped");
  }

  private async runHarness(cfg: RunConfig, K: number): Promise<void> {
    this.setPhase("cloning");
    this.appendSystem(
      `[T-Item-1 parallel-clone baseline] K=${K} attempts in K subdirs (parallel).`,
    );
    // Phase B: clone to K subdirs in parallel
    const baseName = path.basename(cfg.localPath);
    const parent = path.dirname(cfg.localPath);
    let cloneResults: Array<{ destPath: string }>;
    try {
      cloneResults = await Promise.all(
        Array.from({ length: K }, (_, i) =>
          this.opts.repos.cloneToSubdir({
            parent,
            baseName,
            attemptIdx: i + 1,
            url: cfg.repoUrl,
          }),
        ),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.appendSystem(
        `[T-Item-1] failed to clone K subdirs: ${msg}; aborting harness.`,
      );
      this.setPhase("failed");
      return;
    }
    this.appendSystem(
      `[T-Item-1] cloned ${cloneResults.length} subdirs: ${cloneResults.map((c) => path.basename(c.destPath)).join(", ")}`,
    );

    if (this.stopping) return;
    this.setPhase("executing");

    // Phase C: K runners in parallel, collect results
    const attemptResults: AttemptResult[] = await Promise.all(
      cloneResults.map(async ({ destPath }, i) => {
        const inner = new BaselineRunner(this.opts);
        this.innerRunners.push(inner);
        const attemptCfg: RunConfig = {
          ...cfg,
          localPath: destPath,
          // Force baselineAttempts=1 so the inner runner doesn't try
          // to multi-attempt within its subdir (we're doing the multi
          // here at the harness level via K parallel clones).
          baselineAttempts: 1,
        };
        try {
          await inner.start(attemptCfg);
          // Wait for inner runner to settle (its start() is fire-and-
          // forget). Poll isRunning() every 500ms with a 30-min cap.
          const waitStart = Date.now();
          while (inner.isRunning() && Date.now() - waitStart < 30 * 60_000) {
            if (this.stopping) {
              await inner.stop().catch(() => {});
              break;
            }
            await new Promise((r) => setTimeout(r, 500));
          }
          const res = inner.getResult();
          return {
            attempt: i + 1,
            destPath,
            result: res,
            score: scoreBaselineResult(res),
            isWinner: false,
            failed: false,
          } satisfies AttemptResult;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.appendSystem(
            `[T-Item-1] attempt ${i + 1} crashed: ${msg}`,
          );
          return {
            attempt: i + 1,
            destPath,
            result: null,
            score: -1, // never wins
            isWinner: false,
            failed: true,
          } satisfies AttemptResult;
        }
      }),
    );

    if (this.stopping) return;

    // Phase E: pick winner + promote to canonical path
    const scored = attemptResults.filter((r) => !r.failed);
    if (scored.length === 0) {
      this.appendSystem(
        `[T-Item-1] all ${K} attempts failed — no winner to promote.`,
      );
      // Best-effort cleanup of all K subdirs
      await this.cleanupAttempts(attemptResults, parent);
      this.setPhase("failed");
      return;
    }
    const winner = pickWinnerAttempt(scored)!;
    winner.isWinner = true;
    this.appendSystem(
      `[T-Item-1] winner = attempt ${winner.attempt}/${K} (score=${winner.score}, hunks=${winner.result?.hunksApplied ?? 0}, verify=${winner.result?.verifyPassed === null ? "n/a" : winner.result?.verifyPassed ? "PASS" : "FAIL"}).`,
    );
    // Promote winner: delete cfg.localPath if it exists (we own it
    // since we cloned the K subdirs under parent), then rename.
    try {
      // If cfg.localPath happens to exist (e.g. resume run), delete it.
      // The K subdirs are SIBLINGS so the rename target is empty.
      try {
        await fs.rm(cfg.localPath, { recursive: true, force: true });
      } catch {
        // best-effort
      }
      await fs.rename(winner.destPath, cfg.localPath);
      this.appendSystem(
        `[T-Item-1] promoted ${path.basename(winner.destPath)} → ${path.basename(cfg.localPath)} (canonical clone path).`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.appendSystem(
        `[T-Item-1] winner promotion failed (rename ${winner.destPath} → ${cfg.localPath}): ${msg}; winner's commits remain in subdir.`,
      );
    }

    // Phase F: cleanup loser subdirs
    await this.cleanupAttempts(attemptResults, parent);

    if (this.stopping) return;
    this.setPhase("completed");
  }

  // Phase F: cleanup loser subdirs. Safety: only delete paths under
  // the parent dir. Best-effort — failures logged, harness still
  // succeeds since the winner's commits are already promoted.
  private async cleanupAttempts(
    results: readonly AttemptResult[],
    parent: string,
  ): Promise<void> {
    for (const r of results) {
      if (r.isWinner) continue;
      if (!isPathSafelyUnderParent(r.destPath, parent)) {
        this.appendSystem(
          `[T-Item-1] SKIPPED cleanup of ${r.destPath} — outside parent dir`,
        );
        continue;
      }
      try {
        await fs.rm(r.destPath, { recursive: true, force: true });
        this.appendSystem(
          `[T-Item-1] cleaned up loser attempt ${r.attempt}: ${path.basename(r.destPath)}`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.appendSystem(
          `[T-Item-1] cleanup failed for attempt ${r.attempt}: ${msg}`,
        );
      }
    }
  }

  private setPhase(p: SwarmPhase): void {
    this.phase = p;
    this.opts.emit({ type: "swarm_state", phase: p, round: 0 });
  }

  private appendSystem(
    text: string,
    summary?: SwarmEvent extends { summary: infer S } ? S : never,
  ): void {
    const entry: TranscriptEntry = {
      id: randomUUID(),
      role: "system",
      text,
      ts: Date.now(),
    };
    if (summary)
      (entry as TranscriptEntry & { summary: unknown }).summary = summary;
    this.transcript.push(entry);
    this.opts.emit({ type: "transcript_append", entry });
  }
}
