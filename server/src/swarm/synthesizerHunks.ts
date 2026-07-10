// Phase 1 (writeMode: single): helper for synthesizer-produces-hunks.
// Discussion presets (council, MoA, map-reduce, OW, round-robin)
// can opt into writeMode: "single" where the synthesizer directly
// emits { hunks: [...] } instead of prose + next-actions JSON.
//
// This module provides:
//   - buildSynthesizerHunksPrompt: prompt builder for synthesizer-with-hunks
//   - parseSynthesizerHunks: parse the { hunks: [...] } envelope
//   - runSynthesizerHunks: orchestration helper (prompt + parse + wrapUpApply)
//
// The key difference vs wrapUpApply: synthesizer produces hunks IN THE
// SAME context that already has the discussion history, so it benefits
// from the multi-agent reasoning. No separate worker prompt step.

import type { Hunk } from "./blackboard/applyHunks.js";
import { parseWorkerResponse } from "./blackboard/prompts/worker.js";
import type { Agent, AgentManager } from "../services/AgentManager.js";
import type { RepoService } from "../services/RepoService.js";
import type { SwarmEvent } from "../types.js";
import { extractText } from "./extractText.js";
import { collectAllFiles } from "./BaselineRunner.js";

import { pickProvider } from "../providers/pickProvider.js";
import {
  runWrapUpApplyPhase,
  type WrapUpApplyInput,
} from "./wrapUpApplyPhase.js";

export interface SynthesizerHunksInput {
  /** The synthesized consensus/directive from discussion. */
  directive: string;
  /** Clone path for file listing. */
  clonePath: string;
  /** Agent to run the synthesizer prompt (usually the lead). */
  agent: Agent;
  /** Model id for the synthesizer. */
  model: string;
  /** Manager for status updates. */
  manager: AgentManager;
  /** Repo helper for file listing. */
  repos: RepoService;
  /** Emit callback for transcript. */
  emit: (e: SwarmEvent) => void;
  /** Context from discussion (transcript summary, rationale). */
  discussionContext: string;
  /** Optional file hints — which files are most relevant. */
  relevantFiles?: string[];
}

export interface SynthesizerHunksResult {
  ok: boolean;
  hunks: Hunk[];
  reason?: string;
}

/**
 * Build a prompt that asks the synthesizer to emit hunks directly.
 */
export function buildSynthesizerHunksPrompt(input: {
  directive: string;
  fileListing: string;
  discussionContext: string;
  relevantFiles?: string[];
}): string {
  const lines: string[] = [];
  lines.push(
    `You are a synthesizer agent. Based on the multi-agent discussion below,`,
    `implement the agreed-upon directive as file modifications.`,
    ``,
    `## Directive`,
    ``,
    `${input.directive}`,
    ``,
    `## Discussion Context`,
    ``,
    `${input.discussionContext}`,
    ``,
  );
  if (input.relevantFiles && input.relevantFiles.length > 0) {
    lines.push(`## Relevant Files (identified by agents)`);
    lines.push(``);
    lines.push(...input.relevantFiles.map((f) => `- ${f}`));
    lines.push(``);
  }
  lines.push(`## Repository Files`);
  lines.push(``);
  lines.push(
    `The following files exist in the repository. Only touch files in this list.`,
  );
  lines.push(``);
  lines.push(input.fileListing);
  lines.push(``);
  lines.push(`## Output Format`);
  lines.push(``);
  lines.push(
    `Return a JSON envelope of hunks (search/replace edits) that implement the directive.`,
  );
  lines.push(`Each hunk describes ONE modification: a file, a search anchor, and replacement text.`,
  );
  lines.push(``);
  lines.push(`\`\`\`json`);
  lines.push(`{`);
  lines.push(`  "hunks": [`);
  lines.push(`    { "op": "replace", "file": "path/to/file.ts", "search": "exact code to find", "replace": "new code" },`);
  lines.push(`    { "op": "create", "file": "path/to/new.ts", "content": "file content" },`);
  lines.push(`    { "op": "append", "file": "path/to/file.ts", "content": "text to append" }`);
  lines.push(`  ]`);
  lines.push(`}`);
  lines.push(`\`\`\``);
  lines.push(``);
  lines.push(`Guidelines:`);
  lines.push(`- Use "replace" for existing files. \`search\` must match EXACTLY once.`);
  lines.push(`- Use "create" for new files that don't exist.`);
  lines.push(`- Use "append" to add to the end of an existing file.`);
  lines.push(`- Keep hunks atomic and minimal.`);
  lines.push(`- If you cannot implement, return \`{ "hunks": [], "skip": "reason" }\``);
  lines.push(``);
  lines.push(`Now emit the hunks JSON:`);
  return lines.join("\n");
}

