// Phase 5 of #314: BaselineRunner — the "thinnest honest baseline" the
// scoreboard compares every multi-agent preset against. One agent, one
// prompt, one apply step, one commit. NO planning loop, NO replanning,
// NO audit, NO second agent. The whole point is that a preset which
// can't beat this isn't earning its complexity.
//
// Why not "round-robin with agentCount=1"? Round-robin with 1 agent
// still pays for the per-round transcript broadcast, the per-round
// SSE flush, the role-prefix decoration, etc. The baseline should be
// what an evaluator would write themselves: a single LLM call with
// the task + repo file list, parse output as hunks, write to disk,
// commit. That's it.
//
// Used primarily by the scoreboard sweep (eval/run-eval.mjs) so a
// "blackboard 8/10 vs baseline 3/10" claim is grounded in the
// minimum honest comparison. Selectable from the SetupForm only when
// debug mode is on; the form's normal preset list omits it because
// outside the eval harness it's strictly worse than blackboard for
// real work.

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Agent } from "../services/AgentManager.js";
import type {
  SwarmEvent,
  SwarmPhase,
  SwarmStatus,
  TranscriptEntry,
  TranscriptEntrySummary,
} from "../types.js";
import type { RunConfig, RunnerOpts, SwarmRunner } from "./SwarmRunner.js";
import { extractText } from "./extractText.js";
import { formatChatReceipt } from "./chatReceipt.js";
import { applyHunks, type Hunk } from "./blackboard/applyHunks.js";
import { parseWorkerResponse } from "./blackboard/prompts/worker.js";
import { realFilesystemAdapter, realGitAdapter } from "./blackboard/v2Adapters.js";
import simpleGit from "simple-git";
// T192: import the self-critique helpers shipped in T179.
// Note: forward-references (the helpers are defined below the class
// in the same file) — TypeScript hoists exports so this works.
import { pickProvider } from "../providers/pickProvider.js";
import { tokenTracker } from "../services/ollamaProxy.js";

export interface BaselineResult {
  /** How many hunks the worker proposed in the WINNING attempt. */
  hunksAttempted: number;
  /** How many hunks actually landed on disk + got committed. */
  hunksApplied: number;
  /** SHA of the commit that landed; null when nothing committed. */
  commitSha: string | null;
  /** Verify gate result: true=passed, false=failed, null=not configured. */
  verifyPassed: boolean | null;
}

export class BaselineRunner implements SwarmRunner {
  private transcript: TranscriptEntry[] = [];
  private phase: SwarmPhase = "idle";
  private stopping = false;
  private active?: RunConfig;
  private startedAt?: number;
  // T-Item-1 (2026-05-04): track per-attempt outcome so a parent
  // harness (BaselineSwarmHarness) can score this runner without
  // scraping the transcript.
  private result: BaselineResult = {
    hunksAttempted: 0,
    hunksApplied: 0,
    commitSha: null,
    verifyPassed: null,
  };

  constructor(private readonly opts: RunnerOpts) {}

  // T-Item-1 (2026-05-04): expose the runner's per-attempt outcome.
  // Caller is the harness composing K BaselineRunner instances.
  getResult(): BaselineResult {
    return { ...this.result };
  }

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

  async stop(): Promise<void> {
    this.stopping = true;
    await this.opts.manager.killAll();
    this.setPhase("stopped");
  }

