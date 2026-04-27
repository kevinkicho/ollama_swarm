import { randomUUID } from "node:crypto";
import type { Agent } from "../services/AgentManager.js";
import { buildAgentsReadySummary } from "./agentsReadySummary.js";
import type {
  AgentState,
  SwarmEvent,
  SwarmPhase,
  SwarmStatus,
  TranscriptEntry,
  TranscriptEntrySummary,
} from "../types.js";
import type { RunConfig, RunnerOpts, SwarmRunner } from "./SwarmRunner.js";
import { promptWithRetry } from "./promptWithRetry.js";
import { AgentStatsCollector } from "./agentStatsCollector.js";
import { buildDiscussionSummary, buildRunFinishedSummary, buildSeedSummary, formatPortReleaseLine, formatRunFinishedBanner, writeRunSummary } from "./runSummary.js";
import { extractTextWithDiag, looksLikeJunk, trackPostRetryJunk } from "./extractText.js";
import { shouldHaltOnQuota, snapshotLifetimeTokens, tokenBudgetExceeded, tokenTracker } from "../services/ollamaProxy.js";
import { retryEmptyResponse } from "./promptAndExtract.js";
import { formatCloneMessage } from "./cloneMessage.js";
import { runEndReflection } from "./runEndReflection.js";
import { staggerStart } from "./staggerStart.js";

// Map-reduce over the repo.
// Agent 1 = REDUCER (silent during the map phase, then synthesizes).
// Agents 2..N = MAPPERS (each gets a slice of top-level repo entries
// and inspects ONLY that slice — no peer reports, no transcript
// beyond the seed).
//
// The value over orchestrator-worker is that the split is mechanical
// (pre-determined by the runner, not decided by an LLM planner) and
// therefore not subject to the planner's laziness. The cost is less
// targeted coverage — mappers don't get to pick what to study.
//
// `rounds` = how many map-reduce cycles. Cycle 1 is always broad
// coverage; cycle 2+ lets the reducer re-issue mappers to fill
// specific gaps surfaced by the prior synthesis.
// Discussion-only, no file edits.
export class MapReduceRunner implements SwarmRunner {
  private transcript: TranscriptEntry[] = [];
  private phase: SwarmPhase = "idle";
  private round = 0;
  private stopping = false;
  private active?: RunConfig;
  // Unit 33: cross-preset metrics — see RoundRobinRunner for rationale.
  private stats = new AgentStatsCollector();
  private startedAt?: number;
  private summaryWritten = false;
  // Phase 2d: mapper slice assignments, keyed by agentId. Empty map
  // pre-run or if slicing hasn't happened yet.
  private mapperSlices: Record<string, string[]> = {};
  // Phase B (Task #97): set of mapper agent IDs that have flagged
  // their slice complete. When this matches the live mapper set, the
  // run can stop early — no point reducing the same content again.
  private mappersComplete = new Set<string>();
  private earlyStopDetail?: string;

  constructor(private readonly opts: RunnerOpts) {}

  status(): SwarmStatus {
    return {
      phase: this.phase,
      round: this.round,
      repoUrl: this.active?.repoUrl,
      localPath: this.active?.localPath,
      model: this.active?.model,
      agents: this.opts.manager.toStates(),
      transcript: [...this.transcript],
      // Task #39: per-agent partial-stream buffer for catch-up.
      streaming: this.opts.manager.getPartialStreams(),
      // Phase 2d: mapper slice assignments for CoveragePanel catch-up.
      mapperSlices: { ...this.mapperSlices },
    };
  }

  injectUser(text: string): void {
    const entry: TranscriptEntry = {
      id: randomUUID(),
      role: "user",
      text,
      ts: Date.now(),
    };
    this.transcript.push(entry);
    this.opts.emit({ type: "transcript_append", entry });
  }

  isRunning(): boolean {
    // Task #34: see BlackboardRunner.isRunning() — terminal phases
    // are not running.
    return (
      this.phase !== "idle" &&
      this.phase !== "stopped" &&
      this.phase !== "completed" &&
      this.phase !== "failed"
    );
  }

