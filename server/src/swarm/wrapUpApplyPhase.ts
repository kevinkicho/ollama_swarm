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
import { extractText } from "./extractText.js";
import { parseWorkerResponse } from "./blackboard/prompts/worker.js";
import {
  realFilesystemAdapter,
  realGitAdapter,
} from "./blackboard/v2Adapters.js";
import {
  applyBaselineHunks,
  buildBaselinePrompt,
  collectAllFiles,
} from "./BaselineRunner.js";
import { pickProvider } from "../providers/pickProvider.js";
import { tokenTracker } from "../services/ollamaProxy.js";

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
   *  hunks failed to apply). */
  commitSha?: string;
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
    if (result.usage) {
      tokenTracker.add({
        ts: Date.now(),
        promptTokens: result.usage.promptTokens,
        responseTokens: result.usage.responseTokens,
        durationMs: Date.now() - t0,
        model: input.model,
        path: `/wrap-up-apply (${provider.id})`,
      });
    }
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

  // Apply + commit
  const fsAdapter = realFilesystemAdapter(input.clonePath);
  const gitAdapter = realGitAdapter(input.clonePath);
  try {
    const apply = await applyBaselineHunks({
      hunks: parsed.hunks,
      fs: fsAdapter,
    });
    if (apply.applied === 0) {
      input.appendSystem(
        `Wrap-up apply: ${parsed.hunks.length} hunk(s) returned, 0 applied — ${apply.reasons.join("; ")}`,
      );
      return {
        ok: false,
        reason: `0 of ${parsed.hunks.length} hunks landed: ${apply.reasons.join("; ")}`,
        hunksAttempted: parsed.hunks.length,
        hunksApplied: 0,
      };
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
        hunksAttempted: parsed.hunks.length,
        hunksApplied: apply.applied,
      };
    }
    input.appendSystem(
      `Wrap-up apply: ${apply.applied}/${parsed.hunks.length} hunk(s) applied → committed (${commitResult.sha.slice(0, 7)}).`,
    );
    return {
      ok: true,
      hunksAttempted: parsed.hunks.length,
      hunksApplied: apply.applied,
      commitSha: commitResult.sha,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    input.appendSystem(`Wrap-up apply: apply/commit failed — ${msg}`);
    return {
      ok: false,
      reason: msg,
      hunksAttempted: parsed.hunks.length,
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
    runId?: string;
    localPath: string;
    workerModel?: string;
    model: string;
    userDirective?: string;
  };
  presetName: string;
  agent: import("../services/AgentManager.js").Agent;
  manager: import("../services/AgentManager.js").AgentManager;
  repos: import("../services/RepoService.js").RepoService;
  emit: (e: import("../types.js").SwarmEvent) => void;
  appendSystem: (text: string) => void;
}

export async function maybeRunWrapUpApply(
  input: MaybeRunWrapUpApplyInput,
): Promise<WrapUpApplyResult | null> {
  if (!input.cfg.executeNextAction) return null;
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
        `Wrap-up apply: no extractable next-action and no userDirective — skipping apply phase.`,
      );
      return null;
    }
    input.appendSystem(
      `Wrap-up apply: no extractable next-action found in deliverable — falling back to userDirective.`,
    );
    directive = fallback;
  }
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
