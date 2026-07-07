import type { TranscriptEntry } from "../types.js";
import {
  readDirective,
  buildDirectiveBlock,
} from "./directivePromptHelpers.js";
import { execSync } from "node:child_process";
import { getModelBudget } from "./modelContextBudget.js";

function buildProjectContext(localPath?: string): string {
  if (!localPath) return "";
  try {
    const dirs = execSync(
      'find . -type d | grep -v node_modules | grep -v .git | grep -v dist | sort | head -30',
      { cwd: localPath, encoding: "utf8", timeout: 3000 }
    ).toString().trim();
    const files = execSync(
      'find . -type f \\( -name "*.tsx" -o -name "*.ts" -o -name "*.js" -o -name "*.jsx" -o -name "*.json" -o -name "*.css" \\) | grep -v node_modules | grep -v .git | grep -v dist | grep -v package-lock.json | head -50',
      { cwd: localPath, encoding: "utf8", timeout: 3000 }
    ).toString().trim();
    const parts: string[] = [];
    if (dirs) parts.push(`Project directories:\n${dirs}`);
    if (files) parts.push(`Key files:\n${files}`);
    return parts.length > 0 ? `\n${parts.join("\n\n")}\n` : "";
  } catch {
    return "";
  }
}

export function buildCouncilSynthesisPrompt(
  totalRounds: number,
  transcript: readonly TranscriptEntry[],
  userDirective?: string,
  committedFiles?: string[],
  ambitionTier?: number,
  localPath?: string,
  repoFiles?: string[],
  codeContextExcerpts?: ReadonlyArray<{ path: string; excerpt: string }>,
  model?: string,
): string {
  const budget = getModelBudget(model);
  const maxRepoFiles = budget.fullFileMode ? 500 : 80;
  const transcriptText = transcript
    .map((e) => {
      if (e.role === "system") return `[SYSTEM] ${e.text}`;
      if (e.role === "user") return `[HUMAN] ${e.text}`;
      return `[Agent ${e.agentIndex}] ${e.text}`;
    })
    .join("\n\n");

  const dirCtx = readDirective({ userDirective });
  const directiveBlock = buildDirectiveBlock(dirCtx, {
    labelSuffix: "(the directive)",
    authoritative: true,
  });

  const committedBlock = committedFiles && committedFiles.length > 0
    ? [`\nALREADY COMMITTED (files changed in prior cycles):`, ...committedFiles.map(f => `  ${f}`), ""]
    : [];

  const ambitionLine = ambitionTier && ambitionTier > 1
    ? `This is ambition tier ${ambitionTier}. Each tier must be MATERIALLY MORE AMBITIOUS than the prior — broader scope, deeper work, or capability the prior tier didn't touch. Do NOT propose re-doing or revising what's already committed.`
    : "";

  const projectContext = buildProjectContext(localPath);
  const repoContext = repoFiles && repoFiles.length > 0
    ? `\nProject files (${repoFiles.length} total):\n${repoFiles.slice(0, maxRepoFiles).join("\n")}${repoFiles.length > maxRepoFiles ? `\n... and ${repoFiles.length - maxRepoFiles} more` : ""}`
    : "";
  const codeContext = codeContextExcerpts && codeContextExcerpts.length > 0
    ? `\nKey file excerpts:\n${codeContextExcerpts.map(({ path, excerpt }) => `--- ${path} ---\n${excerpt}`).join("\n\n")}`
    : "";

  return [
    `You are Agent 1, the synthesis lead. ${totalRounds} agent(s) independently audited the codebase and reported their findings. Your job: merge their findings into a single concrete action plan.`,
    "",
    ...directiveBlock,
    projectContext,
    repoContext,
    codeContext,
    ...committedBlock,
    ambitionLine,
    "RULES:",
    "1. Every finding MUST reference files that exist in the PROJECT FILES list above.",
    "2. Every proposed change MUST target a file that actually exists or needs to be created in an existing directory.",
    "3. Do NOT propose features that don't address specific gaps found by the auditors.",
    "4. Do NOT propose building a new app from scratch — you are FIXING/ENHANCING an existing project.",
    "5. Group related findings into concrete todos. Each todo = one specific file change.",
    "",
    "OUTPUT FORMAT — return ONLY a JSON array:",
    '[{"description": "concrete change description", "expectedFiles": ["path/to/file.ts"]}]',
    "",
    "Max 8 todos. Each must be a specific, actionable change to a real file.",
    "",
    "=== AGENT FINDINGS ===",
    transcriptText,
    "=== END FINDINGS ===",
    "",
    "Produce your merged action plan now.",
  ].join("\n");
}