  async start(cfg: RunConfig): Promise<void> {
    if (this.isRunning()) throw new Error("A swarm is already running. Stop it first.");
    this.transcript = [];
    this.stopping = false;
    this.round = 0;
    this.active = cfg;
    this.stats.reset();
    this.startedAt = undefined;
    this.summaryWritten = false;
    this.mappersComplete = new Set();
    this.earlyStopDetail = undefined;

    this.setPhase("cloning");
    const cloneResult = await this.opts.repos.clone({ url: cfg.repoUrl, destPath: cfg.localPath });
    const { destPath } = cloneResult;
    // Unit 47: tell the UI whether this is a fresh clone or a resume.
    this.opts.emit({
      type: "clone_state",
      alreadyPresent: cloneResult.alreadyPresent,
      clonePath: destPath,
      priorCommits: cloneResult.priorCommits,
      priorChangedFiles: cloneResult.priorChangedFiles,
      priorUntrackedFiles: cloneResult.priorUntrackedFiles,
    });
    // Unit 48: hide runner artifacts from `git status` (see RoundRobinRunner).
    await this.opts.repos.excludeRunnerArtifacts(destPath);
    await this.opts.repos.writeOpencodeConfig(destPath, cfg.model);
    this.appendSystem(formatCloneMessage(cfg.repoUrl, destPath, cloneResult));

    this.setPhase("spawning");
    const spawnStart = Date.now();
    const spawnTasks: Promise<Agent>[] = [];
    for (let i = 1; i <= cfg.agentCount; i++) {
      spawnTasks.push(this.opts.manager.spawnAgent({ cwd: destPath, index: i, model: cfg.model }));
    }
    const results = await Promise.allSettled(spawnTasks);
    const ready = results
      .filter((r): r is PromiseFulfilledResult<Agent> => r.status === "fulfilled")
      .map((r) => r.value);
    if (ready.length < 3) {
      throw new Error(
        `Map-reduce requires at least 3 agents (1 reducer + 2 mappers). Only ${ready.length} spawned.`,
      );
    }
    this.appendSystem(
      `${ready.length}/${cfg.agentCount} agents ready on ports ${ready.map((a) => a.port).join(", ")}. Agent 1 is the REDUCER; agents 2..${cfg.agentCount} are MAPPERS.`,
      buildAgentsReadySummary({
        manager: this.opts.manager,
        preset: "map-reduce",
        ready,
        requestedCount: cfg.agentCount,
        spawnElapsedMs: Date.now() - spawnStart,
        roleResolver: (a) => (a.index === 1 ? "Reducer" : "Mapper"),
      }),
    );
    this.stats.registerAgents(ready);

    this.setPhase("seeding");
    await this.seed(destPath, cfg);

    this.setPhase("discussing");
    this.startedAt = Date.now();
    void this.loop(cfg, destPath);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.setPhase("stopping");
    await this.opts.manager.killAll();
    this.setPhase("stopped");
  }

  private async seed(clonePath: string, cfg: RunConfig): Promise<void> {
    const tree = (await this.opts.repos.listTopLevel(clonePath)).slice(0, 200);
    const seed = [
      `Project clone: ${clonePath}`,
      `Repo: ${cfg.repoUrl}`,
      `Top-level entries: ${tree.join(", ") || "(empty)"}`,
      "",
      "Pattern: Map-reduce. Agent 1 is the REDUCER; others are MAPPERS.",
      "Each mapper inspects only its assigned slice of the repo (in isolation). The reducer consolidates all mapper reports at the end of each cycle.",
    ].join("\n");
    this.appendSystem(seed, buildSeedSummary(cfg.repoUrl, clonePath, tree));
  }