  async start(cfg: RunConfig): Promise<void> {
    if (this.isRunning()) throw new Error("A swarm is already running. Stop it first.");
    this.transcript = [];
    this.stopping = false;
    this.active = cfg;
    this.startedAt = undefined;

    void this.loop(cfg).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.appendSystem(`Baseline crashed: ${msg}`);
      this.setPhase("failed");
    });
  }

  private async loop(cfg: RunConfig): Promise<void> {
    this.setPhase("cloning");
    const cloneResult = await this.opts.repos.clone({ url: cfg.repoUrl, destPath: cfg.localPath });
    const { destPath } = cloneResult;
    this.opts.emit({
      type: "clone_state",
      alreadyPresent: cloneResult.alreadyPresent,
      clonePath: destPath,
      priorCommits: cloneResult.priorCommits,
      priorChangedFiles: cloneResult.priorChangedFiles,
      priorUntrackedFiles: cloneResult.priorUntrackedFiles,
    });
    await this.opts.repos.excludeRunnerArtifacts(destPath);
    // E3 Phase 5: opencode.json no longer needed.
    this.appendSystem(`Cloned ${cfg.repoUrl} → ${destPath}`);
    if (this.stopping) return;

    this.setPhase("spawning");
    // E3 Phase 5: opencode subprocess is gone. Agent is a lightweight
    // Session stub; no port, no warmup, no SSE event stream.
    const agent = await this.opts.manager.spawnAgentNoOpencode({
      cwd: destPath,
      index: 1,
      model: cfg.model,
    });
    if (this.stopping) return;
    this.appendSystem(`Baseline agent ready (session=${agent.sessionId.slice(0, 8)})`);

    // No "running" phase exists in SwarmPhase. The discussion runners
    // use "discussing" for the active loop; the blackboard runner uses
    // "executing". Baseline is closer to executing (single apply step).
    this.setPhase("executing");
    this.startedAt = Date.now();

    const directive = (cfg.userDirective ?? "").trim();
    if (!directive) {
      this.appendSystem("No userDirective supplied; baseline has nothing to do.");
      this.setPhase("completed");
      return;
    }

    const repoFiles = await this.opts.repos.listRepoFiles(destPath, { maxFiles: 50 });
    const readme = await this.opts.repos.readReadme(destPath);
    const recentCommits = await this.collectRecentCommits(destPath);
    const prompt = buildBaselinePrompt({ directive, repoFiles, readme, recentCommits });

    // T199 (2026-05-04): real K-attempt baseline. Run K attempts
    // SEQUENTIALLY (each is a fresh prompt + parse + critique pass);
    // score each by parsed.hunks.length × critique-passed flag; apply
    // ONLY the winner. Cost = K × (prompt + critique tokens) + 1 apply.
    // Parallel-clone-to-K-subdirs would be true parallel but needs
    // disk + lifecycle isolation that's days more substrate; this
    // sequential version captures the "vote on top" spirit at lower
    // engineering cost.
    const attempts = Math.max(1, Math.min(5, cfg.baselineAttempts ?? 1));
    if (attempts > 1) {
      this.appendSystem(
        `[T199 multi-attempt baseline] running ${attempts} attempts sequentially; will apply only the winner by score.`,
      );
    }
    const expectedFiles = await collectAllFiles(destPath);
    const candidates: Array<{
      attempt: number;
      hunks: readonly Hunk[];
      critiquePassed: boolean | null;
      score: number;
    }> = [];
    const abortController = new AbortController();
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (this.stopping) return;
      if (attempts > 1) {
        this.appendSystem(`[T199 attempt ${attempt}/${attempts}] sending baseline prompt.`);
      } else {
        this.appendSystem("Baseline prompt sent.");
      }
      let raw: string;
      try {
        const { provider, modelId } = pickProvider(cfg.model);
        const t0 = Date.now();
        const result = await provider.chat({
          model: modelId,
          messages: [{ role: "user", content: prompt }],
          signal: abortController.signal,
          agentId: agent.id,
        });
        if (result.usage) {
          tokenTracker.add({
            ts: Date.now(),
            promptTokens: result.usage.promptTokens,
            responseTokens: result.usage.responseTokens,
            durationMs: Date.now() - t0,
            model: cfg.model,
            path: `/sdk-direct (${provider.id})${attempts > 1 ? ` attempt-${attempt}` : ""}`,
          });
        }
        if (result.finishReason === "error") {
          throw new Error(result.errorMessage ?? "session provider chat error");
        }
        if (result.finishReason === "aborted") {
          throw new Error("aborted");
        }
        raw = result.text;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.appendSystem(`[T199 attempt ${attempt}/${attempts}] prompt failed: ${msg}; skipping this attempt.`);
        continue;
      }
      const text = extractText(raw) ?? raw;
      const parsed = parseWorkerResponse(text, expectedFiles);
      if (!parsed.ok) {
        this.appendSystem(`[T199 attempt ${attempt}/${attempts}] parse failed: ${parsed.reason}; skipping.`);
        continue;
      }
      if (parsed.hunks.length === 0) {
        this.appendSystem(`[T199 attempt ${attempt}/${attempts}] returned 0 hunks${parsed.skip ? `: ${parsed.skip}` : ""}; recording as zero-score candidate.`);
        candidates.push({ attempt, hunks: [], critiquePassed: null, score: 0 });
        continue;
      }
      // Optional critique pass per attempt.
      let critiquePassed: boolean | null = null;
      let finalHunksForAttempt: readonly Hunk[] = parsed.hunks;
      if (cfg.baselineSelfCritique) {
        const critiqueRes = await this.runSelfCritique({
          agent,
          directive,
          parsedHunks: parsed.hunks,
          expectedFiles,
          abortController,
          model: cfg.model,
        });
        if (critiqueRes) {
          critiquePassed = critiqueRes.verdict === "APPROVE";
          if (critiqueRes.verdict === "REVISE" && critiqueRes.hunks) {
            finalHunksForAttempt = critiqueRes.hunks;
          }
        }
      }
      // Score: hunks_count + bonus for critique-passed
      const score =
        finalHunksForAttempt.length + (critiquePassed === true ? 2 : 0);
      candidates.push({
        attempt,
        hunks: finalHunksForAttempt,
        critiquePassed,
        score,
      });
      this.appendSystem(
        `[T199 attempt ${attempt}/${attempts}] candidate scored: hunks=${finalHunksForAttempt.length}, critique=${critiquePassed === null ? "n/a" : critiquePassed ? "APPROVE" : "REVISE"}, score=${score}`,
      );
    }
    if (candidates.length === 0) {
      this.appendSystem(
        `[T199 multi-attempt baseline] all ${attempts} attempts failed; nothing to apply.`,
      );
      this.setPhase("failed");
      return;
    }
    // Pick winner: highest score; tie-break by lowest attempt number.
    candidates.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.attempt - b.attempt;
    });
    const winner = candidates[0]!;
    if (attempts > 1) {
      this.appendSystem(
        `[T199 multi-attempt baseline] winner = attempt ${winner.attempt}/${attempts} (score=${winner.score}). Applying winner's hunks.`,
      );
    }
    const finalHunks: readonly Hunk[] = winner.hunks;
    if (finalHunks.length === 0) {
      this.appendSystem(`Baseline winner returned 0 hunks — nothing to commit.`);
      this.setPhase("completed");
      return;
    }

    const fsAdapter = realFilesystemAdapter(destPath);
    const gitAdapter = realGitAdapter(destPath);
    // T-Item-1 (2026-05-04): track per-attempt result for the harness
    // composing K runners. winner.critiquePassed is populated above
    // when cfg.baselineSelfCritique is on; surface it here.
    this.result.hunksAttempted = finalHunks.length;
    this.result.verifyPassed = winner.critiquePassed;
    try {
      const result = await applyBaselineHunks({
        hunks: finalHunks,
        fs: fsAdapter,
      });
      if (result.applied === 0) {
        this.appendSystem(
          `Baseline produced ${finalHunks.length} hunk(s) but 0 applied: ${result.reasons.join("; ")}`,
        );
        this.setPhase("completed");
        return;
      }
      const commitResult = await gitAdapter.commitAll(
        `baseline: ${directive.slice(0, 60)}`,
        "baseline-agent",
      );
      // T-Item-1: capture commit SHA for harness scoring.
      this.result.hunksApplied = result.applied;
      if (commitResult.ok) {
        this.result.commitSha = commitResult.sha;
      }
      this.appendSystem(
        `Baseline applied ${result.applied}/${finalHunks.length} hunk(s) and committed.`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.appendSystem(`Baseline apply/commit failed: ${msg}`);
      this.setPhase("failed");
      return;
    }
    this.setPhase("completed");
  }

  private setPhase(p: SwarmPhase): void {
    this.phase = p;
    this.opts.emit({ type: "swarm_state", phase: p, round: 0 });
  }

  // T199 (2026-05-04): extracted self-critique helper. Used per-attempt
  // in the K-attempt loop. Returns null on any failure (caller treats
  // as "no critique signal"). When verdict.verdict === "REVISE",
  // verdict.hunks is the corrected set the caller should use instead
  // of the original.
  private async runSelfCritique(input: {
    agent: import("../services/AgentManager.js").Agent;
    directive: string;
    parsedHunks: readonly Hunk[];
    expectedFiles: readonly string[];
    abortController: AbortController;
    model: string;
  }): Promise<{ verdict: "APPROVE" | "REVISE"; reason: string; hunks?: readonly Hunk[] } | null> {
    try {
      const critiquePrompt = buildBaselineSelfCritiquePrompt({
        directive: input.directive,
        proposedHunksJson: JSON.stringify({ hunks: input.parsedHunks }, null, 2),
      });
      const { provider, modelId } = pickProvider(input.model);
      const t0 = Date.now();
      const cresult = await provider.chat({
        model: modelId,
        messages: [{ role: "user", content: critiquePrompt }],
        signal: input.abortController.signal,
        agentId: input.agent.id,
      });
      if (cresult.usage) {
        tokenTracker.add({
          ts: Date.now(),
          promptTokens: cresult.usage.promptTokens,
          responseTokens: cresult.usage.responseTokens,
          durationMs: Date.now() - t0,
          model: input.model,
          path: `/baseline-self-critique (${provider.id})`,
        });
      }
      if (cresult.finishReason === "error" || cresult.finishReason === "aborted") {
        return null;
      }
      const ctext = extractText(cresult.text) ?? cresult.text;
      return parseBaselineSelfCritique(ctext, input.expectedFiles);
    } catch {
      return null;
    }
  }

  // T192 (2026-05-04): collect top-N short-form commits for the
  // baseline prompt's recentCommits field. Best-effort — empty
  // result on parse failure / empty repo / git error. Each entry
  // is "<short-sha> <subject>".
  private async collectRecentCommits(
    clonePath: string,
    n: number = 10,
  ): Promise<string[]> {
    try {
      const git = simpleGit(clonePath);
      const log = await git.log({ maxCount: n });
      return log.all.map((c) => `${c.hash.slice(0, 7)} ${c.message}`);
    } catch {
      return [];
    }
  }

  private appendSystem(text: string, summary?: TranscriptEntrySummary): void {
    const entry: TranscriptEntry = { id: randomUUID(), role: "system", text, ts: Date.now(), summary };
    this.transcript.push(entry);
    this.opts.emit({ type: "transcript_append", entry });
  }
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for tests.
// ---------------------------------------------------------------------------