export function buildCouncilPrompt(
  agentIndex: number,
  round: number,
  totalRounds: number,
  snapshot: readonly TranscriptEntry[],
  userDirective?: string,
  localPath?: string,
  repoFiles?: string[],
  codeContextExcerpts?: ReadonlyArray<{ path: string; excerpt: string }>,
  model?: string,
): string {
  const budget = getModelBudget(model);
  const maxRepoFiles = budget.fullFileMode ? 500 : 80;
  const visible =
    round === 1 ? snapshot.filter((e) => e.role !== "agent") : snapshot;

  const transcriptText = visible
    .map((e) => {
      if (e.role === "system") return `[SYSTEM] ${e.text}`;
      if (e.role === "user") return `[HUMAN] ${e.text}`;
      return `[Agent ${e.agentIndex}] ${e.text}`;
    })
    .join("\n\n");

  const dirCtx = readDirective({ userDirective });
  const directiveBlock = buildDirectiveBlock(dirCtx, {
    labelSuffix: "(the directive)",
    authoritative: true,
  });

  const projectContext = buildProjectContext(localPath);
  const repoContext = repoFiles && repoFiles.length > 0
    ? `\nProject files (${repoFiles.length} total):\n${repoFiles.slice(0, maxRepoFiles).join("\n")}${repoFiles.length > maxRepoFiles ? `\n... and ${repoFiles.length - maxRepoFiles} more` : ""}`
    : "";
  const codeContext = codeContextExcerpts && codeContextExcerpts.length > 0
    ? `\nKey file excerpts:\n${codeContextExcerpts.map(({ path, excerpt }) => `--- ${path} ---\n${excerpt}`).join("\n\n")}`
    : "";

  const roundIntent =
    round === 1
      ? [
          `You are Agent ${agentIndex}, auditing the codebase. Your job: READ the actual code, identify what's broken, incomplete, missing, or could be improved.`,
          "",
          "WHAT TO DO IN ROUND 1:",
          "1. Read the project files listed above — start with README.md, package.json, and main entry files.",
          "2. For each file, check: does the code match what the README claims? Are there stubs, TODOs, mock data, broken imports, missing implementations?",
          "3. Identify specific, concrete issues — not vague suggestions.",
          "4. Return your findings as a structured list.",
          "",
          "OUTPUT FORMAT — return ONLY a JSON array:",
          '[{"issue": "specific problem description", "file": "path/to/file.ts", "severity": "high|medium|low", "suggestion": "concrete fix"}]',
          "",
          "Max 6 findings. Each must reference a REAL file from the PROJECT FILES list.",
          "Do NOT propose building a new app. Do NOT propose features not grounded in actual code gaps.",
        ].join("\n")
      : [
          `You are Agent ${agentIndex}, round ${round} of ${totalRounds}. Other agents' findings from round 1 are in the transcript below.`,
          "",
          "WHAT TO DO IN ROUND 2+:",
          "1. Review what other agents found. Compare with your own findings.",
          "2. Verify: are the other agents' findings real? Check the actual files.",
          "3. Add any gaps the other agents missed.",
          "4. Disagree where you think a finding is wrong.",
          "",
          "OUTPUT FORMAT — return ONLY a JSON array:",
          '[{"issue": "specific problem description", "file": "path/to/file.ts", "severity": "high|medium|low", "suggestion": "concrete fix"}]',
          "",
          "Keep it under 250 words. Be specific. Cite file paths.",
        ].join("\n");

  return [
    "HARD RULES:",
    "1. You are FIXING/ENHANCING an existing project. Do NOT propose building a new app from scratch.",
    "2. Every file you reference MUST appear in the PROJECT FILES list. Do NOT invent paths.",
    "3. READ actual file contents using your tools before reporting issues. Do NOT guess.",
    "4. Do NOT report issues that don't exist — check the actual code first.",
    "5. Your findings must reference at least one file from the PROJECT FILES list.",
    "",
    ...directiveBlock,
    projectContext,
    repoContext,
    codeContext,
    "",
    roundIntent,
    "",
    transcriptLabel(round),
    transcriptText || "(empty — you are writing the first entry)",
    "=== END TRANSCRIPT ===",
    "",
    `Now respond as Agent ${agentIndex}.`,
  ].join("\n");
}