  private async loop(cfg: RunConfig, clonePath: string): Promise<void> {
    let crashMessage: string | undefined;
    try {
      const agents = this.opts.manager.list();
      const reducer = agents.find((a) => a.index === 1);
      const mappers = agents.filter((a) => a.index !== 1);
      if (!reducer) throw new Error("reducer agent (index 1) did not spawn");
      if (mappers.length < 2) throw new Error("need at least 2 mappers");

      const topLevel = await this.opts.repos.listTopLevel(clonePath);
      const slicingSource = topLevel.filter((e) => !SKIP_ENTRIES.has(e));
      const slices = sliceRoundRobin(slicingSource, mappers.length);
      this.appendSystem(
        `Repo slicing: round-robin over ${slicingSource.length} top-level entries across ${mappers.length} mappers.`,
      );
      // Phase 2d: stash + emit slice assignments so CoveragePanel can
      // render the tree view. Keyed by agentId for consistency with
      // other per-agent maps (latency etc.).
      const slicesById: Record<string, string[]> = {};
      for (let i = 0; i < mappers.length; i++) {
        slicesById[mappers[i].id] = slices[i] ?? [];
      }
      this.mapperSlices = slicesById;
      this.opts.emit({ type: "mapper_slices", slices: slicesById });

      // Task #124: snapshot lifetime tokens for budget delta.
      const tokenBaseline = snapshotLifetimeTokens();
      // Task #146: dead-loop guard (mirrors #144).
      let consecutiveEmptyRounds = 0;
      const EMPTY_ROUND_BREAK_THRESHOLD = 2;

      for (let r = 1; r <= cfg.rounds; r++) {
        if (this.stopping) break;
        // Task #124: token-budget cap check.
        if (tokenBudgetExceeded(tokenBaseline, cfg.tokenBudget)) {
          this.earlyStopDetail = `token-budget reached (${cfg.tokenBudget?.toLocaleString()} tokens)`;
          this.appendSystem(`Token budget of ${cfg.tokenBudget?.toLocaleString()} tokens reached at cycle ${r - 1}/${cfg.rounds} — ending run early.`);
          break;
        }
        // Task #137: quota-wall cap check.
        if (shouldHaltOnQuota()) {
          const q = tokenTracker.getQuotaState();
          this.earlyStopDetail = `ollama-quota-exhausted (${q?.statusCode}: ${q?.reason.slice(0, 100)})`;
          this.appendSystem(`Ollama quota wall hit at cycle ${r - 1}/${cfg.rounds} (${q?.statusCode}) — ending run early.`);
          break;
        }
        this.round = r;
        this.opts.emit({ type: "swarm_state", phase: "discussing", round: r });

        this.appendSystem(`Cycle ${r}/${cfg.rounds}: MAP phase — mappers inspecting slices in parallel.`);

        // Unit 18b (2026-04-22): pre-batch parallel warmup REMOVED for
        // consistency with council/OW after v4 battle test showed it
        // hurt them. Map-reduce was the only one of the three where v4
        // pre-batch warmup actually improved coverage (1/4 -> 2/4
        // mappers), but the gain was small (40% -> 60%) vs the
        // regressions elsewhere. Keep the simpler shape — serial
        // spawn-warmup only — and revisit if MR coverage proves a
        // ceiling separately worth a dedicated fix.

        // MAP — mappers fire in parallel. Each sees only its assigned slice
        // + the seed. No transcript, no peer reports.
        // Task #53: stagger the N parallel mapper prompts to avoid the
        // Pattern 3 cold-start queue race confirmed in 2026-04-24 logs.
        const seedSnapshot = this.transcript.filter((e) => e.role === "system");
        const transcriptLenBefore = this.transcript.length;
        await staggerStart(mappers, (m, i) => {
          const mySlice = slices[i] ?? [];
          return this.runMapperTurn(m, r, cfg.rounds, mySlice, seedSnapshot);
        });
        if (this.stopping) break;
        // Task #146: dead-loop guard. If every mapper produced empty/junk
        // output this cycle, count toward break threshold.
        const newEntries = this.transcript
          .slice(transcriptLenBefore)
          .filter((e) => e.role === "agent");
        const allEmpty = newEntries.length > 0 &&
          newEntries.every((e) => (e.text || "") === "(empty response)" || looksLikeJunk(e.text || ""));
        if (allEmpty) {
          consecutiveEmptyRounds++;
          if (consecutiveEmptyRounds >= EMPTY_ROUND_BREAK_THRESHOLD) {
            this.earlyStopDetail = `mappers-silenced (${consecutiveEmptyRounds} consecutive empty cycles)`;
            this.appendSystem(
              `All mappers produced empty/junk output for ${consecutiveEmptyRounds} consecutive cycles — ending map-reduce early.`,
            );
            break;
          }
        } else {
          consecutiveEmptyRounds = 0;
        }

        // Phase B (Task #97): if every mapper signalled COMPLETE in
        // this cycle's MAP phase, there's nothing new to reduce next
        // cycle. Force the upcoming reducer pass to be tagged as the
        // synthesis (since it's now the final reducer output) and
        // break after.
        const allComplete =
          mappers.length > 0 &&
          mappers.every((m) => this.mappersComplete.has(m.id));
        const isEarlyStop = allComplete && r < cfg.rounds;

        // REDUCE — reducer sees full transcript (including all mapper
        // reports from this cycle) and produces a synthesis.
        this.appendSystem(`Cycle ${r}/${cfg.rounds}: REDUCE phase — reducer synthesizing.`);
        await this.runReducerTurn(reducer, r, cfg.rounds, isEarlyStop || undefined);

        if (isEarlyStop) {
          this.earlyStopDetail =
            `all-mappers-complete after cycle ${r}/${cfg.rounds}`;
          this.appendSystem(
            `All ${mappers.length} mappers reported COMPLETE — ending map-reduce early at cycle ${r}/${cfg.rounds}.`,
          );
          break;
        }
      }
      if (!this.stopping) this.appendSystem("Map-reduce run complete.");
    } catch (err) {
      crashMessage = err instanceof Error ? err.message : String(err);
      this.opts.emit({ type: "error", message: crashMessage });
    } finally {
      // Task #150: end-of-run reflection (reducer does it).
      if (!crashMessage && !this.stopping && cfg.runId) {
        const reducer = this.opts.manager.list().find((a) => a.index === 1);
        if (reducer) {
          const ctxSummary = `Map-reduce preset · 1 reducer + ${cfg.agentCount - 1} mappers · ran ${this.round}/${cfg.rounds} cycles${this.earlyStopDetail ? ` · early-stop: ${this.earlyStopDetail}` : ""}`;
          await runEndReflection({
            agent: reducer, preset: cfg.preset, runId: cfg.runId, clonePath: cfg.localPath,
            contextSummary: ctxSummary, log: (msg) => this.appendSystem(msg),
          }).catch(() => {});
        }
      }
      await this.writeSummary(cfg, crashMessage);
      // Unit 55: auto-killAll on natural completion. Task #68: surface
      // the kill result in the transcript.
      if (!this.stopping) {
        const killResult = await this.opts.manager.killAll();
        this.appendSystem(formatPortReleaseLine(killResult));
        this.setPhase("completed");
      }
    }
  }