export interface BaselinePromptInput {
  directive: string;
  repoFiles: readonly string[];
  readme: string | null;
  /** T179 (2026-05-04): optional recent commit log for context.
   *  Helps the baseline avoid duplicating recent work or breaking
   *  patterns just landed. Each entry: short SHA + subject. */
  recentCommits?: readonly string[];
}

export function buildBaselinePrompt(input: BaselinePromptInput): string {
  const parts: string[] = [];
  parts.push(
    "You are a single coding agent working on a repository. Read the directive, inspect the file list, and produce a JSON object describing the file changes that satisfy the directive. Output ONLY the JSON — no prose, no markdown fences.",
  );
  parts.push("");
  parts.push("Output schema:");
  parts.push('  {"hunks": [ ...search/replace hunks ]}');
  parts.push(
    'Each hunk: {"op": "replace"|"create"|"append", "file": "<path>", "search": "...", "replace": "..."} or {"op":"create"|"append", "file": "...", "content": "..."}.',
  );
  parts.push("If nothing to change: {\"hunks\": []}.");
  parts.push("Maximum 8 hunks.");
  parts.push("");
  parts.push(`DIRECTIVE: ${input.directive}`);
  parts.push("");
  parts.push("Repo files (top 50):");
  for (const f of input.repoFiles) parts.push(`  ${f}`);
  if (input.readme) {
    parts.push("");
    parts.push("README (truncated to 2000 chars):");
    parts.push(input.readme.slice(0, 2000));
  }
  // T179 (2026-05-04): recent commit context — lets the baseline see
  // what the project just did. Reduces "the baseline duplicates work
  // already in the last 3 commits" failure mode + helps follow style.
  if (input.recentCommits && input.recentCommits.length > 0) {
    parts.push("");
    parts.push("Recent commits (newest first — consider patterns + avoid duplicating):");
    for (const c of input.recentCommits.slice(0, 10)) parts.push(`  - ${c}`);
  }
  parts.push("");
  parts.push("Output your JSON now.");
  return parts.join("\n");
}

