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

// Stigmergy / pheromone trails — repo exploration mode.
// No central planner, no role assignment. Agents post annotations on
// files they read (interest 0-10, confidence 0-10, short note). Future
// agents see the running annotation table and pick which file to read
// next based on it — the model decides, the runner just keeps the table.
//
// Per round, agents go in index order (1..N). Each picks ONE file to
// inspect, reads it, returns a structured annotation. Runner parses,
// updates the table, broadcasts. The annotation table is included in
// the next agent's prompt — that's the "pheromone trail."
//
// `rounds` = how many exploration passes through agents. Total turns =
// rounds × agentCount. Discussion-only, no file edits.
export class StigmergyRunner implements SwarmRunner {
  private transcript: TranscriptEntry[] = [];
  private phase: SwarmPhase = "idle";
  private round = 0;
  private stopping = false;
  private active?: RunConfig;
  // The annotation table — the shared "pheromone" state. File path →
  // aggregated annotation. Updated after each agent's turn.
  private annotations = new Map<string, AnnotationState>();

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
    this.annotations = new Map();
    this.stopping = false;
    this.round = 0;
    this.active = cfg;

    this.setPhase("cloning");
    const { destPath } = await this.opts.repos.clone({ url: cfg.repoUrl, destPath: cfg.localPath });
    await this.opts.repos.writeOpencodeConfig(destPath, cfg.model);
    this.appendSystem(`Cloned ${cfg.repoUrl} -> ${destPath}`);

    this.setPhase("spawning");
    const spawnTasks: Promise<Agent>[] = [];
    for (let i = 1; i <= cfg.agentCount; i++) {
      // Unit 18: skip per-spawn warmup; we warm serially below.
      spawnTasks.push(this.opts.manager.spawnAgent({ cwd: destPath, index: i, model: cfg.model, skipWarmup: true }));
    }
    const results = await Promise.allSettled(spawnTasks);
    const ready = results
      .filter((r): r is PromiseFulfilledResult<Agent> => r.status === "fulfilled")
      .map((r) => r.value);
    if (ready.length < 2) {
      throw new Error(
        `Stigmergy needs at least 2 agents — emergence requires multiple participants. Only ${ready.length} spawned.`,
      );
    }
    this.appendSystem(
      `${ready.length}/${cfg.agentCount} agents ready on ports ${ready.map((a) => a.port).join(", ")}. All agents are equal explorers — no planner, no roles.`,
    );
    await this.opts.manager.warmupSerially(ready);

    this.setPhase("seeding");
    await this.seed(destPath, cfg);