  // Unit 33: shared summary writer pattern — see RoundRobinRunner.
  private async writeSummary(cfg: RunConfig, crashMessage?: string): Promise<void> {
    if (this.summaryWritten) return;
    this.summaryWritten = true;
    if (this.startedAt === undefined) return;
    let gitStatus = { porcelain: "", changedFiles: 0 };
    try {
      gitStatus = await this.opts.repos.gitStatus(cfg.localPath);
    } catch {
      // best-effort
    }
    const summary = buildDiscussionSummary({
      config: {
        repoUrl: cfg.repoUrl,
        localPath: cfg.localPath,
        preset: cfg.preset,
        model: cfg.model,
        runId: cfg.runId,
      },
      agentCount: cfg.agentCount,
      rounds: cfg.rounds,
      startedAt: this.startedAt,
      endedAt: Date.now(),
      crashMessage,
      stopping: this.stopping,
      earlyStopDetail: this.earlyStopDetail,
      filesChanged: gitStatus.changedFiles,
      finalGitStatus: gitStatus.porcelain,
      agents: this.stats.buildPerAgentStats(),
      transcript: this.transcript,
    });
    try {
      await writeRunSummary(cfg.localPath, summary);
      this.appendSystem(
        formatRunFinishedBanner(summary),
        buildRunFinishedSummary(summary),
      );
      this.appendSystem(
        `Wrote run summary (stopReason=${summary.stopReason}, wallClockMs=${summary.wallClockMs}, files=${summary.filesChanged}).`,
      );
    } catch (writeErr) {
      const msg = writeErr instanceof Error ? writeErr.message : String(writeErr);
      this.appendSystem(`Failed to write run summary (${msg})`);
    }
  }

