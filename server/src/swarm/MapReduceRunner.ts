import { randomUUID } from "node:crypto";
import type { Agent } from "../services/AgentManager.js";
import type {
  AgentState,
  SwarmEvent,
  SwarmPhase,
  SwarmStatus,
  TranscriptEntry,
} from "../types.js";
import type { RunConfig, RunnerOpts, SwarmRunner } from "./SwarmRunner.js";
import { promptWithRetry } from "./promptWithRetry.js";
import { AgentStatsCollector } from "./agentStatsCollector.js";
import { buildDiscussionSummary, writeRunSummary } from "./runSummary.js";
import { extractTextWithDiag } from "./extractText.js";
import { formatCloneMessage } from "./cloneMessage.js";

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
    this.appendSystem(seed);
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

      for (let r = 1; r <= cfg.rounds; r++) {
        if (this.stopping) break;
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
        const seedSnapshot = this.transcript.filter((e) => e.role === "system");
        await Promise.allSettled(
          mappers.map((m, i) => {
            const mySlice = slices[i] ?? [];
            return this.runMapperTurn(m, r, cfg.rounds, mySlice, seedSnapshot);
          }),
        );
        if (this.stopping) break;

        // REDUCE — reducer sees full transcript (including all mapper
        // reports from this cycle) and produces a synthesis.
        this.appendSystem(`Cycle ${r}/${cfg.rounds}: REDUCE phase — reducer synthesizing.`);
        await this.runReducerTurn(reducer, r, cfg.rounds);
      }
      if (!this.stopping) this.appendSystem("Map-reduce run complete.");
    } catch (err) {
      crashMessage = err instanceof Error ? err.message : String(err);
      this.opts.emit({ type: "error", message: crashMessage });
    } finally {
      await this.writeSummary(cfg, crashMessage);
      // Unit 55: auto-killAll on natural completion (see RoundRobinRunner).
      if (!this.stopping) {
        await this.opts.manager.killAll();
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
      filesChanged: gitStatus.changedFiles,
      finalGitStatus: gitStatus.porcelain,
      agents: this.stats.buildPerAgentStats(),
    });
    try {
      await writeRunSummary(cfg.localPath, summary);
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
    await this.runAgent(agent, prompt);
  }

  private async runReducerTurn(agent: Agent, round: number, totalRounds: number): Promise<void> {
    const prompt = buildReducerPrompt(round, totalRounds, [...this.transcript]);
    await this.runAgent(agent, prompt);
  }

  private async runAgent(agent: Agent, prompt: string): Promise<void> {
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

    const ABSOLUTE_MAX_MS = 20 * 60_000;
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
        signal: controller.signal,
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
      const text = extractTextWithDiag(res, {
        runner: "map-reduce",
        agentId: agent.id,
        agentIndex: agent.index,
        logDiag: this.opts.logDiag,
      });
      const entry: TranscriptEntry = {
        id: randomUUID(),
        role: "agent",
        agentId: agent.id,
        agentIndex: agent.index,
        text,
        ts: Date.now(),
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

  private appendSystem(text: string): void {
    const entry: TranscriptEntry = { id: randomUUID(), role: "system", text, ts: Date.now() };
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
const SKIP_ENTRIES = new Set([".git/", ".git", "node_modules/", "node_modules", ".DS_Store"]);

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
    "Read every mapper report in the transcript below. Produce a synthesis (under ~500 words) that:",
    "1. Summarizes what the project is and who it seems to be for, citing mapper findings.",
    "2. Summarizes what's working across the codebase (with mapper attributions).",
    "3. Summarizes what's missing or problematic (with mapper attributions).",
    closingInstruction,
    "",
    "Cite mappers by their agent index (e.g. \"Mapper 3 noted…\") and by file paths they cited. Do NOT invent evidence beyond what mappers reported.",
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
