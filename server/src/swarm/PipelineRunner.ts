import type { RunConfig, RunnerOpts, SwarmRunner, PresetId } from "./SwarmRunner.js";
import type { SwarmStatus, SwarmPhase, TranscriptEntry, TranscriptEntrySummary } from "../types.js";
import type { PipelineConfig } from "./pipelinePhases.js";
import { buildPipedDirective, DEFAULT_PIPELINE } from "./pipelinePhases.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { writeRunSummary, formatPortReleaseLine, formatRunFinishedBanner, buildRunFinishedSummary } from "./runSummary.js";

export type RunnerFactory = (preset: PresetId) => Promise<SwarmRunner>;

export class PipelineRunner implements SwarmRunner {
  private active: RunConfig | undefined;
  private opts: RunnerOpts;
  private running = false;
  private stopping = false;
  private phase = "idle" as SwarmPhase;
  private round = 0;
  private transcript: TranscriptEntry[] = [];
  private phaseResults: Array<{
    preset: PresetId;
    status: string;
    transcript: TranscriptEntry[];
    deliverable: string | undefined;
    agents?: any[];
  }> = [];
  private currentRunner: SwarmRunner | null = null;
  private factory: RunnerFactory;

  constructor(opts: RunnerOpts, factory: RunnerFactory) {
    this.opts = opts;
    this.factory = factory;
  }

  status(): SwarmStatus {
    const currentStatus = this.currentRunner?.status();
    return {
      phase: this.phase,
      round: this.round,
      repoUrl: this.active?.repoUrl,
      localPath: this.active?.localPath,
      model: this.active?.model,
      agents: currentStatus?.agents ?? this.opts.manager.toStates(),
      transcript: [...this.transcript],
      streaming: currentStatus?.streaming,
    };
  }

  injectUser(
    text: string,
    opts?: { intent?: "suggest" | "steer" | "ask"; targetAgent?: string },
  ): void {
    this.currentRunner?.injectUser(text, opts);
  }

  isRunning(): boolean {
    return this.running;
  }