  private async runMapperTurn(
    agent: Agent,
    round: number,
    totalRounds: number,
    slice: readonly string[],
    seedSnapshot: readonly TranscriptEntry[],
  ): Promise<void> {
    const prompt = buildMapperPrompt(agent.index, round, totalRounds, slice, seedSnapshot);
    // Phase B (Task #97): scan the mapper's last few lines for a
    // COMPLETE: true|false declaration. Tracking is sticky — once a
    // mapper says complete, it stays complete; later cycles can't
    // un-set it (they wouldn't be running if the loop broke).
    await this.runAgent(agent, prompt, (text) => {
      if (parseMapperComplete(text)) {
        this.mappersComplete.add(agent.id);
      }
      return undefined;
    });
  }

  private async runReducerTurn(
    agent: Agent,
    round: number,
    totalRounds: number,
    isFinalOverride?: boolean,
  ): Promise<void> {
    const prompt = buildReducerPrompt(round, totalRounds, [...this.transcript]);
    // Task #82: tag the FINAL cycle's reducer output as the run's
    // synthesis so the modal renders distinctively. Earlier cycles
    // are intermediate reductions; only the last one is the "answer".
    // Task #97: allow explicit override so the early-stop reducer
    // pass also gets the synthesis tag (its output IS the answer).
    const isFinal = isFinalOverride ?? round === totalRounds;
    // Task #108: defensive guard — if the reducer's text looks like
    // junk, do NOT apply the synthesis tag (the run history modal
    // would otherwise render `:` or similar as the canonical answer).
    await this.runAgent(
      agent,
      prompt,
      isFinal
        ? (text) => {
            if (looksLikeJunk(text)) {
              this.appendSystem(
                `[${agent.id}] map-reduce synthesis text is degenerate (${text.length} chars) — kept in transcript but NOT tagged as canonical synthesis.`,
              );
              return undefined;
            }
            return { kind: "mapreduce_synthesis", cycle: round };
          }
        : undefined,
    );
  }

