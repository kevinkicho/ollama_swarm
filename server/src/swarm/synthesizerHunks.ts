// Phase 1 (writeMode: single): helper for synthesizer-produces-hunks.
// Discussion presets (council, MoA, map-reduce, OW, round-robin)
// can opt into writeMode: "single" where the synthesizer implements
// the agreed directive — prefer git-native write/edit + workingTree,
// with classic hunks as fallback.
//
// This module provides:
//   - buildSynthesizerHunksPrompt: prompt builder (git-native first)
//   - parseSynthesizerHunks: parse workingTree or { hunks: [...] }
//   - runSynthesizerHunks: tool-enabled chat + parse
//   - runSynthesizerHunksAndApply: commit workingTree or wrap-up apply hunks

import type { Hunk } from "./blackboard/applyHunks.js";
import { parseWorkerResponse } from "./blackboard/prompts/worker.js";
import type { Agent, AgentManager } from "../services/AgentManager.js";
import type { RepoService } from "../services/RepoService.js";
import type { SwarmEvent } from "../types.js";
import { extractText } from "./extractText.js";
import { collectAllFiles } from "./BaselineRunner.js";
import {
  runWrapUpApplyPhase,
  type WrapUpApplyInput,
  type WrapUpApplyResult,
} from "./wrapUpApplyPhase.js";
import {
  realFilesystemAdapter,
  realGitAdapter,
} from "./blackboard/v2Adapters.js";
import {
  noteApplyAttempt,
  noteApplySuccess,
} from "./applyIntegrityStats.js";

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
  /** Git-native: tools already mutated disk. */
  workingTree?: boolean;
  filesTouched?: string[];
  gitMessage?: string;
}

/**
 * Build a prompt that prefers write/edit + workingTree, with hunks fallback.
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
    `The following files exist in the repository. Prefer touching these paths; new files under listed parents are OK.`,
  );
  lines.push(``);
  lines.push(input.fileListing);
  lines.push(``);
  lines.push(`## Output Format`);
  lines.push(``);
  lines.push(
    `PREFERRED (git-native): use write/edit tools (and read/grep/git_status/git_diff) on disk,`,
  );
  lines.push(
    `then finish with ONLY this JSON (no prose, no markdown fences):`,
  );
  lines.push(``);
  lines.push(`{`);
  lines.push(`  "workingTree": true,`);
  lines.push(`  "message": "short commit subject",`);
  lines.push(`  "files": ["path/to/file.ts"]`);
  lines.push(`}`);
  lines.push(``);
  lines.push(
    `FALLBACK when tools are unavailable or for tiny anchor patches: return a hunks envelope:`,
  );
  lines.push(``);
  lines.push(`{`);
  lines.push(`  "hunks": [`);
  lines.push(
    `    { "op": "replace", "file": "path/to/file.ts", "search": "exact code to find", "replace": "new code" },`,
  );
  lines.push(
    `    { "op": "create", "file": "path/to/new.ts", "content": "file content" },`,
  );
  lines.push(
    `    { "op": "append", "file": "path/to/file.ts", "content": "text to append" }`,
  );
  lines.push(`  ]`);
  lines.push(`}`);
  lines.push(``);
  lines.push(`Guidelines:`);
  lines.push(`- Prefer workingTree after real write/edit tool use.`);
  lines.push(`- For hunks: use "replace" when search matches EXACTLY once; "create" for new files; "write" for full rewrites.`);
  lines.push(`- Keep changes atomic and minimal.`);
  lines.push(`- If you cannot implement, return { "hunks": [], "skip": "reason" }`);
  lines.push(``);
  lines.push(`Now implement (tools first if available), then emit the final JSON:`);
  return lines.join("\n");
}

/**
 * Parse the synthesizer's workingTree or { hunks: [...] } response.
 */
export function parseSynthesizerHunks(
  raw: string,
  allowedFiles: Set<string>,
): SynthesizerHunksResult {
  const text = extractText(raw) ?? raw;
  const allowedArray = Array.from(allowedFiles);
  const parsed = parseWorkerResponse(text, allowedArray);
  if (!parsed.ok) {
    return { ok: false, hunks: [], reason: parsed.reason };
  }
  if (parsed.workingTree) {
    return {
      ok: true,
      hunks: [],
      workingTree: true,
      filesTouched: parsed.filesTouched,
      gitMessage: parsed.gitMessage,
    };
  }
  return {
    ok: true,
    hunks: parsed.hunks,
    ...(parsed.skip ? { reason: parsed.skip } : {}),
  };
}

/**
 * Orchestrator: tool-enabled synthesizer chat + parse (workingTree or hunks).
 */
