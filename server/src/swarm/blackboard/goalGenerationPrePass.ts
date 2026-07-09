// Goal-generation pre-pass: direction-aware variant.
//
// When a user directive IS provided, this pass proposes 3-5 improvements
// that ADVANCE the directive given the current state of the codebase.
// It does NOT replace the directive — it enriches it with concrete,
// code-grounded goals that the planner can use to derive criteria.
//
// When no directive is provided, falls back to the original behavior:
// propose 3-5 ambitious improvements ranked by impact:effort.
//
// The output is always a list of goals. The caller (lifecycleRunner)
// uses these goals to ENHANCE the directive, not replace it.

import type { Agent } from "../../services/AgentManager.js";
import { extractText } from "../extractText.js";
import { parseGoalList } from "./goalListParser.js";
import type { PlannerSeed } from "./prompts/planner.js";
import { isWebToolsEnabled, resolveToolProfile } from "../toolProfiles.js";
import type { RunConfig } from "../SwarmRunner.js";
import {
  chatOnceWithStreaming,
  type ChatStreamingSurface,
} from "./promptRunner.js";
import { isPromptHaltError } from "./lifecycleState.js";

export async function runGoalGenerationPrePass(
  planner: Agent,
  seed: PlannerSeed,
  appendSystem: (text: string) => void,
  opts: {
    signal?: AbortSignal;
    /** @deprecated Prefer streaming surface — wires dock + activity labels. */
    onStatusChange?: (status: "thinking" | "ready") => void;
    streaming?: ChatStreamingSurface;
    cfg?: RunConfig;
    onTool?: (info: { tool: string; ok: boolean; preview: string }) => void;
    /** When set, raw model output is appended as an agent bubble (tool trace attaches there). */
    onAgentOutput?: (text: string) => void;
  } = {},
): Promise<string[] | undefined> {
  const hasDirective = seed.userDirective && seed.userDirective.length > 0;
  const topLevelText = seed.topLevel.slice(0, 60).join(", ");
  const readmeText = seed.readmeExcerpt
    ? `=== README excerpt ===\n${seed.readmeExcerpt.slice(0, 4000)}\n=== END ===`
    : "(no README)";

  const repoFileList = seed.repoFiles && seed.repoFiles.length > 0
    ? `\nProject files (${seed.repoFiles.length} total):\n${seed.repoFiles.slice(0, 100).join("\n")}${seed.repoFiles.length > 100 ? `\n... and ${seed.repoFiles.length - 100} more` : ""}`
    : "";

  let prompt: string;

  if (hasDirective) {
    appendSystem(
      `Goal-generation pre-pass: analyzing codebase to enrich directive "${seed.userDirective!.slice(0, 80)}…"`,
    );
    prompt = [
      "You are a senior engineer analyzing a codebase to help implement a specific user request.",
      "",
      `USER DIRECTIVE (what the user wants):`,
      seed.userDirective,
      "",
      `Repo: ${seed.repoUrl}`,
      `Top-level entries: ${topLevelText}`,
      repoFileList,
      readmeText,
      "",
      "Your job: Identify 3-5 CONCRETE, CODE-GROUNDED improvements that ADVANCE this directive.",
      "For each improvement:",
      "- 1 sentence describing what needs to happen.",
      "- Cite 1-3 SPECIFIC file paths from the project where the work would land.",
      "- Explain HOW this advances the user's directive.",
      "- Explain WHY this is feasible given the current codebase state.",
      "",
      "RULES:",
      "1. Every improvement MUST directly serve the user's directive. Do NOT propose unrelated features.",
      "2. Every file path MUST appear in the PROJECT FILES list above. Do NOT invent paths.",
      "3. Read the actual files using your tools before proposing. Do NOT guess.",
      "4. Favor improvements that fix existing gaps over creating new features from scratch.",
      "5. If the directive is already well-served by the codebase, say so — don't force improvements.",
      "",
      "Output format:",
      "1. [TITLE] - description (files: a/b.ts, c.ts) — Advances directive because X.",
      "2. ...",
    ].join("\n");
  } else {
    appendSystem("Goal-generation pre-pass: no directive — proposing ambitious goals…");
    prompt = [
      "You are a senior engineer doing a one-shot triage of an unfamiliar repo.",
      `Repo: ${seed.repoUrl}`,
      `Top-level entries: ${topLevelText}`,
      repoFileList,
      readmeText,
      "",
      "Propose 3-5 AMBITIOUS-BUT-FEASIBLE improvements ranked by impact:effort. Each:",
      "- 1 sentence describing the improvement.",
      "- Cites 1-3 file paths from the repo where the work would land.",
      "- Notes WHY it's ambitious (what gets unlocked) and WHY feasible (concrete attack path).",
      "",
      "Avoid trivia (typo fixes, dependency bumps, doc-only edits). Favor structural improvements.",
      "",
      "Output format:",
      "1. [TITLE] - description (files: a/b.ts, c.ts) — Ambitious because X. Feasible because Y.",
      "2. ...",
    ].join("\n");
  }

  if (opts.signal?.aborted) return undefined;

  const webOn = isWebToolsEnabled(opts.cfg);
  const agentProfile = webOn ? resolveToolProfile("read", opts.cfg) : "swarm";
  const chatOpts = {
    agentName: agentProfile,
    promptText: prompt,
    signal: opts.signal,
    clonePath: seed.clonePath,
    webToolsConfig: opts.cfg,
    runId: opts.cfg?.runId,
    mcpServers: opts.cfg?.mcpServers,
    ...(opts.onTool ? { onTool: opts.onTool } : {}),
  };

  try {
    const res = opts.streaming
      ? await chatOnceWithStreaming(planner, opts.streaming, chatOpts)
      : await (async () => {
          opts.onStatusChange?.("thinking");
          try {
            const { chatOnce } = await import("../chatOnce.js");
            return chatOnce(planner, chatOpts);
          } finally {
            opts.onStatusChange?.("ready");
          }
        })();
    const text = extractText(res);
    if (!text) return undefined;
    opts.onAgentOutput?.(text);
    const items = parseGoalList(text);
    return items.length > 0 ? items : undefined;
  } catch (err) {
    const stopping = () => opts.streaming?.abort?.isStopping?.() ?? false;
    const draining = () => opts.streaming?.abort?.isDraining?.() ?? false;
    if (opts.signal?.aborted || isPromptHaltError(err, stopping, draining)) {
      throw err;
    }
    appendSystem(
      `Goal-generation pre-pass failed (${err instanceof Error ? err.message : String(err)}); continuing without enrichment.`,
    );
    return undefined;
  }
}
