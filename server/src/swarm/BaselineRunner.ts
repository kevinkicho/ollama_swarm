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
} from "../types.js";
import type { RunConfig, RunnerOpts, SwarmRunner } from "./SwarmRunner.js";
import { extractText } from "./extractText.js";
import { applyHunks, type Hunk } from "./blackboard/applyHunks.js";
import { parseWorkerResponse } from "./blackboard/prompts/worker.js";
import { realFilesystemAdapter, realGitAdapter } from "./blackboard/v2Adapters.js";
import { toOpenCodeModelRef } from "../../../shared/src/providers.js";
import { pickProvider } from "../providers/pickProvider.js";
import { config } from "../config.js";
import { tokenTracker } from "../services/ollamaProxy.js";

export class BaselineRunner implements SwarmRunner {
  private transcript: TranscriptEntry[] = [];
  private phase: SwarmPhase = "idle";
  private stopping = false;
  private active?: RunConfig;
  private startedAt?: number;

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

  injectUser(text: string): void {
    const entry: TranscriptEntry = { id: randomUUID(), role: "user", text, ts: Date.now() };
    this.transcript.push(entry);
    this.opts.emit({ type: "transcript_append", entry });
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
    await this.opts.repos.writeOpencodeConfig(destPath, cfg.model);
    this.appendSystem(`Cloned ${cfg.repoUrl} → ${destPath}`);
    if (this.stopping) return;

    this.setPhase("spawning");
    // E3 Phase 3 (slice): when USE_SESSION_NO_OPENCODE=1, skip the
    // opencode subprocess entirely. The agent is a stub that holds
    // sessionId + model only; prompt routing falls back to the Phase 2
    // pickProvider path (forced below by skipping the streamPrompt
    // branch when agent.client is the throwing stub).
    const agent = config.USE_SESSION_NO_OPENCODE
      ? await this.opts.manager.spawnAgentNoOpencode({ cwd: destPath, index: 1, model: cfg.model })
      : await this.opts.manager.spawnAgent({ cwd: destPath, index: 1, model: cfg.model });
    if (this.stopping) return;
    this.appendSystem(
      config.USE_SESSION_NO_OPENCODE
        ? `Baseline agent ready (no-opencode mode, session=${agent.sessionId.slice(0, 8)})`
        : `Baseline agent ready on port ${agent.port}`,
    );
    // Warmup is opencode-specific (a trivial first prompt to wake the
    // subprocess); skip in no-opencode mode where there's no subprocess.
    if (!config.USE_SESSION_NO_OPENCODE) {
      await this.opts.manager.warmupAgent(agent);
    }

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
    const prompt = buildBaselinePrompt({ directive, repoFiles, readme });

    this.appendSystem("Baseline prompt sent.");
    let raw: string;
    const abortController = new AbortController();
    try {
      // E3 Phase 2: when USE_SESSION_PROVIDER=1 OR the model is a paid
      // provider (anthropic/* or openai/* prefix), route through the
      // SessionProvider abstraction instead of opencode's streamPrompt.
      // Paid providers REQUIRE this path because opencode would need
      // its own AI-SDK config wired (which exists, but the direct path
      // is cleaner — fewer hops, direct token capture, no MCP overhead).
      const { provider, modelId } = pickProvider(cfg.model);
      // Force the provider path when there's no opencode subprocess
      // available (otherwise streamPrompt would hit the stubbed client
      // and throw with the diagnostic message).
      const useProvider =
        config.USE_SESSION_PROVIDER ||
        config.USE_SESSION_NO_OPENCODE ||
        provider.id !== "ollama";
      if (useProvider) {
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
            path: `/sdk-direct (${provider.id})`,
          });
        }
        if (result.finishReason === "error") {
          throw new Error(result.errorMessage ?? "session provider chat error");
        }
        if (result.finishReason === "aborted") {
          throw new Error("aborted");
        }
        raw = result.text;
      } else {
        raw = await this.opts.manager.streamPrompt(agent, {
          agentName: "swarm",
          modelID: cfg.model,
          promptText: prompt,
          signal: abortController.signal,
          // 90s per-chunk liveness — same default as promptWithRetry.
          perChunkTimeoutMs: 90_000,
          formatExpect: "json",
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.appendSystem(`Baseline prompt failed: ${msg}`);
      this.setPhase("failed");
      return;
    }
    if (this.stopping) return;

    const text = extractText(raw) ?? raw;
    // Hunks may target ANY file in the repo — baseline doesn't gate by
    // expectedFiles like the blackboard worker does. We pass the
    // repo-wide file list as the allow set so the parser still
    // catches obvious nonsense (e.g. /etc/passwd) but doesn't reject
    // real edits to legitimate paths.
    const expectedFiles = await collectAllFiles(destPath);
    const parsed = parseWorkerResponse(text, expectedFiles);
    if (!parsed.ok) {
      this.appendSystem(`Baseline parse failed: ${parsed.reason}`);
      this.setPhase("failed");
      return;
    }
    if (parsed.hunks.length === 0) {
      this.appendSystem(`Baseline returned no hunks${parsed.skip ? `: ${parsed.skip}` : ""}`);
      this.setPhase("completed");
      return;
    }

    const fsAdapter = realFilesystemAdapter(destPath);
    const gitAdapter = realGitAdapter(destPath);
    try {
      const result = await applyBaselineHunks({
        hunks: parsed.hunks,
        fs: fsAdapter,
      });
      if (result.applied === 0) {
        this.appendSystem(
          `Baseline produced ${parsed.hunks.length} hunk(s) but 0 applied: ${result.reasons.join("; ")}`,
        );
        this.setPhase("completed");
        return;
      }
      await gitAdapter.commitAll(`baseline: ${directive.slice(0, 60)}`, "baseline-agent");
      this.appendSystem(
        `Baseline applied ${result.applied}/${parsed.hunks.length} hunk(s) and committed.`,
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

  private appendSystem(text: string, summary?: SwarmEvent extends { summary: infer S } ? S : never): void {
    const entry: TranscriptEntry = { id: randomUUID(), role: "system", text, ts: Date.now() };
    if (summary) (entry as TranscriptEntry & { summary: unknown }).summary = summary;
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
  parts.push("");
  parts.push("Output your JSON now.");
  return parts.join("\n");
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
async function collectAllFiles(clonePath: string): Promise<string[]> {
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
// touchModel: silence unused-import warning when toOpenCodeModelRef is referenced
// only conditionally elsewhere; baseline keeps the helper available for future
// per-call provider routing.
void toOpenCodeModelRef;
