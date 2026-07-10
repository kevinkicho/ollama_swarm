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
import type { Hunk } from "./blackboard/applyHunks.js";
import { extractText } from "./extractText.js";
import { parseWorkerResponse } from "./blackboard/prompts/worker.js";
import {
  realFilesystemAdapter,
  realGitAdapter,
  realVerifyAdapter,
} from "./blackboard/v2Adapters.js";
import {
  applyBaselineHunks,
  buildBaselinePrompt,
  collectAllFiles,
} from "./BaselineRunner.js";
import { pickProvider } from "../providers/pickProvider.js";


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

  // Phase 1 extension: if hunksFromSynthesizer is provided, skip the
  // worker prompt and use the pre-computed hunks directly.
  let hunksToApply: import("./blackboard/applyHunks.js").Hunk[];
  if (input.hunksFromSynthesizer && input.hunksFromSynthesizer.length > 0) {
    hunksToApply = input.hunksFromSynthesizer;
    input.appendSystem(
      `Wrap-up apply: using ${hunksToApply.length} hunk(s) from synthesizer directly.`,
    );
  } else {
    // Build the prompt — same shape as BaselineRunner uses, so any
    // future improvements to baseline-style prompting flow here for free.
    const repoFiles = await input.repos.listRepoFiles(input.clonePath, {
      maxFiles: 50,
    });
    const readme = await input.repos.readReadme(input.clonePath);
    const prompt = buildBaselinePrompt({ directive, repoFiles, readme });

    // Run the prompt
    let raw: string;
    const abortController = new AbortController();
    try {
      input.manager.markStatus(input.agent.id, "thinking");
      const { provider, modelId } = pickProvider(input.model);
      const t0 = Date.now();
      const result = await provider.chat({
        model: modelId,
        messages: [{ role: "user", content: prompt }],
        signal: abortController.signal,
        agentId: input.agent.id,
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
      input.appendSystem(`Wrap-up apply: 0 hunks${skipNote}`);
      return {
        ok: true,
        hunksAttempted: 0,
        hunksApplied: 0,
      };
    }
    hunksToApply = parsed.hunks;
  }

  // Apply + (optional verify) + commit
  const fsAdapter = realFilesystemAdapter(input.clonePath);
  const gitAdapter = realGitAdapter(input.clonePath);
  // T171: snapshot pre-hunk content of touched files BEFORE applying.
  // Required for the verify-failure revert path. Skipped when no
  // verify command is configured (don't pay the read cost).
  const touchedFiles = Array.from(new Set(hunksToApply.map((h) => h.file)));
  const preHunkContents: Record<string, string | null> = {};
  if (input.verifyCommand) {
    for (const f of touchedFiles) {
      try {
        preHunkContents[f] = await fsAdapter.read(f);
      } catch {
        preHunkContents[f] = null; // treat as "didn't exist before"
      }
    }
  }
  try {
    const apply = await applyBaselineHunks({
      hunks: hunksToApply,
      fs: fsAdapter,
    });
    if (apply.applied === 0) {
      input.appendSystem(
        `Wrap-up apply: ${hunksToApply.length} hunk(s) returned, 0 applied — ${apply.reasons.join("; ")}`,
      );
      return {
        ok: false,
        reason: `0 of ${hunksToApply.length} hunks landed: ${apply.reasons.join("; ")}`,
        hunksAttempted: hunksToApply.length,
        hunksApplied: 0,
      };
    }
    // T171: pre-commit verify gate. Mirrors WorkerPipeline.applyAndCommit.
    if (input.verifyCommand) {
      const verify = realVerifyAdapter(input.clonePath, input.verifyCommand);
      const v = await verify.run();
      if (!v.ok) {
        // Revert touched files to pre-hunk content. Files that didn't
        // exist before (preHunkContents[f] === null) get left in place
        // — we don't have an explicit delete adapter and the next
        // commit (if any) will see a dirty working tree to clean up.
        for (const f of touchedFiles) {
          const before = preHunkContents[f];
          if (before === null) continue;
          try {
            await fsAdapter.write(f, before);
          } catch {
            // best-effort; revert failure is logged but doesn't stop us
          }
        }
        input.appendSystem(
          `Wrap-up apply: ${apply.applied} hunk(s) applied but verify gate failed — reverted. ${v.reason.slice(0, 400)}`,
        );
        return {
          ok: false,
          reason: `verify failed: ${v.reason.slice(0, 400)}`,
          hunksAttempted: hunksToApply.length,
          hunksApplied: apply.applied,
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
        `Wrap-up apply: ${apply.applied} hunk(s) applied to disk but commit failed — ${commitResult.reason}`,
      );
      return {
        ok: false,
        reason: commitResult.reason,
        hunksAttempted: hunksToApply.length,
        hunksApplied: apply.applied,
      };
    }
    const verifyTag = input.verifyCommand ? " (verify ✓)" : "";
    input.appendSystem(
      `Wrap-up apply: ${apply.applied}/${hunksToApply.length} hunk(s) applied → committed${verifyTag} (${commitResult.sha.slice(0, 7)}).`,
    );
    return {
      ok: true,
      hunksAttempted: hunksToApply.length,
      hunksApplied: apply.applied,
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
