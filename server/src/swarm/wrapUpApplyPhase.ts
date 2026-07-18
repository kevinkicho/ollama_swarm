// T2.1 + T2.2 (2026-05-04): shared "wrap-up apply phase" for any
// discussion preset that opts in via cfg.executeNextAction.
//
// PROBLEM: pre-T2, only blackboard could turn agent decisions into file
// modifications. Discussion presets (council, MoA, map-reduce, OW,
// OW-Deep, round-robin, role-diff) produced rich synthesis prose +
// next-actions JSON, but no actual diffs landed on the clone.
//
// SOLUTION: a single reusable helper that takes (a) the synthesized
// next-action text, (b) one existing agent reference, (c) the clone
// path, then runs ONE worker prompt + parses hunks + applies +
// commits. Reuses BaselineRunner's primitives (buildBaselinePrompt +
// applyBaselineHunks + collectAllFiles + parseWorkerResponse) so we
// share the apply path with the canonical baseline rather than
// reimplementing it.
//
// SCOPE: deliberately single-shot. NO replan loop, NO audit, NO CAS
// against file hashes. The discussion preset already did the
// reasoning; this helper just turns the top recommendation into one
// best-effort commit. Failures (parse error, 0 hunks land, conflict)
// surface as a system bubble + a structured WrapUpApplyResult; the
// run itself stays in its terminal phase.
//
// PRESET CHARACTER PRESERVED: cfg.executeNextAction defaults to OFF.
// Opt-in only — runners that don't pass it through to this helper
// behave exactly as before. When ON, the helper fires AFTER the
// deliverable lands, so the deliverable + next-actions JSON + memory
// contributions still happen even if the apply phase fails.

import { promises as fs } from "node:fs";
import path from "node:path";
import type { Agent, AgentManager } from "../services/AgentManager.js";
import type { SwarmEvent } from "../types.js";
import type { RepoService } from "../services/RepoService.js";
import { applyHunks, type Hunk, type ApplyMissReport } from "./blackboard/applyHunks.js";
import { extractText } from "./extractText.js";
import { parseWorkerResponse } from "./blackboard/prompts/worker.js";
import { withCloneApplyLock } from "./cloneApplyMutex.js";
import {
  realFilesystemAdapter,
  realGitAdapter,
  realVerifyAdapter,
} from "./blackboard/v2Adapters.js";
import {
  buildBaselinePrompt,
  collectAllFiles,
} from "./BaselineRunner.js";
import { pickProvider } from "../providers/pickProvider.js";
import {
  noteApplyAttempt,
  noteApplyMiss,
  noteApplySuccess,
} from "./applyIntegrityStats.js";

/** Pure dry-run: would these hunks apply? Does not write disk. */
async function dryRunHunks(
  clonePath: string,
  hunks: Hunk[],
): Promise<{
  wouldApply: number;
  reasons: string[];
  misses: ApplyMissReport[];
  /** Hunks for files that dry-ran clean (RR-A fail-closed subset). */
  cleanHunks: Hunk[];
  /** Hunks for files that failed dry-run. */
  dirtyHunks: Hunk[];
}> {
  const fsAdapter = realFilesystemAdapter(clonePath);
  const byFile = new Map<string, Hunk[]>();
  for (const h of hunks) {
    const list = byFile.get(h.file) ?? [];
    list.push(h);
    byFile.set(h.file, list);
  }
  let wouldApply = 0;
  const reasons: string[] = [];
  const misses: ApplyMissReport[] = [];
  const cleanHunks: Hunk[] = [];
  const dirtyHunks: Hunk[] = [];
  for (const [file, fileHunks] of byFile) {
    let current: string | null = null;
    try {
      current = await fsAdapter.read(file);
    } catch {
      current = null;
    }
    const r = applyHunks({ [file]: current }, fileHunks);
    if (r.ok) {
      wouldApply += fileHunks.length;
      cleanHunks.push(...fileHunks);
    } else {
      reasons.push(`${file}: ${r.error}`);
      if (r.miss) misses.push(r.miss);
      dirtyHunks.push(...fileHunks);
    }
  }
  return { wouldApply, reasons, misses, cleanHunks, dirtyHunks };
}

