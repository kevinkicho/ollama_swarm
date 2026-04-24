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

// Orchestrator–worker hierarchy.
// Agent 1 is the LEAD: it reads the repo, produces a plan assigning one
// subtask to each worker, then (after workers return) synthesizes a final
// answer from their reports. Agents 2..N are WORKERS: they receive only
// their assigned subtask plus the seed — NOT the shared transcript, NOT
// peer workers' reports. Each worker's output is a structured report that
// feeds the lead's synthesis.
//
// `rounds` = number of plan→execute→synthesize cycles. Between cycles, the
// lead sees its own prior synthesis and may refine the plan. Workers are
// always fresh-subtask; they don't accumulate context across cycles.
//
// Discussion-only, no file edits. The value over council is directed
// division of labor: the lead decides who studies what, so coverage is
// controlled rather than emergent.
export class OrchestratorWorkerRunner implements SwarmRunner {
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
    return this.phase !== "idle" && this.phase !== "stopped";
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
    const { destPath } = await this.opts.repos.clone({ url: cfg.repoUrl, destPath: cfg.localPath });
    await this.opts.repos.writeOpencodeConfig(destPath, cfg.model);
    this.appendSystem(`Cloned ${cfg.repoUrl} -> ${destPath}`);

    this.setPhase("spawning");
    const spawnTasks: Promise<Agent>[] = [];
    for (let i = 1; i <= cfg.agentCount; i++) {
      spawnTasks.push(this.opts.manager.spawnAgent({ cwd: destPath, index: i, model: cfg.model }));
    }
    const results = await Promise.allSettled(spawnTasks);
    const ready = results
      .filter((r): r is PromiseFulfilledResult<Agent> => r.status === "fulfilled")
      .map((r) => r.value);
    if (ready.length === 0) throw new Error("No agents started successfully");
    if (ready.length < 2) throw new Error("Orchestrator–worker needs at least 1 lead + 1 worker (agentCount >= 2)");
    this.appendSystem(
      `${ready.length}/${cfg.agentCount} agents ready on ports ${ready.map((a) => a.port).join(", ")}. Agent 1 is the LEAD; agents 2..${cfg.agentCount} are WORKERS.`,
    );
    this.stats.registerAgents(ready);

    this.setPhase("seeding");
    await this.seed(destPath, cfg);