    this.setPhase("discussing");
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
      "Pattern: Stigmergy (pheromone trails). Agents pick which file to read each turn based on a shared annotation table. Untouched files attract; high-interest low-confidence files attract; well-covered files repel. The exploration is self-organizing — no central planner.",
    ].join("\n");
    this.appendSystem(seed);
  }

  private async loop(cfg: RunConfig, clonePath: string): Promise<void> {
    try {
      const agents = this.opts.manager.list();
      const initialEntries = await this.opts.repos.listTopLevel(clonePath);
      const candidatePaths = initialEntries.filter((e) => !SKIP_ENTRIES.has(e));

      for (let r = 1; r <= cfg.rounds; r++) {
        if (this.stopping) break;
        this.round = r;
        this.opts.emit({ type: "swarm_state", phase: "discussing", round: r });

        for (const agent of agents) {
          if (this.stopping) break;
          await this.runExplorerTurn(agent, r, cfg.rounds, candidatePaths);
        }
      }
      if (!this.stopping) {
        this.appendSystem(`Stigmergy run complete. Annotation table:\n${formatAnnotations(this.annotations)}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.opts.emit({ type: "error", message: msg });
    } finally {
      if (!this.stopping) this.setPhase("completed");
    }
  }

  private async runExplorerTurn(
    agent: Agent,
    round: number,
    totalRounds: number,
    candidatePaths: readonly string[],
  ): Promise<void> {
    const prompt = buildExplorerPrompt({
      agentIndex: agent.index,
      round,
      totalRounds,
      candidatePaths,
      annotations: this.annotations,
    });
    const text = await this.runAgent(agent, prompt);
    if (this.stopping || !text) return;
    const ann = parseAnnotation(text);
    if (ann) {
      this.applyAnnotation(ann);
      this.appendSystem(
        `Annotation update — ${ann.file}: interest=${ann.interest}, confidence=${ann.confidence}, total visits=${this.annotations.get(ann.file)?.visits ?? 0}`,
      );
    } else {
      this.appendSystem(
        `[${agent.id}] no parseable annotation in response — agent's text kept in transcript but the pheromone table did not update for this turn.`,
      );
    }
  }

  private applyAnnotation(ann: ParsedAnnotation): void {
    const existing = this.annotations.get(ann.file);
    if (!existing) {
      this.annotations.set(ann.file, {
        visits: 1,
        avgInterest: ann.interest,
        avgConfidence: ann.confidence,
        latestNote: ann.note,
      });
      return;
    }
    // Running average — equal weight per visit. Cheap, good enough for v1.
    const n = existing.visits + 1;
    this.annotations.set(ann.file, {
      visits: n,
      avgInterest: (existing.avgInterest * existing.visits + ann.interest) / n,
      avgConfidence: (existing.avgConfidence * existing.visits + ann.confidence) / n,
      latestNote: ann.note,
    });
  }

  private async runAgent(agent: Agent, prompt: string): Promise<string> {
    this.opts.manager.markStatus(agent.id, "thinking");
    this.emitAgentState({
      id: agent.id,
      index: agent.index,
      port: agent.port,
      sessionId: agent.sessionId,
      status: "thinking",
    });

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
        describeError: describeSdkError,
        onRetry: ({ attempt, max, reasonShort, delayMs }) => {
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

const SKIP_ENTRIES = new Set([".git/", ".git", "node_modules/", "node_modules", ".DS_Store"]);

export interface AnnotationState {
  visits: number;
  avgInterest: number;
  avgConfidence: number;
  latestNote: string;
}

export interface ParsedAnnotation {
  file: string;
  interest: number;
  confidence: number;
  note: string;
}

// Exported for testability. Accepts JSON {file, interest, confidence, note}
// either as a raw object, fenced in markdown, or embedded in prose. Returns
// null if no usable annotation can be extracted; the caller treats this as
// "no pheromone update this turn" and just keeps the agent's text in the
// transcript. Lenient on integer-vs-float; clamps interest/confidence to
// [0, 10] so a confused model can't poison the table with extremes.
export function parseAnnotation(raw: string): ParsedAnnotation | null {
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const candidates = [fenceMatch ? fenceMatch[1] : null, raw].filter(Boolean) as string[];

  for (const candidate of candidates) {
    const ann = tryParseObject(candidate);
    if (ann) return ann;
  }
  return null;
}

function tryParseObject(input: string): ParsedAnnotation | null {
  // Try direct JSON first
  try {
    const parsed = JSON.parse(input);
    const ann = coerceAnnotation(parsed);
    if (ann) return ann;
  } catch {
    // fall through to brace-finding
  }
  // Try the first {...} block
  const braceMatch = input.match(/\{[\s\S]*?\}/);
  if (!braceMatch) return null;
  try {
    const parsed = JSON.parse(braceMatch[0]);
    return coerceAnnotation(parsed);
  } catch {
    return null;
  }
}

function coerceAnnotation(parsed: unknown): ParsedAnnotation | null {
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  const file = typeof o.file === "string" ? o.file.trim() : null;
  const interestRaw = typeof o.interest === "number" ? o.interest : null;
  const confidenceRaw = typeof o.confidence === "number" ? o.confidence : null;
  const note = typeof o.note === "string" ? o.note.trim() : "";
  if (!file || interestRaw === null || confidenceRaw === null) return null;
  // Clamp [0, 10] so a model that emits 100 or -5 can't poison the table.
  const interest = Math.max(0, Math.min(10, interestRaw));
  const confidence = Math.max(0, Math.min(10, confidenceRaw));
  return { file, interest, confidence, note };
}

interface BuildExplorerPromptArgs {
  agentIndex: number;
  round: number;
  totalRounds: number;
  candidatePaths: readonly string[];
  annotations: ReadonlyMap<string, AnnotationState>;
}

export function buildExplorerPrompt(args: BuildExplorerPromptArgs): string {
  const { agentIndex, round, totalRounds, candidatePaths, annotations } = args;
  const tableText = formatAnnotations(annotations);
  const candidateText = candidatePaths.length > 0 ? candidatePaths.join(", ") : "(none — repo seems empty)";

  return [
    `You are Agent ${agentIndex}, an explorer in a stigmergy swarm reviewing a cloned GitHub project.`,
    `This is round ${round}/${totalRounds}. There is no planner and no role assignment — every agent picks its own next file based on the shared annotation table below.`,
    "",
    "Your turn:",
    "1. Look at the annotation table. Untouched files are most attractive. Among visited files, prefer high INTEREST + low CONFIDENCE — those are interesting and not yet understood. Avoid files that are well-covered (multiple visits, high confidence).",
    "2. Pick ONE file or directory entry to inspect. Read it (or sample it if it's large) using the file-read tool. Be concrete about what you read.",
    "3. Output BOTH a short prose report (under 200 words) AND a final JSON annotation block on the last line.",
    "",
    "Annotation JSON shape (last line of your response, no markdown fences):",
    '{"file": "src/foo.ts", "interest": 0-10, "confidence": 0-10, "note": "one-line summary"}',
    "",
    "Where:",
    "- `interest` = how much further investigation this file warrants (10 = very interesting / load-bearing / surprising; 0 = boring / trivial).",
    "- `confidence` = how well YOU understand it after this read (10 = fully understood; 0 = barely scratched the surface).",
    "- `note` = one-line summary that future agents can use as a pheromone signal.",
    "",
    `Top-level candidates: ${candidateText}`,
    "",
    "=== ANNOTATION TABLE (current) ===",
    tableText,
    "=== END TABLE ===",
    "",
    `Now respond as Agent ${agentIndex}. Remember: prose report THEN annotation JSON on the last line.`,
  ].join("\n");
}

export function formatAnnotations(annotations: ReadonlyMap<string, AnnotationState>): string {
  if (annotations.size === 0) return "(empty — no files annotated yet; everything is untouched)";
  const rows: string[] = [];
  // Sort: most-visited first, then by file name for stability
  const entries = [...annotations.entries()].sort((a, b) => {
    if (b[1].visits !== a[1].visits) return b[1].visits - a[1].visits;
    return a[0].localeCompare(b[0]);
  });
  for (const [file, s] of entries) {
    rows.push(
      `${file} — visits=${s.visits} interest=${s.avgInterest.toFixed(1)} confidence=${s.avgConfidence.toFixed(1)} note="${s.latestNote}"`,
    );
  }
  return rows.join("\n");
}

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