// T179 (2026-05-04): self-critique pass. After the baseline produces
// hunks, fire a second prompt that shows the model its OWN hunks +
// asks it to critique them. The output is structured: APPROVE means
// proceed, REVISE means re-emit corrected hunks. Used by BaselineRunner
// when cfg.baselineSelfCritique is true (default OFF — opt-in).
export interface SelfCritiqueInput {
  directive: string;
  proposedHunksJson: string;
}

export function buildBaselineSelfCritiquePrompt(input: SelfCritiqueInput): string {
  return [
    "You are critiquing your OWN previous proposed changes for the directive below. Be honest — find what you would have flagged if a peer wrote this.",
    "",
    "Things to check:",
    "  - Does each hunk's `search` text actually exist in the file (not invented)?",
    "  - Does the resulting file compile / parse / look syntactically correct?",
    "  - Did you miss obvious side-effects (e.g. caller updates needed when changing a signature)?",
    "  - Does the change actually satisfy the directive, or just touch related files?",
    "  - Are any hunks no-ops (search == replace) or duplicates?",
    "",
    `DIRECTIVE: ${input.directive}`,
    "",
    "Your previously proposed hunks (the JSON you emitted last turn):",
    input.proposedHunksJson,
    "",
    "Output ONLY one of:",
    '  {"verdict": "APPROVE", "reason": "<one line — why these hunks are good as-is>"}',
    '  {"verdict": "REVISE", "reason": "<one line — what\'s wrong>", "hunks": [ ...corrected hunks following the same schema as before ]}',
    "",
    "On REVISE, the corrected hunks fully replace the prior proposal — emit the FINAL set, not a diff against the prior.",
    "JSON only, no prose, no markdown fences.",
  ].join("\n");
}