export async function runSynthesizerHunks(
  input: SynthesizerHunksInput & { runId?: string },
): Promise<SynthesizerHunksResult> {
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
    const { runGitNativeApplyChat } = await import("./gitNativeApplyChat.js");
    const result = await runGitNativeApplyChat({
      model: input.model,
      agentId: input.agent.id,
      clonePath: input.clonePath,
      prompt,
      signal: new AbortController().signal,
      runId: input.runId,
      pathLabel: `/synthesizer-git-native`,
      maxToolTurns: 28,
    });
    if (result.finishReason === "error") {
      throw new Error(result.errorMessage ?? "synthesizer: provider error");
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

  return parseSynthesizerHunks(raw, allowedSet);
}

/**
 * Convenience wrapper: synthesizer tools → workingTree commit, or hunks → wrapUpApply.
 */
export async function runSynthesizerHunksAndApply(
  input: SynthesizerHunksInput & {
    emit: (e: SwarmEvent) => void;
    appendSystem: (text: string) => void;
    presetName: string;
    verifyCommand?: string;
    runId?: string;
  },
): Promise<WrapUpApplyResult> {
  input.appendSystem(
    `Synthesizer: git-native tools enabled — prefer write/edit then {workingTree:true,...}.`,
  );
  const result = await runSynthesizerHunks(input);

  if (!result.ok) {
    const reason = result.reason ?? "unknown";
    input.appendSystem(`Synthesizer: failed — ${reason}`);
    return { ok: false, reason, hunksAttempted: 0, hunksApplied: 0 };
  }

  // Git-native path: disk already mutated.
  if (
    result.workingTree
    || (result.hunks.length === 0 && (result.filesTouched?.length ?? 0) > 0)
  ) {
    const files =
      result.filesTouched && result.filesTouched.length > 0
        ? result.filesTouched
        : (await collectAllFiles(input.clonePath)).slice(0, 12);
    const message =
      result.gitMessage
      ?? `${input.presetName} synthesizer: ${input.directive.slice(0, 60)}`;
    try {
      const { commitWorkingTreeFiles } = await import(
        "./blackboard/workingTreeCommit.js"
      );
      const fsAdapter = realFilesystemAdapter(input.clonePath);
      const gitAdapter = realGitAdapter(input.clonePath);
      const wtResult = await commitWorkingTreeFiles({
        todoId: `synth-${input.presetName}`,
        workerId: input.agent.id,
        files,
        message,
        fs: fsAdapter,
        git: gitAdapter,
        runId: input.runId,
        clonePath: input.clonePath,
      });
      if (wtResult.ok && wtResult.filesWritten.length > 0) {
        noteApplyAttempt(input.runId);
        noteApplySuccess(input.runId);
        input.appendSystem(
          `Synthesizer: git-native working-tree commit — ${wtResult.commitSha?.slice(0, 7) ?? "ok"} ` +
            `(${wtResult.filesWritten.length} file(s)).`,
        );
        return {
          ok: true,
          hunksAttempted: wtResult.filesWritten.length,
          hunksApplied: wtResult.filesWritten.length,
          commitSha: wtResult.commitSha,
        };
      }
      const failReason = wtResult.ok
        ? "working-tree-zero-files"
        : (wtResult.reason || "working-tree-failed");
      input.appendSystem(`Synthesizer: working-tree commit failed — ${failReason}`);
      // Fall through to worker wrap-up re-prompt rather than hard fail.
      input.appendSystem(
        `Synthesizer: falling through to wrap-up worker re-prompt after working-tree miss.`,
      );
      return runWrapUpApplyPhase({
        directive: input.directive,
        clonePath: input.clonePath,
        model: input.model,
        agent: input.agent,
        runId: input.runId,
        repos: input.repos,
        manager: input.manager,
        emit: input.emit,
        appendSystem: input.appendSystem,
        presetName: input.presetName,
        verifyCommand: input.verifyCommand,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      input.appendSystem(`Synthesizer: working-tree error — ${msg}`);
      return { ok: false, reason: msg, hunksAttempted: 0, hunksApplied: 0 };
    }
  }

  if (result.hunks.length === 0) {
    const reason = result.reason ?? "no hunks";
    input.appendSystem(
      `Synthesizer: no workingTree and 0 hunks — ${reason}; falling through to wrap-up worker re-prompt.`,
    );
    return runWrapUpApplyPhase({
      directive: input.directive,
      clonePath: input.clonePath,
      model: input.model,
      agent: input.agent,
      runId: input.runId,
      repos: input.repos,
      manager: input.manager,
      emit: input.emit,
      appendSystem: input.appendSystem,
      presetName: input.presetName,
      verifyCommand: input.verifyCommand,
    });
  }

  input.appendSystem(
    `Synthesizer: produced ${result.hunks.length} hunk(s), applying via wrap-up…`,
  );

  const wrapUp: WrapUpApplyInput = {
    directive: input.directive,
    clonePath: input.clonePath,
    model: input.model,
    agent: input.agent,
    runId: input.runId,
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