  private async runAgent(
    agent: Agent,
    prompt: string,
    enrichSummary?: (text: string) => TranscriptEntrySummary | undefined,
  ): Promise<void> {
    this.opts.manager.markStatus(agent.id, "thinking");
    this.emitAgentState({
      id: agent.id,
      index: agent.index,
      port: agent.port,
      sessionId: agent.sessionId,
      status: "thinking",
      thinkingSince: Date.now(),
    });
    this.stats.countTurn(agent.id);

    // Pattern 11: 20m → 4m. See CouncilRunner for rationale.
    const ABSOLUTE_MAX_MS = 4 * 60_000;
    const turnStart = Date.now();
    this.opts.manager.touchActivity(agent.sessionId, turnStart);

    const controller = new AbortController();
    let abortedReason: string | null = null;
    const watchdog = setInterval(() => {
      if (Date.now() - turnStart > ABSOLUTE_MAX_MS) {
        abortedReason = `absolute turn cap hit (${ABSOLUTE_MAX_MS / 1000}s)`;
        controller.abort(new Error(abortedReason));
        void agent.client.session.abort({ path: { id: agent.sessionId } }).catch(() => {});
      }
    }, 10_000);

    try {
      // Unit 16: shared retry wrapper.
      const res = await promptWithRetry(agent, prompt, {
        onTokens: ({ promptTokens, responseTokens }) => this.stats.recordTokens(agent.id, promptTokens, responseTokens),
        signal: controller.signal,
        manager: this.opts.manager,
        // Unit 20: read-only tools for discussion presets.
        agentName: "swarm-read",
        describeError: describeSdkError,
        onTiming: ({ attempt, elapsedMs, success }) => {
          this.stats.onTiming(agent.id, success, elapsedMs);
          this.opts.logDiag?.({
            type: "_prompt_timing",
            preset: this.active?.preset,
            agentId: agent.id,
            agentIndex: agent.index,
            attempt,
            elapsedMs,
            success,
          });
          // Improvement #4: per-agent first-prompt cold-start logging.
          this.opts.manager.recordPromptComplete(agent.id, { attempt, elapsedMs, success });
          // Unit 40: live latency sample over WS for the UI sparkline.
          this.opts.emit({
            type: "agent_latency_sample",
            agentId: agent.id,
            agentIndex: agent.index,
            attempt,
            elapsedMs,
            success,
            ts: Date.now(),
          });
        },
        onRetry: ({ attempt, max, reasonShort, delayMs }) => {
          this.stats.onRetry(agent.id);
          this.appendSystem(
            `[${agent.id}] transport error (${reasonShort}) — retry ${attempt}/${max} in ${Math.round(delayMs / 1000)}s`,
          );
          this.opts.manager.markStatus(agent.id, "retrying", {
            retryAttempt: attempt,
            retryMax: max,
            retryReason: reasonShort,
          });
          this.emitAgentState({
            id: agent.id,
            index: agent.index,
            port: agent.port,
            sessionId: agent.sessionId,
            status: "retrying",
            retryAttempt: attempt,
            retryMax: max,
            retryReason: reasonShort,
          });
        },
      });
      const diagCtx = {
        runner: "map-reduce",
        agentId: agent.id,
        agentIndex: agent.index,
        logDiag: this.opts.logDiag,
      };
      const extracted = extractTextWithDiag(res, diagCtx);
      let text = extracted.text;
      // Task #54: retry on model silence (see CouncilRunner for detail).
      // Pattern 8: retry on junk-short single-token output too.
      if ((extracted.isEmpty || looksLikeJunk(text)) && !this.stopping) {
        const retryText = await retryEmptyResponse(agent, prompt, "swarm-read", diagCtx);
        if (retryText !== null) text = retryText;
      }
      // Task #115: track Pattern 8 stuck-loop, warn on threshold.
      trackPostRetryJunk(text, {
        agentId: agent.id,
        recordJunkPostRetry: (id, j) => this.stats.recordJunkPostRetry(id, j),
        appendSystem: (msg) => this.appendSystem(msg),
      });
      const entry: TranscriptEntry = {
        id: randomUUID(),
        role: "agent",
        agentId: agent.id,
        agentIndex: agent.index,
        text,
        ts: Date.now(),
        // Task #82: optional enriched summary from the caller.
        summary: enrichSummary?.(text),
      };
      this.transcript.push(entry);
      this.opts.emit({ type: "transcript_append", entry });
      this.opts.emit({ type: "agent_streaming_end", agentId: agent.id });
      this.opts.manager.markStatus(agent.id, "ready", { lastMessageAt: entry.ts });
      this.emitAgentState({
        id: agent.id,
        index: agent.index,
        port: agent.port,
        sessionId: agent.sessionId,
        status: "ready",
        lastMessageAt: entry.ts,
      });
    } catch (err) {
      const msg = abortedReason ?? describeSdkError(err);
      this.appendSystem(`[${agent.id}] error: ${msg}`);
      this.opts.emit({ type: "agent_streaming_end", agentId: agent.id });
      this.opts.manager.markStatus(agent.id, "failed", { error: msg });
      this.emitAgentState({
        id: agent.id,
        index: agent.index,
        port: agent.port,
        sessionId: agent.sessionId,
        status: "failed",
        error: msg,
      });
    } finally {
      clearInterval(watchdog);
    }
  }

