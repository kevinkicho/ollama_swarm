import type { TranscriptEntry } from "../types.js";
import {
  readDirective,
  buildDirectiveBlock,
} from "./directivePromptHelpers.js";
import { readdirSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { getModelBudget } from "./modelContextBudget.js";
import { JSON_ONLY_FINAL_RULES } from "./blackboard/prompts/sharedSnippets.js";

const PROJECT_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  "out",
  ".turbo",
  ".cache",
]);

const PROJECT_CODE_EXT = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".json",
  ".css",
  ".md",
  ".mjs",
  ".cjs",
]);

function pathStaysUnderRoot(rootReal: string, candidate: string): boolean {
  let candReal: string;
  try {
    candReal = realpathSync(candidate);
  } catch {
    // Dangling / unreadable — skip rather than list outside
    return false;
  }
  const rootNorm = resolve(rootReal);
  const candNorm = resolve(candReal);
  const rel = relative(rootNorm, candNorm);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(`..${sep}`));
}

/**
 * Cross-platform project tree for prompt context (replaces Unix find|grep).
 * Pure sync walk; best-effort — empty string on failure.
 * Skips symlink/junction entries and rejects paths that resolve outside root
 * so model context does not leak linked dependency trees.
 */
export function listProjectTreeSync(
  root: string,
  opts?: { maxDirs?: number; maxFiles?: number; maxDepth?: number },
): { dirs: string[]; files: string[] } {
  const maxDirs = opts?.maxDirs ?? 30;
  const maxFiles = opts?.maxFiles ?? 50;
  const maxDepth = opts?.maxDepth ?? 4;
  const dirs: string[] = [];
  const files: string[] = [];

  let rootReal: string;
  try {
    rootReal = realpathSync(root);
  } catch {
    return { dirs, files };
  }

  const walk = (dir: string, depth: number) => {
    if (dirs.length >= maxDirs && files.length >= maxFiles) return;
    if (!pathStaysUnderRoot(rootReal, dir)) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // Stable order for deterministic prompts
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      if (PROJECT_SKIP_DIRS.has(ent.name)) continue;
      if (ent.name.startsWith(".") && ent.name !== ".env.example") continue;
      // Do not follow symlink/junction directories or files (Windows clones
      // with linked deps would otherwise leak outside the project root).
      if (typeof ent.isSymbolicLink === "function" && ent.isSymbolicLink()) {
        continue;
      }
      const full = join(dir, ent.name);
      if (!pathStaysUnderRoot(rootReal, full)) continue;
      const rel = relative(rootReal, full).replace(/\\/g, "/");
      if (ent.isDirectory()) {
        if (dirs.length < maxDirs) dirs.push(`./${rel}`);
        if (depth < maxDepth) walk(full, depth + 1);
      } else if (ent.isFile() && files.length < maxFiles) {
        if (ent.name === "package-lock.json" || ent.name === "pnpm-lock.yaml") continue;
        const dot = ent.name.lastIndexOf(".");
        const ext = dot >= 0 ? ent.name.slice(dot) : "";
        if (PROJECT_CODE_EXT.has(ext)) {
          files.push(`./${rel}`);
        }
      }
    }
  };

  walk(rootReal, 0);
  return { dirs, files };
}

function buildProjectContext(localPath?: string): string {
  if (!localPath) return "";
  try {
    const { dirs, files } = listProjectTreeSync(localPath);
    const parts: string[] = [];
    if (dirs.length > 0) parts.push(`Project directories:\n${dirs.join("\n")}`);
    if (files.length > 0) parts.push(`Key files:\n${files.join("\n")}`);
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
    const { dirs } = listProjectTreeSync(localPath, { maxDirs: 30, maxFiles: 0 });
    if (dirs.length > 0) projectStructure = `\nProject directories:\n${dirs.join("\n")}`;
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

/** Council ambition tier-up after all criteria met. */
export function buildCouncilAmbitionTierPrompt(args: {
  directive: string;
  missionStatement: string;
  metCriteria: ReadonlyArray<{ description: string; expectedFiles: string[] }>;
  nextTier: number;
  currentTier: number;
  readmeExcerpt?: string | null;
  repoFiles: readonly string[];
}): string {
  const metBlock =
    args.metCriteria.length > 0
      ? args.metCriteria
          .map(
            (c) =>
              `  [✓] ${c.description} — files: ${c.expectedFiles.join(", ") || "(none)"}`,
          )
          .join("\n")
      : "  (none)";
  const readme = args.readmeExcerpt?.trim()
    ? `README excerpt:\n${args.readmeExcerpt}\n`
    : "";
  return [
    "You are the planner for a council of AI engineers. All current criteria are met.",
    "",
    `User directive (the OVERALL goal): "${args.directive}"`,
    "",
    `Current contract mission: "${args.missionStatement}"`,
    "",
    `Met criteria (${args.metCriteria.length}):`,
    metBlock,
    "",
    readme,
    `Project files (${args.repoFiles.length} total):`,
    args.repoFiles.slice(0, 100).join("\n"),
    "",
    `Your task: Propose a NEW set of criteria for tier ${args.nextTier} that ADVANCE the user's directive further.`,
    "",
    "RULES:",
    "1. Every criterion MUST directly serve the user's directive. Do NOT propose unrelated features.",
    "2. Every file path MUST appear in the PROJECT FILES list. Do NOT invent paths.",
    `3. The tier must be MATERIALLY MORE AMBITIOUS than tier ${args.currentTier} — broader scope, deeper work, or capability the prior tier didn't touch.`,
    "4. Do NOT redo what's already met. Focus on what's STILL MISSING from the directive.",
    "5. Think about what gaps remain in the project that prevent the directive from being fully achieved.",
    "6. If you've already added all the panels the directive asks for, broaden scope: code quality, performance, testing, documentation, error handling, accessibility, or other improvements that make the app MORE ROBUST and MORE COMPLETE.",
    "",
    JSON_ONLY_FINAL_RULES,
    "Shape:",
    "{",
    '  "missionStatement": "one-sentence summary of how this tier advances the directive",',
    '  "criteria": [',
    '    {"description": "specific feature that advances the directive", "expectedFiles": ["path/to/file.tsx"]}',
    "  ]",
    "}",
    "",
    "Max 6 criteria. Each must be concrete, verifiable, and directly advance the user's directive.",
  ]
    .filter((line, i, arr) => !(line === "" && arr[i - 1] === ""))
    .join("\n");
}