  async start(cfg: RunConfig): Promise<void> {
    const pipeline: PipelineConfig = cfg.pipeline ?? DEFAULT_PIPELINE;
    this.active = cfg;
    this.running = true;
    this.transcript = [];
    this.phaseResults = [];
    this.setPhase("discussing");

    this.appendSystem(`[Pipeline] Using configured pipeline phases: ${pipeline.phases.map(p => p.preset).join(' → ')} (pipeMode=${pipeline.pipeMode ?? 'both'})`);

    for (let i = 0; i < pipeline.phases.length; i++) {
      if (this.stopping) break;
      this.round = i + 1;
      const phase = pipeline.phases[i];

      const prevResult = this.phaseResults[i - 1];
      const pipedDirective = buildPipedDirective(
        cfg.userDirective,
        prevResult?.transcript ?? [],
        prevResult?.deliverable,
        pipeline.pipeMode ?? "both",
        pipeline.pipeMaxEntries ?? 20,
      );

      const { pipeline: _pipeline, useHybridPlanning: _h, planningPreset: _pp, executionPreset: _ep, ...phaseConfigRest } = {
        ...cfg,
        preset: phase.preset,
        rounds: phase.rounds ?? cfg.rounds,
        agentCount: phase.agentCount ?? cfg.agentCount,
        model: phase.model ?? cfg.model,
        userDirective: pipedDirective || cfg.userDirective,
        suppressSeedMessages: i > 0,
      };
      const phaseConfig: RunConfig = phaseConfigRest as RunConfig;

      this.appendSystem(
        `[Pipeline] Starting phase ${i + 1}/${pipeline.phases.length}: ${phase.preset} (${phase.rounds ?? cfg.rounds} rounds)`,
      );

      const runner = await this.factory(phase.preset);
      this.currentRunner = runner;

      try {
        await runner.start(phaseConfig);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.appendSystem(
          `[Pipeline] Phase ${i + 1} (${phase.preset}) failed: ${msg.slice(0, 200)}.`,
        );
        // For hybrid planning (first phase), treat planning failure as run failure instead of continuing.
        // This matches expectation that if planning (e.g. council) can't produce usable output, the execution shouldn't proceed as "completed".
        if (i === 0) {
          this.running = false;
          this.setPhase("failed");
          throw err;  // propagate so orchestrator/ActiveRun sees failure
        }
        this.appendSystem("Continuing to next phase.");
      }

      const runnerStatus = runner.status();
      const deliverable = await readDeliverable(cfg, phase.preset, i);

      this.phaseResults.push({
        preset: phase.preset,
        status: this.stopping ? "stopped" : "completed",
        transcript: runnerStatus.transcript,
        deliverable,
        agents: runnerStatus.agents || [],
      });

      for (const entry of runnerStatus.transcript) {
        this.transcript.push(entry);
      }

      this.appendSystem(
        `[Pipeline] Completed phase ${i + 1}/${pipeline.phases.length}: ${phase.preset}`,
      );
    }

    this.currentRunner = null;
    this.running = false;

    const lastPhaseCfg = pipeline.phases[pipeline.phases.length - 1];
    const lastWasAutonomousExec = !!(lastPhaseCfg && (
      lastPhaseCfg.rounds === 0 ||
      String(lastPhaseCfg.preset) === 'blackboard'
    ));

    // Do not force "completed" + kill + run_finished here for autonomous exec phase (blackboard rounds=0 in hybrid).
    // The exec runner starts its work in background after start() resolves (post-spawn); forcing here kills agents
    // prematurely and emits the run summary banner before any real execution output streams arrive.
    // Let the blackboard lifecycle drive its own terminal phase, killAll, run_finished append, and summary write.
    if (!this.stopping && !lastWasAutonomousExec) {
      this.setPhase("completed");
    }

    if (!lastWasAutonomousExec) {
      // Force release + summary only for finite discussion phases. Hybrid exec manages its lifetime.
      try {
        const killResult = await this.opts.manager.killAll();
        this.appendSystem(formatPortReleaseLine(killResult));
      } catch {}
    }
    if (this.active?.localPath && this.active?.runId && !lastWasAutonomousExec) {
      try {
        const now = Date.now();
        const startedAt = this.phaseResults.length > 0 
          ? (this.phaseResults[0].transcript?.[0]?.ts || now - 200000) 
          : now - 200000;
        const summary = {
          runId: this.active.runId,
          preset: this.active.preset,
          startedAt,
          endedAt: now,
          wallClockMs: Math.max(0, now - startedAt),
          stopReason: this.stopping ? "user-stop" : "completed",
          model: this.active.model,
          agentCount: this.active.agentCount || 0,
          rounds: this.active.rounds || 0,
          transcript: this.transcript,
          topology: this.active.topology,
          filesChanged: 0,
          finalGitStatus: "",
          agents: (this.phaseResults.length > 0 && this.phaseResults[this.phaseResults.length-1].agents) 
            ? this.phaseResults[this.phaseResults.length-1].agents 
            : (this.opts.manager.toStates ? this.opts.manager.toStates() : []),
          clonePath: this.active.localPath,
          // Preserve hybrid flags so ?review mode can detect isHybrid and render council planner box + execution agents.
          useHybridPlanning: (this.active as any).useHybridPlanning,
          planningPreset: (this.active as any).planningPreset,
        } as any;

        // Ensure the persisted transcript for this runId always contains a run_finished
        // entry (with the banner + structured summary) so the history /runs/:id view
        // reliably shows the final grid + agent stats. Sub-phases or early no-progress
        // may not have emitted one, or it may have been deduped. Append if missing
        // (this also makes it part of the transcript we write).
        const hasRunFinished = this.transcript.some((e: any) => e.summary?.kind === "run_finished");
        if (!hasRunFinished) {
          this.transcript.push({
            id: `run-finished-${summary.runId || Date.now()}`,
            role: "system",
            text: formatRunFinishedBanner(summary),
            ts: now,
            summary: buildRunFinishedSummary(summary),
          } as any);
        }

        const finalSummary = { ...summary, transcript: this.transcript };
        await writeRunSummary(this.active.localPath, finalSummary);
      } catch {}
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.setPhase("stopping");
    if (this.currentRunner) {
      await this.currentRunner.stop();
    }
    this.setPhase("stopped");
    this.running = false;

    // Force agent release at the pipeline level (covers cases where sub-phase
    // stop didn't fully release, e.g. mid long turn in planning phase).
    try {
      const killResult = await this.opts.manager.killAll();
      this.appendSystem(formatPortReleaseLine(killResult));
    } catch (e) {
      this.appendSystem(`[Pipeline] Force agent release on stop failed: ${e}`);
    }

    // Force a top-level summary write so the run appears in /runs list even
    // when stopped during a sub-phase (planning). Sub-phases may write their
    // own, but the main runId summary ensures visibility with the blackboard
    // preset.
    if (this.active?.localPath && this.active?.runId) {
      try {
        const now = Date.now();
        const startedAt = this.phaseResults.length > 0 
          ? (this.phaseResults[0].transcript?.[0]?.ts || now - 200000) 
          : now - 200000;
        const summary = {
          runId: this.active.runId,
          preset: this.active.preset,
          startedAt,
          endedAt: now,
          wallClockMs: Math.max(0, now - startedAt),
          stopReason: "user-stop",
          model: this.active.model,
          agentCount: this.active.agentCount || 0,
          rounds: this.active.rounds || 0,
          transcript: this.transcript,
          topology: this.active.topology,
          filesChanged: 0,
          finalGitStatus: "",
          agents: (this.phaseResults.length > 0 && this.phaseResults[this.phaseResults.length-1].agents) 
            ? this.phaseResults[this.phaseResults.length-1].agents 
            : (this.opts.manager.toStates ? this.opts.manager.toStates() : []),
          clonePath: this.active.localPath,
          // Preserve hybrid flags so ?review mode can detect isHybrid and render council planner box + execution agents.
          useHybridPlanning: (this.active as any).useHybridPlanning,
          planningPreset: (this.active as any).planningPreset,
        } as any;

        // Same guarantee as natural completion: ensure run_finished entry for history grid.
        const hasRunFinished = this.transcript.some((e: any) => e.summary?.kind === "run_finished");
        if (!hasRunFinished) {
          this.transcript.push({
            id: `run-finished-${summary.runId || Date.now()}`,
            role: "system",
            text: formatRunFinishedBanner(summary),
            ts: now,
            summary: buildRunFinishedSummary(summary),
          } as any);
        }
        const finalSummary = { ...summary, transcript: this.transcript };
        await writeRunSummary(this.active.localPath, finalSummary);
        this.appendSystem("Wrote run summary on stop (hybrid pipeline).");
      } catch (e) {
        this.appendSystem(`[Pipeline] Failed to force summary write on stop: ${e}`);
      }
    }
  }

  private appendSystem(text: string, summary?: TranscriptEntrySummary): void {
    const entry: TranscriptEntry = {
      id: randomUUID(),
      role: "system",
      text,
      ts: Date.now(),
      ...(summary ? { summary } : {}),
    } as TranscriptEntry;
    this.transcript.push(entry);
    this.opts.emit({ type: "transcript_append", entry });
  }

  appendSystemMessage(text: string, summary?: TranscriptEntrySummary): void {
    this.appendSystem(text, summary);
  }

  private setPhase(phase: SwarmPhase): void {
    this.phase = phase;
    this.opts.emit({ type: "swarm_state", phase, round: this.round });
  }
}

async function readDeliverable(
  cfg: RunConfig,
  _preset: PresetId,
  _phaseIndex: number,
): Promise<string | undefined> {
  if (!cfg.localPath) return undefined;
  try {
    const deliverablePath = path.join(cfg.localPath, "deliverable.md");
    const content = await fs.readFile(deliverablePath, "utf-8");
    return content;
  } catch {
    return undefined;
  }
}