  private appendSystem(text: string, summary?: TranscriptEntrySummary): void {
    const entry: TranscriptEntry = { id: randomUUID(), role: "system", text, ts: Date.now(), summary };
    this.transcript.push(entry);
    this.opts.emit({ type: "transcript_append", entry });
  }

  private setPhase(phase: SwarmPhase): void {
    this.phase = phase;
    this.opts.emit({ type: "swarm_state", phase, round: this.round });
  }

  private emitAgentState(s: AgentState): void {
    // thinkingSince REST-snapshot fix: route through the manager so
    // the agentStates mirror gets updated in lockstep with the WS
    // broadcast. See AgentManager.recordAgentState.
    this.opts.manager.recordAgentState(s);
  }
}

// Skip repo entries that don't contribute to understanding: VCS metadata,
// node_modules, build output. The mapper listing already truncated by
// RepoService.listTopLevel; this is a further filter on the labeled slice.
//
// Task #106 (2026-04-25): expanded with trivial config files that
// caused "tiny single-file slice" collapse in run 2bcf662f — when a
// mapper's slice was just `.editorconfig`, the model latched onto its
// numeric values and emitted just "0.5", "11.4", etc. These configs
// rarely contain anything a swarm needs to reason about; skipping them
// keeps slices semantically meaningful even at small mapper counts.
const SKIP_ENTRIES = new Set([
  ".git/", ".git", "node_modules/", "node_modules", ".DS_Store",
  // Task #106 (2026-04-25):
  ".editorconfig",
  ".gitignore",
  ".gitattributes",
  ".npmrc",
  ".nvmrc",
  ".prettierrc", ".prettierrc.json", ".prettierrc.js",
  ".eslintrc", ".eslintrc.json", ".eslintrc.js",
  ".env.example",
  "LICENSE", "LICENSE.md", "LICENSE.txt",
]);

// Phase B (Task #97): scan a mapper's response for the
// "COMPLETE: true|false" declaration. Looks at the LAST 3 non-blank
// lines, then within each line searches for the COMPLETE: pattern
// anywhere (not just line-start) — observed in v1 validation that
// the model sometimes prefixes with "Final line:" (literal echo of
// the instruction), so an anchored regex would miss it.
export function parseMapperComplete(text: string): boolean {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const tail = lines.slice(-3);
  for (const line of tail) {
    const m = /\bcomplete\s*:\s*(true|false)\b/i.exec(line);
    if (m) return m[1].toLowerCase() === "true";
  }
  return false;
}

// Round-robin partition of `entries` into `k` slices. Exported so tests
// can lock down the distribution (every entry appears in exactly one
// slice; slices differ in length by at most 1).
export function sliceRoundRobin<T>(entries: readonly T[], k: number): T[][] {
  if (k <= 0) return [];
  const slices: T[][] = Array.from({ length: k }, () => []);
  entries.forEach((e, i) => slices[i % k].push(e));
  return slices;
}

export function buildMapperPrompt(
  mapperIndex: number,
  round: number,
  totalRounds: number,
  slice: readonly string[],
  seedSnapshot: readonly TranscriptEntry[],
): string {
  const seedText = seedSnapshot.map((e) => `[SYSTEM] ${e.text}`).join("\n\n");
  const sliceList = slice.length === 0 ? "(empty slice)" : slice.join(", ");

  return [
    `You are Mapper Agent ${mapperIndex} in a map-reduce swarm.`,
    `This is cycle ${round}/${totalRounds}. You cannot see the reducer's output or any peer mapper's report — that is deliberate, so your report is independent.`,
    "",
    `Your slice of the repo: ${sliceList}`,
    "Inspect ONLY the entries in your slice. Do not read or reference files outside your slice.",
    "Your working directory IS the project clone — use file-read, grep, and find-files tools to actually read the assigned entries.",
    "",
    "Produce a CONCRETE report (under ~300 words) covering:",
    "- What each entry in your slice is (purpose / role).",
    "- Anything noteworthy: obvious defects, design choices, TODOs, test coverage gaps, interesting patterns.",
    "- Cite file paths (e.g. `src/foo.ts:42`) for any claim you make.",
    "",
    "Do NOT speculate about entries outside your slice.",
    "",
    // Phase B (Task #97): convergence signal. Mapper declares when
    // its slice is fully understood and further cycles would only
    // re-read the same files. When EVERY mapper reports COMPLETE,
    // the run can end early. Be honest — declaring complete on a
    // partially-understood slice wastes the reducer's time.
    "On the FINAL line of your response (no markdown, nothing after it), output exactly one of:",
    "  COMPLETE: true   — your slice is fully understood; you have nothing meaningful left to add even with more cycles.",
    "  COMPLETE: false  — there is more to investigate (gaps, ambiguity, unread files in your slice, etc).",
    "",
    "=== SEED ===",
    seedText || "(empty seed)",
    "=== END SEED ===",
    "",
    `Now respond as Mapper Agent ${mapperIndex}.`,
  ].join("\n");
}