/** Build re-prompt context from synthesizer total-miss (reasons + ApplyMissReport). */
export function buildSynthesizerMissRepromptBlock(
  reasons: string[],
  misses: ApplyMissReport[],
): string {
  const lines: string[] = [
    "",
    "PRIOR ATTEMPT FAILED (search/start anchors not found or not unique). Reasons:",
    ...reasons.slice(0, 8).map((r) => `- ${r}`),
  ];
  for (let i = 0; i < Math.min(misses.length, 4); i++) {
    const m = misses[i]!;
    lines.push(
      "",
      `Apply miss [${i + 1}]: kind=${m.kind} file=${m.file} op=${m.op} matchCount=${m.matchCount}`,
      `  needle: ${JSON.stringify(m.needle).slice(0, 200)}`,
    );
    if (m.nearbyExcerpt?.trim()) {
      lines.push(
        "  nearbyExcerpt:",
        "  ---",
        m.nearbyExcerpt
          .split("\n")
          .slice(0, 40)
          .map((l) => `  ${l}`)
          .join("\n"),
        "  ---",
      );
    }
    if (m.uniqueCandidates.length > 0) {
      lines.push(
        "  uniqueCandidates (exact paste for search/start if they fit the edit):",
      );
      for (let c = 0; c < m.uniqueCandidates.length; c++) {
        lines.push(
          `  --- CANDIDATE ${c + 1} ---`,
          m.uniqueCandidates[c]!,
          `  --- END CANDIDATE ${c + 1} ---`,
        );
      }
    }
  }
  lines.push(
    "",
    "Re-read the listed files and emit replace/replace_between hunks whose search/start text exists EXACTLY once in the current file contents. Prefer uniqueCandidates when listed. Do not invent anchors.",
    "",
  );
  return lines.join("\n");
}


export interface WrapUpApplyInput {
  /** Synthesized "next action" — usually the top action text from
   *  next-actions.json, or the directive answer when actions=0. This
   *  becomes the directive for the apply phase's worker prompt. */
  directive: string;
  /** Clone path on disk. */
  clonePath: string;
  /** Model id to call provider with. Usually cfg.workerModel ?? cfg.model. */
  model: string;
  /** Agent reference for token tracking + status updates. Caller picks
   *  one of its already-spawned agents (typically the lead). */
  agent: Agent;
  /** Repo helper for file listing + readme. */
  repos: RepoService;
  /** Manager for agent status updates. */
  manager: AgentManager;
  /** Emit callback for transcript entries (so the wrap-up bubble lands
   *  in the runner's transcript + WS stream). */
  emit: (e: SwarmEvent) => void;
  /** Helper to push a system entry. Mirrors each runner's appendSystem
   *  so the entry lands in the runner's own transcript array. */
  appendSystem: (text: string) => void;
  /** Preset name used in commit message + author attribution
   *  ("council", "moa", etc.). */
  presetName: string;
  /** Optional run id for applyIntegrity counters (wrap-up was invisible). */
  runId?: string;
  /** T171 (2026-05-04): when set, runs as a pre-commit verification
   *  gate. Same semantics as blackboard's WorkerPipeline verify gate
   *  — apply hunks, run command, on non-zero exit revert the writes
   *  and return ok:false with verifyFailed:true. Bounded to 60s. */
  verifyCommand?: string;
  /**
   * Phase 1 (writeMode: single): when the synthesizer already produced
   *   hunks (e.g. from a structured {hunks: [...]} response), pass them
   *   directly to skip the worker prompt step. The directive field is
   *   still required for commit message attribution. When absent, the
   *   helper builds and runs a worker prompt as before.
   */
  hunksFromSynthesizer?: import("./blackboard/applyHunks.js").Hunk[];
}

export interface WrapUpApplyResult {
  ok: boolean;
  /** Reason when ok===false. */
  reason?: string;
  /** How many hunks the worker proposed. */
  hunksAttempted: number;
  /** How many hunks actually landed on disk. */
  hunksApplied: number;
  /** Empty when nothing committed (e.g. 0 hunks proposed, or all
   *  hunks failed to apply, or verify gate reverted). */
  commitSha?: string;
  /** T171: true when the verify command exited non-zero and the
   *  writes were reverted. Distinguishes "hunks were bad" from
   *  "verify caught regression." */
  verifyFailed?: boolean;
}