    this.setPhase("discussing");
    this.startedAt = Date.now();
    void this.loop(cfg);
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
      "Pattern: Orchestrator–worker. Agent 1 is the LEAD; other agents are WORKERS.",
      "Lead will produce a plan (one subtask per worker), workers will execute in parallel with no visibility of peers, then lead will synthesize.",
    ].join("\n");
    this.appendSystem(seed);
  }

  private async loop(cfg: RunConfig): Promise<void> {
    let crashMessage: string | undefined;
    try {
      const agents = this.opts.manager.list();
      const lead = agents.find((a) => a.index === 1);
      const workers = agents.filter((a) => a.index !== 1);
      if (!lead) throw new Error("lead agent (index 1) did not spawn");
      if (workers.length === 0) throw new Error("no workers spawned");

      for (let r = 1; r <= cfg.rounds; r++) {
        if (this.stopping) break;
        this.round = r;
        this.opts.emit({ type: "swarm_state", phase: "discussing", round: r });

        // PLAN — lead gets the full transcript (including any prior cycles'
        // syntheses) and produces a fresh plan.
        this.appendSystem(`Cycle ${r}/${cfg.rounds}: lead planning.`);
        const planText = await this.runLeadTurn(
          lead,
          r,
          cfg.rounds,
          buildLeadPlanPrompt(r, cfg.rounds, workers.map((w) => w.index), [...this.transcript]),
          "plan",
        );
        if (this.stopping) break;

        const plan = parsePlan(planText, workers.map((w) => w.index));
        if (plan.assignments.length === 0) {
          this.appendSystem(
            `Cycle ${r}: lead produced no parseable assignments — skipping execute phase this cycle. Raw lead output preserved in transcript.`,
          );
          continue;
        }

        // EXECUTE — workers fire in parallel. Each sees ONLY its assigned
        // subtask + the seed, not the full transcript or peer reports.
        // Unit 18b (2026-04-22): pre-batch parallel warmup REMOVED. v4
        // battle test showed it didn't help OW (same 50% success vs
        // worse) — the parallel cold-start ceiling applied to the warmup
        // batch too. OW relies on serial spawn-warmup from start() only.
        const seedSnapshot = this.transcript.filter((e) => e.role === "system");
        await Promise.allSettled(
          plan.assignments.map((a) => {
            const w = workers.find((x) => x.index === a.agentIndex);
            if (!w) return Promise.resolve();
            return this.runWorkerTurn(w, r, cfg.rounds, a.subtask, seedSnapshot);
          }),
        );
        if (this.stopping) break;

        // SYNTHESIZE — lead sees the full transcript again (now including
        // all worker reports from this cycle) and produces a consolidated
        // answer for the cycle.
        this.appendSystem(`Cycle ${r}/${cfg.rounds}: lead synthesizing.`);
        await this.runLeadTurn(
          lead,
          r,
          cfg.rounds,
          buildLeadSynthesisPrompt(r, cfg.rounds, [...this.transcript]),
          "synthesis",
        );
      }
      if (!this.stopping) this.appendSystem("Orchestrator–worker run complete.");
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

  private async runLeadTurn(
    agent: Agent,
    round: number,
    totalRounds: number,
    prompt: string,
    kind: "plan" | "synthesis",
  ): Promise<string> {
    return this.runAgent(agent, round, totalRounds, prompt, `lead-${kind}`);
  }

  private async runWorkerTurn(
    agent: Agent,
    round: number,
    totalRounds: number,
    subtask: string,
    seedSnapshot: readonly TranscriptEntry[],
  ): Promise<void> {
    const prompt = buildWorkerPrompt(agent.index, round, totalRounds, subtask, seedSnapshot);
    await this.runAgent(agent, round, totalRounds, prompt, "worker");
  }

  private async runAgent(
    agent: Agent,
    _round: number,
    _totalRounds: number,
    prompt: string,
    _label: string,
  ): Promise<string> {
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
      const text = extractText(res) ?? "(empty response)";
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
      return text;
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
      return "";
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
    this.opts.emit({ type: "agent_state", agent: s });
  }
}

export interface Assignment {
  agentIndex: number;
  subtask: string;
}

export interface Plan {
  assignments: Assignment[];
}

// Exported for testability. Accepts either a clean JSON object with
// `assignments: [{agentIndex, subtask}]` or a JSON object wrapped in a
// markdown fence. Silently drops malformed assignments. Filters out any
// agentIndex not in the allowed worker set (so a confused lead can't
// assign work to itself or to a non-spawned worker).
export function parsePlan(raw: string, allowedWorkerIndices: readonly number[]): Plan {
  const allowed = new Set(allowedWorkerIndices);
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const candidate = fenceMatch ? fenceMatch[1] : raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    // Try to find the first {...} JSON-looking block
    const braceMatch = candidate.match(/\{[\s\S]*\}/);
    if (!braceMatch) return { assignments: [] };
    try {
      parsed = JSON.parse(braceMatch[0]);
    } catch {
      return { assignments: [] };
    }
  }
  if (!parsed || typeof parsed !== "object") return { assignments: [] };
  const assignmentsRaw = (parsed as { assignments?: unknown }).assignments;
  if (!Array.isArray(assignmentsRaw)) return { assignments: [] };
  const assignments: Assignment[] = [];
  const seenAgents = new Set<number>();
  for (const a of assignmentsRaw) {
    if (!a || typeof a !== "object") continue;
    const idx = (a as { agentIndex?: unknown }).agentIndex;
    const subtask = (a as { subtask?: unknown }).subtask;
    if (typeof idx !== "number" || !allowed.has(idx)) continue;
    if (typeof subtask !== "string" || subtask.trim().length === 0) continue;
    if (seenAgents.has(idx)) continue; // one subtask per worker per cycle
    seenAgents.add(idx);
    assignments.push({ agentIndex: idx, subtask: subtask.trim() });
  }
  return { assignments };
}

