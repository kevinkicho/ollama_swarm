import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- OW flat ---
{
  const path = join(__dirname, "../src/swarm/OrchestratorWorkerRunner.ts");
  let src = readFileSync(path, "utf8");
  if (!src.includes("orchestratorWorkerLoop.js")) {
    src = src.replace(
      `import { buildOrchestratorWorkerSeedMessage } from "./orchestratorWorkerSeed.js";`,
      `import { buildOrchestratorWorkerSeedMessage } from "./orchestratorWorkerSeed.js";
import { runOwLoopBody } from "./orchestratorWorkerLoop.js";`,
    );
  }
  const mStart = src.indexOf("  private async loop(cfg: RunConfig): Promise<void> {");
  const mEnd = src.indexOf("  // 2026-05-02 (deliverables initiative): orchestrator-worker");
  if (mStart < 0 || mEnd < 0) throw new Error(`OW markers ${mStart} ${mEnd}`);
  const replacement = `  private async loop(cfg: RunConfig): Promise<void> {
    let crashMessage: string | undefined;
    try {
      await runOwLoopBody(
        {
          manager: this.opts.manager,
          transcript: this.transcript,
          stats: this.stats,
          getStopping: () => this.stopping,
          setEarlyStopDetail: (d) => { this.earlyStopDetail = d; },
          appendSystem: (t, s) => this.appendSystem(t, s as any),
          checkRoundBudget: (c, u, r, b) => this.checkRoundBudget(c, u, r, b),
          runDiscussionAgent: (a, p, o) => this.runDiscussionAgent(a, p, o as any),
          runLeadTurn: (a, r, tr, p, k) => this.runLeadTurn(a, r, tr, p, k),
          runWorkerTurn: (a, r, tr, s, snap, d, sc) =>
            this.runWorkerTurn(a, r, tr, s, snap, d, sc),
          dispatchHandoffWave: (w, r, tr, snap, d) =>
            this.dispatchHandoffWave(w, r, tr, snap, d),
          runDecompositionPeerReview: (rev, r, tr, plan, d) =>
            this.runDecompositionPeerReview(rev, r, tr, plan, d),
        },
        cfg,
      );
    } catch (err) {
      crashMessage = err instanceof Error ? err.message : String(err);
      this.opts.emit({ type: "error", message: crashMessage });
    } finally {
      // 2026-05-02 (deliverables initiative): structured markdown.
      if (!this.stopping && cfg.runId) await this.writeOwDeliverable(cfg);
      // 2026-05-03 (Phase D): finally close-out extracted to shared helper.
      await runDiscussionCloseOut({
        cfg,
        crashMessage,
        stopping: this.stopping,
        earlyStopDetail: this.earlyStopDetail,
        round: this.round,
        currentPhase: this.phase,
        manager: this.opts.manager,
        appendSystem: (text) => this.appendSystem(text),
        setPhase: (p) => this.setPhase(p),
        writeSummary: () => this.writeSummary(cfg, crashMessage),
        hooks: {
          pickReflectionAgent: (m) => m.list().find((a) => a.index === 1) ?? null,
          buildReflectionContext: (s) =>
            \`Orchestrator-worker preset · \${cfg.agentCount} agents (1 lead + workers) · ran \${s.round}/\${cfg.rounds} cycles\${s.earlyStopDetail ? \` · early-stop: \${s.earlyStopDetail}\` : ""}\`,
        },
        transcript: this.transcript,
        emitOutcome: createOutcomeEmitter((e) => this.opts.emit(e)),
        wallClockMs: this.startedAt ? Date.now() - this.startedAt : 0,
      });
    }
  }

`;
  src = src.slice(0, mStart) + replacement + src.slice(mEnd);
  writeFileSync(path, src);
  console.log("wired OW", src.split("\n").length);
}

// --- OW deep ---
{
  const path = join(__dirname, "../src/swarm/OrchestratorWorkerDeepRunner.ts");
  let src = readFileSync(path, "utf8");
  if (!src.includes("orchestratorWorkerDeepLoop.js")) {
    src = src.replace(
      `import { buildOrchestratorWorkerDeepSeedMessage } from "./orchestratorWorkerDeepSeed.js";`,
      `import { buildOrchestratorWorkerDeepSeedMessage } from "./orchestratorWorkerDeepSeed.js";
import { runOwDeepLoopBody } from "./orchestratorWorkerDeepLoop.js";`,
    );
  }
  const mStart = src.indexOf("  private async loop(cfg: RunConfig): Promise<void> {");
  const mEnd = src.indexOf("  // 2026-05-02 (deliverables initiative): orchestrator-worker-deep");
  if (mStart < 0 || mEnd < 0) throw new Error(`DEEP markers ${mStart} ${mEnd}`);
  const replacement = `  private async loop(cfg: RunConfig): Promise<void> {
    let crashMessage: string | undefined;
    try {
      await runOwDeepLoopBody(
        {
          manager: this.opts.manager,
          transcript: this.transcript,
          topology: this.topology,
          getCyclePushbacks: () => this.cyclePushbacks,
          setCyclePushbacks: (m) => { this.cyclePushbacks = m; },
          getStopping: () => this.stopping,
          setEarlyStopDetail: (d) => { this.earlyStopDetail = d; },
          appendSystem: (t) => this.appendSystem(t),
          checkRoundBudget: (c, u, r, b) => this.checkRoundBudget(c, u, r, b),
          runAgent: (a, p) => this.runAgent(a, p),
          runMidLeadSubtree: (ml, pool, a, r, tr, snap, d) =>
            this.runMidLeadSubtree(ml, pool, a, r, tr, snap, d),
        },
        cfg,
      );
    } catch (err) {
      crashMessage = err instanceof Error ? err.message : String(err);
      this.opts.emit({ type: "error", message: crashMessage });
    } finally {
      // 2026-05-02 (deliverables initiative): structured markdown.
      if (!this.stopping && cfg.runId) await this.writeOwDeepDeliverable(cfg);
      // 2026-05-03 (Phase D): finally close-out extracted to shared helper.
      // Reflection: orchestrator (index 1); skipped when topology is null.
      const topo = this.topology;
      await runDiscussionCloseOut({
        cfg,
        crashMessage,
        stopping: this.stopping,
        earlyStopDetail: this.earlyStopDetail,
        round: this.round,
        currentPhase: this.phase,
        manager: this.opts.manager,
        appendSystem: (text) => this.appendSystem(text),
        setPhase: (p) => this.setPhase(p),
        writeSummary: () => this.writeSummary(cfg, crashMessage),
        hooks: {
          pickReflectionAgent: (m) =>
            topo ? (m.list().find((a) => a.index === 1) ?? null) : null,
          buildReflectionContext: (s) =>
            \`Orchestrator-worker-deep · 1 orchestrator + \${topo?.midLeadIndices.length ?? 0} mid-leads + \${topo?.workerIndices.length ?? 0} workers · ran \${s.round}/\${cfg.rounds} cycles\${s.earlyStopDetail ? \` · early-stop: \${s.earlyStopDetail}\` : ""}\`,
        },
        transcript: this.transcript,
        emitOutcome: createOutcomeEmitter((e) => this.opts.emit(e)),
        wallClockMs: this.startedAt ? Date.now() - this.startedAt : 0,
      });
    }
  }

`;
  src = src.slice(0, mStart) + replacement + src.slice(mEnd);
  writeFileSync(path, src);
  console.log("wired OW-deep", src.split("\n").length);
}