export function buildReducerPrompt(
  round: number,
  totalRounds: number,
  transcript: readonly TranscriptEntry[],
): string {
  const transcriptText = transcript
    .map((e) => {
      if (e.role === "system") return `[SYSTEM] ${e.text}`;
      if (e.role === "user") return `[HUMAN] ${e.text}`;
      return `[Mapper ${e.agentIndex}] ${e.text}`;
    })
    .join("\n\n");

  const closingInstruction =
    round < totalRounds
      ? "4. Name one GAP in coverage — an area no mapper covered well or where their reports disagree — that a future cycle should target."
      : "4. Close with your final unified picture of the project: what it is, who it's for, and the single most important next step.";

  return [
    `You are the REDUCER (Agent 1) in a map-reduce swarm.`,
    `This is the reduce step of cycle ${round}/${totalRounds}. Mapper agents just reported on their assigned slices of the repo.`,
    "",
    "Your job is NOT to summarize each mapper individually — it is to SYNTHESIZE across them. Look for the things only visible from the reducer's vantage:",
    "  - SURPRISES: a finding from one mapper that recontextualizes another's slice (e.g. Mapper 2 found a singleton that explains the duplication Mapper 4 reported).",
    "  - CONTRADICTIONS: places where mappers reached different conclusions about the same area (e.g. Mapper 1 says the API is REST, Mapper 3 says it's gRPC — both can't be right).",
    "  - GAPS: the thing nobody covered well that the union of slices makes obvious.",
    "",
    "Produce a synthesis (under ~500 words) that:",
    "1. **Project picture** — what this codebase IS, who it's for, citing mapper findings.",
    "2. **Cross-slice surprises + contradictions** — what jumped out when you read all reports together. Name the mappers and the specific tension.",
    "3. **What's solid / what's missing** — with mapper + file attributions.",
    closingInstruction,
    "",
    "Cite mappers by their agent index (e.g. \"Mapper 3 noted…\") and by file paths they cited. Do NOT invent evidence beyond what mappers reported. Do NOT just restate each mapper in turn — that's the failure mode this prompt exists to prevent.",
    "",
    "=== TRANSCRIPT ===",
    transcriptText,
    "=== END TRANSCRIPT ===",
    "",
    "Now write your synthesis.",
  ].join("\n");
}

function describeSdkError(err: unknown): string {
  if (err instanceof Error) {
    const parts: string[] = [err.message];
    let cause: unknown = (err as { cause?: unknown }).cause;
    let depth = 0;
    while (cause && depth < 4) {
      if (cause instanceof Error) {
        const code = (cause as { code?: string }).code;
        parts.push(code ? `${cause.message} [${code}]` : cause.message);
        cause = (cause as { cause?: unknown }).cause;
      } else {
        parts.push(String(cause));
        cause = undefined;
      }
      depth++;
    }
    return parts.join(" <- ");
  }
  if (err && typeof err === "object") {
    const o = err as { name?: string; message?: string };
    const head = o.name ? `${o.name}: ` : "";
    if (o.message) return head + o.message;
    try {
      return head + JSON.stringify(o).slice(0, 500);
    } catch {
      return head + String(err);
    }
  }
  return String(err);
}