export function buildLeadPlanPrompt(
  round: number,
  totalRounds: number,
  workerIndices: readonly number[],
  transcript: readonly TranscriptEntry[],
): string {
  const transcriptText = transcript
    .map((e) => {
      if (e.role === "system") return `[SYSTEM] ${e.text}`;
      if (e.role === "user") return `[HUMAN] ${e.text}`;
      return `[Agent ${e.agentIndex}] ${e.text}`;
    })
    .join("\n\n");

  const workerList = workerIndices.map((i) => `Agent ${i}`).join(", ");

  return [
    `You are the LEAD agent in an orchestrator–worker swarm inspecting a cloned GitHub project.`,
    `This is planning phase of cycle ${round}/${totalRounds}.`,
    `Your workers are: ${workerList}. Assign ONE subtask to each — workers execute in parallel with no visibility of each other.`,
    "",
    "Output ONLY a JSON object with this shape (no prose, no markdown fences):",
    '{"assignments": [{"agentIndex": 2, "subtask": "…"}, {"agentIndex": 3, "subtask": "…"}, …]}',
    "",
    "Rules for good subtasks:",
    "- Each subtask is self-contained (the worker sees only its subtask + the seed; no peer context, no your planning text).",
    "- Subtasks should DIVIDE LABOR: e.g. \"inspect src/\", \"read README and package.json\", \"inspect tests/ and note coverage\", \"audit dependencies in package.json\". Avoid duplicate assignments.",
    "- Keep subtask text under ~200 chars. Be specific about what to report back.",
    "- One assignment per worker. Do NOT assign more than one subtask to the same agent.",
    round > 1
      ? "- This is a later cycle: you have prior cycle syntheses in the transcript. Use them to refine — dispatch workers to fill gaps the prior synthesis surfaced."
      : "- This is cycle 1: start with broad coverage of the repo.",
    "",
    "=== TRANSCRIPT SO FAR ===",
    transcriptText || "(empty — this is the first planning step)",
    "=== END TRANSCRIPT ===",
  ].join("\n");
}

export function buildWorkerPrompt(
  workerIndex: number,
  round: number,
  totalRounds: number,
  subtask: string,
  seedSnapshot: readonly TranscriptEntry[],
): string {
  const seedText = seedSnapshot
    .map((e) => `[SYSTEM] ${e.text}`)
    .join("\n\n");

  return [
    `You are Worker Agent ${workerIndex} in an orchestrator–worker swarm.`,
    `This is cycle ${round}/${totalRounds}. You cannot see the lead's full plan or any peer worker's output — that is deliberate, so your report is independent.`,
    "",
    "Your working directory IS the project clone — use file-read, grep, and find-files tools to inspect it.",
    "Respond with a CONCRETE report (under ~300 words) of what you found, citing file paths (e.g. `src/foo.ts:42`) where relevant.",
    "Do NOT try to coordinate with other workers or ask for more scope — just execute your subtask and report.",
    "",
    "=== SEED ===",
    seedText || "(empty seed)",
    "=== END SEED ===",
    "",
    "YOUR SUBTASK:",
    subtask,
    "",
    `Now respond as Worker Agent ${workerIndex}.`,
  ].join("\n");
}

export function buildLeadSynthesisPrompt(
  round: number,
  totalRounds: number,
  transcript: readonly TranscriptEntry[],
): string {
  const transcriptText = transcript
    .map((e) => {
      if (e.role === "system") return `[SYSTEM] ${e.text}`;
      if (e.role === "user") return `[HUMAN] ${e.text}`;
      return `[Agent ${e.agentIndex}] ${e.text}`;
    })
    .join("\n\n");

  return [
    `You are the LEAD agent in an orchestrator–worker swarm.`,
    `This is the synthesis phase of cycle ${round}/${totalRounds}. Your workers have just reported back on the subtasks you assigned.`,
    "",
    "Read every worker report in the transcript below. Produce a synthesis (under ~400 words) that:",
    "1. Names what the project is and who it seems to be for.",
    "2. Summarizes what's working and what's missing, drawing from worker reports.",
    "3. Proposes one concrete next action the swarm should take, with a rationale citing worker findings.",
    round < totalRounds
      ? "4. Notes one gap or inconsistency across worker reports that a future cycle should investigate."
      : "4. Closes with a final recommendation now that this is the last cycle.",
    "",
    "Cite workers by index (e.g. \"Agent 3 noted…\") when referencing their findings. Do not re-invent evidence not in a worker report.",
    "",
    "=== TRANSCRIPT ===",
    transcriptText,
    "=== END TRANSCRIPT ===",
    "",
    "Now write your synthesis.",
  ].join("\n");
}

// Duplicated helpers — see CouncilRunner for rationale. Extraction waits
// until a 4th caller wants them.
function extractText(res: unknown): string | undefined {
  const any = res as {
    data?: {
      parts?: Array<{ type?: string; text?: string }>;
      info?: { parts?: Array<{ type?: string; text?: string }> };
      text?: string;
    };
  };
  const parts = any?.data?.parts ?? any?.data?.info?.parts;
  if (Array.isArray(parts)) {
    const texts = parts
      .filter((p) => p?.type === "text" && typeof p.text === "string")
      .map((p) => p.text as string);
    if (texts.length) return texts.join("\n");
  }
  return any?.data?.text;
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