/**
 * Parse the synthesizer's { hunks: [...] } response.
 */
export function parseSynthesizerHunks(
  raw: string,
  allowedFiles: Set<string>,
): SynthesizerHunksResult {
  const text = extractText(raw) ?? raw;
  // Convert Set to array for parseWorkerResponse
  const allowedArray = Array.from(allowedFiles);
  const parsed = parseWorkerResponse(text, allowedArray);
  if (!parsed.ok) {
    return { ok: false, hunks: [], reason: parsed.reason };
  }
  return { ok: true, hunks: parsed.hunks };
}

/**
 * Orchestrator: run synthesizer-with-hunks and pass results to wrapUpApply.
 */
export async function runSynthesizerHunks(
  input: SynthesizerHunksInput,
): Promise<SynthesizerHunksResult> {
  // Collect file listing for allowed-set
  const expectedFiles = await collectAllFiles(input.clonePath);
  const allowedSet = new Set(expectedFiles);
  const fileList = expectedFiles.slice(0, 100).join("\n");
  const prompt = buildSynthesizerHunksPrompt({
    directive: input.directive,
    fileListing: fileList,
    discussionContext: input.discussionContext,
    relevantFiles: input.relevantFiles,
  });

  let raw: string;
  try {
    input.manager.markStatus(input.agent.id, "thinking");
    const { provider, modelId } = pickProvider(input.model);
    const t0 = Date.now();
    const result = await provider.chat({
      model: modelId,
      messages: [{ role: "user", content: prompt }],
      signal: new AbortController().signal,
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
      path: `/synthesizer-hunks (${provider.id})`,
    });
    if (result.finishReason === "error") {
      throw new Error(result.errorMessage ?? "synthesizer hunks: provider error");
    }
    if (result.finishReason === "aborted") {
      throw new Error("aborted");
    }
    raw = result.text;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, hunks: [], reason: msg };
  } finally {
    input.manager.markStatus(input.agent.id, "ready");
  }

  const parsed = parseSynthesizerHunks(raw, allowedSet);
  if (!parsed.ok) {
    return parsed;
  }
  return { ok: true, hunks: parsed.hunks };
}

/**
 * Convenience wrapper: run synthesizer-hunks + wrapUpApply in one call.
 */
export async function runSynthesizerHunksAndApply(
  input: SynthesizerHunksInput & {
    emit: (e: SwarmEvent) => void;
    appendSystem: (text: string) => void;
    presetName: string;
    verifyCommand?: string;
  },
): Promise<{ ok: boolean; reason?: string; hunksAttempted: number; hunksApplied: number; commitSha?: string }> {
  const result = await runSynthesizerHunks(input);
  if (!result.ok || result.hunks.length === 0) {
    const reason = result.reason ?? (result.hunks.length === 0 ? "no hunks" : "unknown");
    input.appendSystem(
      `Synthesizer-hunks: failed to produce hunks — ${reason}`,
    );
    return { ok: false, reason, hunksAttempted: 0, hunksApplied: 0 };
  }

  input.appendSystem(
    `Synthesizer-hunks: produced ${result.hunks.length} hunk(s), applying...`,
  );

  const wrapUp: WrapUpApplyInput = {
    directive: input.directive,
    clonePath: input.clonePath,
    model: input.model,
    agent: input.agent,
    repos: input.repos,
    manager: input.manager,
    emit: input.emit,
    appendSystem: input.appendSystem,
    presetName: input.presetName,
    verifyCommand: input.verifyCommand,
    hunksFromSynthesizer: result.hunks,
  };
  return runWrapUpApplyPhase(wrapUp);
}