export interface ParsedSelfCritique {
  verdict: "APPROVE" | "REVISE";
  reason: string;
  hunks?: readonly Hunk[];
}

export function parseBaselineSelfCritique(raw: string, expectedFiles: readonly string[]): ParsedSelfCritique | null {
  // Lift the JSON out of optional markdown fence + tolerate trailing prose.
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const candidate = fenceMatch ? fenceMatch[1] : raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    const braceMatch = candidate.match(/\{[\s\S]*\}/);
    if (!braceMatch) return null;
    try {
      parsed = JSON.parse(braceMatch[0]);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  const verdictRaw = typeof o.verdict === "string" ? o.verdict.toUpperCase() : "";
  const reason = typeof o.reason === "string" ? o.reason.trim() : "";
  if (verdictRaw !== "APPROVE" && verdictRaw !== "REVISE") return null;
  if (verdictRaw === "APPROVE") {
    return { verdict: "APPROVE", reason };
  }
  // REVISE — extract corrected hunks via the same parseWorkerResponse
  // shape. Build a synthetic JSON envelope around the hunks so the
  // shared parser does the heavy lifting.
  const hunksRaw = o.hunks;
  if (!Array.isArray(hunksRaw)) return null;
  const synth = JSON.stringify({ hunks: hunksRaw });
  // parseWorkerResponse takes a mutable string[] for legacy reasons —
  // copy our readonly to satisfy the type.
  const reparsed = parseWorkerResponse(synth, [...expectedFiles]);
  if (!reparsed.ok) return null;
  return {
    verdict: "REVISE",
    reason,
    hunks: reparsed.hunks,
  };
}

interface ApplyOutcome {
  applied: number;
  reasons: string[];
}

export async function applyBaselineHunks(input: {
  hunks: readonly Hunk[];
  fs: { read: (file: string) => Promise<string | null>; write: (file: string, content: string) => Promise<void> };
}): Promise<ApplyOutcome> {
  let applied = 0;
  const reasons: string[] = [];
  // applyHunks operates on (currentTextsByFile, hunks) and returns
  // newTextsByFile — pre-fetch each file's current contents into a
  // single map, then call once. On any per-file error the whole batch
  // returns ok:false; we then fall back to per-file calls so a single
  // bad hunk doesn't block the others' wins.
  const byFile = new Map<string, Hunk[]>();
  for (const h of input.hunks) {
    const list = byFile.get(h.file) ?? [];
    list.push(h);
    byFile.set(h.file, list);
  }
  const currentTextsByFile: Record<string, string | null> = {};
  for (const file of byFile.keys()) {
    currentTextsByFile[file] = await input.fs.read(file);
  }
  const all = applyHunks(currentTextsByFile, [...input.hunks]);
  if (all.ok) {
    for (const [file, content] of Object.entries(all.newTextsByFile)) {
      await input.fs.write(file, content);
      applied += byFile.get(file)?.length ?? 0;
    }
    return { applied, reasons };
  }
  // Fall back: try each file independently so partial wins land.
  for (const [file, hunks] of byFile) {
    const single = applyHunks({ [file]: currentTextsByFile[file] }, hunks);
    if (!single.ok) {
      reasons.push(`${file}: ${single.error}`);
      continue;
    }
    const next = single.newTextsByFile[file];
    if (next === undefined) continue;
    await input.fs.write(file, next);
    applied += hunks.length;
  }
  return { applied, reasons };
}

// Lists every non-binary, non-ignored file in the clone, used as the
// allow-set for parseWorkerResponse so a hallucinated /etc/passwd
// doesn't sneak through. Mirrors RepoService.listRepoFiles but
// without the maxFiles cap (the baseline can target any repo file).
//
// T2.1 (2026-05-04): exported so wrapUpApplyPhase.ts can reuse it
// without duplicating the BFS logic.
export async function collectAllFiles(clonePath: string): Promise<string[]> {
  const out: string[] = [];
  const queue: string[] = [""];
  while (queue.length > 0 && out.length < 5000) {
    const rel = queue.shift()!;
    const abs = rel === "" ? clonePath : path.join(clonePath, rel);
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".git")) continue;
      if (entry.name === "node_modules") continue;
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        queue.push(childRel);
      } else if (entry.isFile()) {
        out.push(childRel);
      }
    }
  }
  return out;
}