export async function runWrapUpApplyPhase(
  input: WrapUpApplyInput,
): Promise<WrapUpApplyResult> {
  const directive = input.directive.trim();
  if (!directive) {
    input.appendSystem(
      `Wrap-up apply (T2.1+T2.2): empty directive — skipping apply phase.`,
    );
    return {
      ok: false,
      reason: "empty directive",
      hunksAttempted: 0,
      hunksApplied: 0,
    };
  }

  input.appendSystem(
    `Wrap-up apply (${input.presetName}): turning the synthesized next-action into a single best-effort commit. Directive: "${directive.slice(0, 120)}${directive.length > 120 ? "..." : ""}"`,
  );

  // Phase 1 extension: dry-run synthesizer hunks (no disk write). On total
  // miss (stale search anchors — run 9f449937: 16→0), fall through to a
  // worker re-prompt that includes the failure reasons + ApplyMissReport
  // fields (nearbyExcerpt, uniqueCandidates) so anchors re-read from disk.
  let hunksToApply: Hunk[] = [];
  let synthesizerMissReasons: string[] = [];
  let synthesizerMisses: ApplyMissReport[] = [];

  if (input.hunksFromSynthesizer && input.hunksFromSynthesizer.length > 0) {
    const synthHunks = input.hunksFromSynthesizer;
    input.appendSystem(
      `Wrap-up apply: dry-running ${synthHunks.length} synthesizer hunk(s)…`,
    );
    const dry = await dryRunHunks(input.clonePath, synthHunks);
    // RR-A fail-closed: only apply files that dry-ran clean — never land a
    // mixed set where some files fail (prior bug applied all synth hunks).
    if (dry.cleanHunks.length > 0 && dry.dirtyHunks.length === 0) {
      hunksToApply = dry.cleanHunks;
      input.appendSystem(
        `Wrap-up apply: synthesizer dry-run ok (${dry.wouldApply}/${synthHunks.length} would land) — applying.`,
      );
    } else if (dry.cleanHunks.length > 0 && dry.dirtyHunks.length > 0) {
      // Strict: any dirty → total miss fallthrough (do not land incomplete multi-file sets).
      synthesizerMissReasons = dry.reasons;
      synthesizerMisses = dry.misses;
      input.appendSystem(
        `Wrap-up apply: synthesizer partial dry-run (${dry.cleanHunks.length} clean / ${dry.dirtyHunks.length} miss) — not applying subset; fallthrough re-prompt with miss anchors. ${dry.reasons.join("; ").slice(0, 300)}.`,
      );
    } else {
      synthesizerMissReasons = dry.reasons;
      synthesizerMisses = dry.misses;
      const missKinds = dry.misses.map((m) => m.kind).join(",") || "n/a";
      input.appendSystem(
        `Wrap-up apply: synthesizer ${synthHunks.length} hunk(s) dry-run 0 would land (miss kinds: ${missKinds}) — ${dry.reasons.join("; ").slice(0, 500)}. ` +
          `Falling through to worker re-prompt with live file anchors + unique candidates.`,
      );
    }
  }

  if (hunksToApply.length === 0) {
    // Build the prompt — same shape as BaselineRunner uses, so any
    // future improvements to baseline-style prompting flow here for free.
    const repoFiles = await input.repos.listRepoFiles(input.clonePath, {
      maxFiles: 50,
    });
    const readme = await input.repos.readReadme(input.clonePath);
    const failureBlock =
      synthesizerMissReasons.length > 0
        ? buildSynthesizerMissRepromptBlock(
            synthesizerMissReasons,
            synthesizerMisses,
          )
        : "";
    const prompt =
      buildBaselinePrompt({ directive, repoFiles, readme }) + failureBlock;

    // Run the prompt
    let raw: string;
    const abortController = new AbortController();
    try {
      input.manager.markStatus(input.agent.id, "thinking");
      const { provider, modelId } = pickProvider(input.model);
      const t0 = Date.now();
      // Force JSON envelope like workers (live thrash: think-only wrap-up blobs).
      const result = await provider.chat({
        model: modelId,
        messages: [{ role: "user", content: prompt }],
        signal: abortController.signal,
        agentId: input.agent.id,
        format: "json",
      });
      const { recordChatUsage } = await import("../services/ollamaProxy.js");
      recordChatUsage({
        promptTokens: result.usage?.promptTokens,
        responseTokens: result.usage?.responseTokens,
        promptText: prompt,
        responseText: result.text,
        durationMs: Date.now() - t0,
        model: input.model,
        path: `/wrap-up-apply (${provider.id})`,
      });
      if (result.finishReason === "error") {
        throw new Error(result.errorMessage ?? "wrap-up apply: provider error");
      }
      if (result.finishReason === "aborted") {
        throw new Error("aborted");
      }
      raw = result.text;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      input.appendSystem(`Wrap-up apply: prompt failed — ${msg}`);
      return {
        ok: false,
        reason: msg,
        hunksAttempted: 0,
        hunksApplied: 0,
      };
    } finally {
      input.manager.markStatus(input.agent.id, "ready");
    }

    // Parse hunks from the response. Use the same allow-set discipline
    // BaselineRunner uses so a hallucinated /etc/passwd doesn't sneak
    // through.
    const text = extractText(raw) ?? raw;
    const expectedFiles = await collectAllFiles(input.clonePath);
    const parsed = parseWorkerResponse(text, expectedFiles);
    if (!parsed.ok) {
      input.appendSystem(`Wrap-up apply: parse failed — ${parsed.reason}`);
      return {
        ok: false,
        reason: parsed.reason,
        hunksAttempted: 0,
        hunksApplied: 0,
      };
    }
    if (parsed.hunks.length === 0) {
      const skipNote = parsed.skip ? ` — ${parsed.skip}` : "";
      // Distinguish "worker produced nothing" from "synthesizer hunks failed to land"
      // so UI doesn't look like a silent no-op after a prior "N hunks from synthesizer".
      input.appendSystem(
        `Wrap-up apply: worker returned 0 hunks (nothing to apply)${skipNote}`,
      );
      // Not a successful apply — callers must not treat this as landed work.
      return {
        ok: false,
        reason: parsed.skip
          ? `worker-zero-hunks: ${parsed.skip}`
          : "worker-zero-hunks",
        hunksAttempted: 0,
        hunksApplied: 0,
      };
    }
    hunksToApply = parsed.hunks;
  }

  // Apply + (optional verify) + commit — serialized per clone with other
  // workers (council/blackboard) so git add -A cannot interleave.
  // Disk re-read happens *inside* the lock (below) so peer commits are visible.
  return withCloneApplyLock(input.clonePath, async (lockMeta) => {
    const fsAdapter = realFilesystemAdapter(input.clonePath);
    const gitAdapter = realGitAdapter(input.clonePath);
    const touchedFiles = Array.from(new Set(hunksToApply.map((h) => h.file)));
    const preHunkContents: Record<string, string | null> = {};
    for (const f of touchedFiles) {
      try {
        preHunkContents[f] = await fsAdapter.read(f);
      } catch {
        preHunkContents[f] = null;
      }
    }
    try {
      noteApplyAttempt(input.runId);
      const pure = applyHunks(preHunkContents, hunksToApply);
      if (!pure.ok) {
        noteApplyMiss(pure.miss?.kind ?? "other", input.runId);
        const lockDiag = lockMeta.contended
          ? ` [clone-lock-contended waited=${lockMeta.waitedMs}ms — re-read under lock; peer may have landed first]`
          : "";
        input.appendSystem(
          `Wrap-up apply: ${hunksToApply.length} hunk(s) returned, 0 applied (fail-closed) — ${pure.error}` +
            (pure.miss?.kind ? ` [miss=${pure.miss.kind}]` : "") +
            lockDiag,
        );
        return {
          ok: false,
          reason: `0 of ${hunksToApply.length} hunks landed: ${pure.error}${lockDiag}`,
          hunksAttempted: hunksToApply.length,
          hunksApplied: 0,
        };
      }
      for (const [file, content] of Object.entries(pure.newTextsByFile)) {
        await fsAdapter.write(file, content);
      }
      const applied = hunksToApply.length;
      if (input.verifyCommand) {
        const verify = realVerifyAdapter(input.clonePath, input.verifyCommand);
        const v = await verify.run();
        if (!v.ok) {
          for (const f of touchedFiles) {
            const before = preHunkContents[f];
            try {
              if (before === null) {
                if (typeof fsAdapter.delete === "function") {
                  await fsAdapter.delete(f);
                } else {
                  await fsAdapter.write(f, "");
                }
              } else {
                await fsAdapter.write(f, before);
              }
            } catch {
              // best-effort
            }
          }
          input.appendSystem(
            `Wrap-up apply: ${applied} hunk(s) applied but verify gate failed — reverted. ${v.reason.slice(0, 400)}`,
          );
          return {
            ok: false,
            reason: `verify failed: ${v.reason.slice(0, 400)}`,
            hunksAttempted: hunksToApply.length,
            hunksApplied: 0,
            verifyFailed: true,
          };
        }
      }
      const commitMsg = `${input.presetName} wrap-up: ${directive.slice(0, 60)}`;
      const commitResult = await gitAdapter.commitAll(
        commitMsg,
        `${input.presetName}-wrap-up`,
      );
      if (!commitResult.ok) {
        input.appendSystem(
          `Wrap-up apply: ${applied} hunk(s) applied to disk but commit failed — ${commitResult.reason}`,
        );
        return {
          ok: false,
          reason: commitResult.reason,
          hunksAttempted: hunksToApply.length,
          hunksApplied: applied,
        };
      }
      noteApplySuccess(input.runId);
      const verifyTag = input.verifyCommand ? " (verify ✓)" : "";
      input.appendSystem(
        `Wrap-up apply: ${applied}/${hunksToApply.length} hunk(s) applied → committed${verifyTag} (${commitResult.sha.slice(0, 7)}).`,
      );
      return {
        ok: true,
        hunksAttempted: hunksToApply.length,
        hunksApplied: applied,
        commitSha: commitResult.sha,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      input.appendSystem(`Wrap-up apply: apply/commit failed — ${msg}`);
      return {
        ok: false,
        reason: msg,
        hunksAttempted: hunksToApply.length,
        hunksApplied: 0,
      };
    }
  });
}

// T2.2 orchestration helper. Each opt-in runner (council, MoA,
// map-reduce, OW, OW-Deep, round-robin, role-diff) calls this ONE
// helper after its deliverable lands. Returns null when not enabled
// or when nothing actionable was produced; otherwise returns the
// WrapUpApplyResult so the runner can log the outcome in its summary.
//
// Centralized here so adding a new preset to the executeNextAction
// roster is one call site change, not a copy-paste of orchestration
// logic into every runner.
export interface MaybeRunWrapUpApplyInput {
  cfg: {
    executeNextAction?: boolean;
    writeMode?: "none" | "single" | "multi";
    runId?: string;
    localPath: string;
    workerModel?: string;
    writeModel?: string;
    model: string;
    userDirective?: string;
    /** T171: when set, runs as a pre-commit verification gate. Same
     *  semantics as blackboard's WorkerPipeline verify gate. */
    verifyCommand?: string;
  };
  presetName: string;
  agent: import("../services/AgentManager.js").Agent;
  manager: import("../services/AgentManager.js").AgentManager;
  repos: import("../services/RepoService.js").RepoService;
  emit: (e: import("../types.js").SwarmEvent) => void;
  appendSystem: (text: string) => void;
  /** Phase 1 (writeMode: single): discussion context for synthesizer. */
  discussionContext?: string;
  /** Phase 1: relevant files identified during discussion. */
  relevantFiles?: string[];
}

export async function maybeRunWrapUpApply(
  input: MaybeRunWrapUpApplyInput,
): Promise<WrapUpApplyResult | null> {
  // Backward compatibility: executeNextAction=true maps to writeMode="single"
  // with the worker-prompt path (hunksFromSynthesizer not set).
  const writeMode = input.cfg.writeMode ?? (input.cfg.executeNextAction ? "single" : "none");
  if (writeMode === "none") return null;
  if (!input.cfg.runId) return null;

  // Read the top action from the just-written next-actions JSON.
  // Falls back to userDirective when no JSON exists or has no actions.
  let directive = await readTopNextAction({
    clonePath: input.cfg.localPath,
    runId: input.cfg.runId,
    presetName: input.presetName,
  });
  if (!directive) {
    const fallback = (input.cfg.userDirective ?? "").trim();
    if (!fallback) {
      input.appendSystem(
        `Wrap-up apply (${writeMode}): no extractable next-action and no userDirective — skipping apply phase.`,
      );
      return null;
    }
    input.appendSystem(
      `Wrap-up apply (${writeMode}): no extractable next-action found in deliverable — falling back to userDirective.`,
    );
    directive = fallback;
  }

  // Phase 1 extension: if writeMode="single" and discussionContext is
  // provided, use synthesizer-hunks path. Otherwise fall back to the
  // worker-prompt path (legacy executeNextAction behavior).
  if (writeMode === "single" && input.discussionContext) {
    const { runSynthesizerHunksAndApply } = await import("./synthesizerHunks.js");
    return runSynthesizerHunksAndApply({
      directive,
      clonePath: input.cfg.localPath,
      model: input.cfg.writeModel ?? input.cfg.workerModel ?? input.cfg.model,
      agent: input.agent,
      manager: input.manager,
      repos: input.repos,
      emit: input.emit,
      appendSystem: input.appendSystem,
      presetName: input.presetName,
      verifyCommand: input.cfg.verifyCommand,
      discussionContext: input.discussionContext,
      relevantFiles: input.relevantFiles,
      runId: input.cfg.runId,
    });
  }

  // Legacy path: worker prompt + parse + apply
  return runWrapUpApplyPhase({
    directive,
    clonePath: input.cfg.localPath,
    model: input.cfg.workerModel ?? input.cfg.model,
    agent: input.agent,
    repos: input.repos,
    manager: input.manager,
    emit: input.emit,
    appendSystem: input.appendSystem,
    presetName: input.presetName,
    verifyCommand: input.cfg.verifyCommand,
    runId: input.cfg.runId,
  });
}

// Helper: parse the next-actions.json sibling that T1.3 writes and
// pull the highest-priority action's text. Used by the wrap-up apply
// phase to know what to implement; falls back to the cfg.userDirective
// when the JSON is missing (typical for the first run on a fresh clone).
export async function readTopNextAction(input: {
  clonePath: string;
  runId: string;
  presetName: string;
}): Promise<string | null> {
  const runIdShort = input.runId.slice(0, 8);
  let entries: string[];
  try {
    entries = await fs.readdir(input.clonePath);
  } catch {
    return null;
  }
  const matches = entries.filter(
    (f) =>
      f.startsWith(`next-actions-${input.presetName}-${runIdShort}-`) &&
      f.endsWith(".json"),
  );
  if (matches.length === 0) return null;
  // Newest first — the iso suffix sorts lexicographically.
  matches.sort().reverse();
  let raw: string;
  try {
    raw = await fs.readFile(path.join(input.clonePath, matches[0]!), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("actions" in parsed) ||
    !Array.isArray((parsed as { actions: unknown }).actions)
  ) {
    return null;
  }
  const actions = (parsed as {
    actions: Array<{ priority?: string; text?: string }>;
  }).actions;
  if (actions.length === 0) return null;
  const order: Record<string, number> = { high: 3, medium: 2, low: 1 };
  const sorted = [...actions].sort(
    (a, b) =>
      (order[String(b.priority ?? "")] ?? 0) -
      (order[String(a.priority ?? "")] ?? 0),
  );
  const top = sorted[0];
  if (!top || typeof top.text !== "string" || top.text.trim().length === 0) {
    return null;
  }
  return top.text.trim();
}