function transcriptLabel(round: number): string {
  return round === 1
    ? "=== PROJECT CONTEXT (peer findings hidden this round) ==="
    : "=== AGENT FINDINGS SO FAR ===";
}

export function buildStandupPrompt(
  agentIndex: number,
  contract: { missionStatement: string; criteria: Array<{ description: string; expectedFiles: string[]; status: string }> },
  committedFiles: string[],
  userDirective?: string,
  localPath?: string,
  repoFiles?: string[],
  model?: string,
  progressContext?: string,
): string {
  const budget = getModelBudget(model);
  const maxRepoFiles = budget.fullFileMode ? 500 : 60;
  const criteriaBlock = contract.criteria.length > 0
    ? contract.criteria
      .map((c) => `  [${c.status === "met" ? "✓" : "○"}] ${c.description} — files: ${c.expectedFiles.join(", ") || "(none)"}`)
      .join("\n")
    : "  (no criteria defined yet — audit the code to find gaps)";

  const committedBlock = committedFiles.length > 0
    ? `\nAlready committed files:\n${committedFiles.map(f => `  ${f}`).join("\n")}`
    : "";

  let projectStructure = "";
  if (localPath) {
    try {
      const dirs = execSync(
        'find . -type d | grep -v node_modules | grep -v .git | grep -v dist | sort | head -30',
        { cwd: localPath, encoding: "utf8", timeout: 3000 }
      ).toString().trim();
      if (dirs) projectStructure = `\nProject directories:\n${dirs}`;
    } catch { /* ignore */ }
  }

  const dirCtx = readDirective({ userDirective });
  const directiveBlock = buildDirectiveBlock(dirCtx, {
    labelSuffix: "(the directive)",
    authoritative: true,
  });

  const repoContext = repoFiles && repoFiles.length > 0
    ? `\nProject files (${repoFiles.length} total):\n${repoFiles.slice(0, maxRepoFiles).join("\n")}${repoFiles.length > maxRepoFiles ? `\n... and ${repoFiles.length - maxRepoFiles} more` : ""}`
    : "";

  return [
    `You are Agent ${agentIndex}, doing a quick code audit. Check what was built and find remaining gaps.`,
    "",
    ...directiveBlock,
    "",
    contract.missionStatement
      ? `Current mission: "${contract.missionStatement}"`
      : "No mission defined yet. Audit the code to find what needs work.",
    `Criteria:\n${criteriaBlock}`,
    committedBlock,
    projectStructure,
    repoContext,
    progressContext?.trim() ? progressContext : "",
    "",
    "RULES:",
    "1. Read actual files before reporting issues. Do NOT guess.",
    "2. Every file you reference MUST appear in the PROJECT FILES list.",
    "3. Do NOT propose building a new app. You are FIXING/ENHANCING an existing project.",
    "4. Focus on what's STILL MISSING or BROKEN, not what's already done.",
    "",
    "OUTPUT FORMAT — return ONLY a JSON array:",
    '[{"issue": "specific problem", "file": "path/to/file.ts", "severity": "high|medium|low", "suggestion": "concrete fix"}]',
    "",
    "Max 4 findings. Be specific about file paths.",
    "",
    `Now respond as Agent ${agentIndex}.`,
  ].join("\n");
}

/** Agent-1 standup merge prompt — agents drive the plan; progress block is informational only. */
export function buildStandupSynthesisPrompt(
  proposals: string,
  progressContext?: string,
): string {
  return [
    "You are Agent 1, synthesizing standup proposals into a unified plan.",
    progressContext?.trim() ? progressContext : "",
    "",
    "Standup proposals from all agents:",
    proposals,
    "",
    "Merge these into a single coherent plan. Focus on what is actionable.",
    "Output a JSON array of concrete todos:",
    '[{"description": "specific file change", "expectedFiles": ["path/to/file.ts"]}]',
    "",
    "Prefer at most one todo per file path. Return ONLY the JSON array.",
  ].join("\n");
}
