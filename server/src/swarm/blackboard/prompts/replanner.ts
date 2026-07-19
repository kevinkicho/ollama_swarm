import { z } from "zod";
import { parseJsonEnvelope } from "@ollama-swarm/shared/parseAgentJson";
import { lenientPreprocess } from "./lenientParse.js";
import { windowFileWithAnchors, WORKER_FILE_WINDOW_THRESHOLD } from "../windowFile.js";
import { buildExplorationCacheBlock } from "@ollama-swarm/shared/explorationCache";
import type { ExplorationCacheEntry } from "@ollama-swarm/shared/explorationCache";
import { buildBlackboardDirectiveBlock } from "../../directivePromptHelpers.js";
import { JSON_ONLY_FINAL_RULE_LINES } from "./sharedSnippets.js";

// ---------------------------------------------------------------------------
// Schema. The replanner is shown a stale TODO + current file state and must
// produce ONE of two shapes:
//
//   Revise: { "revised": { "description": string, "expectedFiles": string[] } }
//   Skip:   { "skip": true, "reason": string }
//
// We keep the two branches distinct (not a single object with optional fields)
// so the model has to commit to one intent. A mixed response is rejected by
// the union match below.
// ---------------------------------------------------------------------------

// File paths only — see planner.ts for the motivating incident. Replanner
// output replaces a stale todo's expectedFiles, so the same rule applies.
const filePathEntry = z
  .string()
  .trim()
  .min(1)
  .refine((p) => !p.endsWith("/") && !p.endsWith("\\"), {
    message: "must be a file path, not a directory (no trailing / or \\)",
  });

// Unit 44b: same anchor schema as planner.ts. Replanner can revise the
// anchor set when the original anchors didn't match the post-drift
// file. Keep the cap shape identical so prompts stay parallel.
const REPLAN_ANCHOR_MAX_CHARS = 200;
const REPLAN_ANCHOR_MAX_PER_TODO = 4;
const replanAnchorEntry = z.string().trim().min(1).max(REPLAN_ANCHOR_MAX_CHARS);

// #241 (2026-04-28): replanner can now revise to or from kind:"build".
// Same discriminator as PlannerTodoSchema. When kind="build", `command`
// is required. Default (omitted) is "hunks" for backward compat — old
// replanner runs without the new field still parse cleanly.
const RevisedBody = z.union([
  z.object({
    kind: z.literal("hunks").optional(),
    description: z.string().trim().min(1).max(500),
    expectedFiles: z.array(filePathEntry).min(1).max(2),
    expectedAnchors: z.array(replanAnchorEntry).max(REPLAN_ANCHOR_MAX_PER_TODO).optional(),
    command: z.undefined().optional(),
    contextFiles: z.array(filePathEntry).max(3).optional(),
  }),
  z.object({
    kind: z.literal("build"),
    description: z.string().trim().min(1).max(500),
    expectedFiles: z.array(filePathEntry).min(1).max(2),
    command: z.string().trim().min(1).max(500),
    expectedAnchors: z.array(replanAnchorEntry).max(REPLAN_ANCHOR_MAX_PER_TODO).optional(),
    contextFiles: z.array(filePathEntry).max(3).optional(),
  }),
]);

const RevisedSchema = z.object({ revised: RevisedBody });
const SkipSchema = z.object({
  skip: z.literal(true),
  reason: z.string().trim().min(1).max(500),
});

export const ReplannerResponseSchema = z.union([RevisedSchema, SkipSchema]);

export type ReplannerParseResult =
  | {
      ok: true;
      action: "revised";
      kind?: "hunks" | "build";
      command?: string;
      description: string;
      expectedFiles: string[];
      expectedAnchors?: string[];
      contextFiles?: string[];
    }
  | { ok: true; action: "skip"; reason: string }
  | { ok: false; reason: string };

export function parseReplannerResponse(raw: string): ReplannerParseResult {
  if (raw.trim().length === 0) {
    return { ok: false, reason: "empty response — model produced no output after stripping thinking tags" };
  }
  const envelopeResult = parseJsonEnvelope(raw);
  if (!envelopeResult.ok) {
    return { ok: false, reason: envelopeResult.reason };
  }
  const parsed = envelopeResult.value;

  if (Array.isArray(parsed)) {
    return { ok: false, reason: "expected top-level JSON object, got array" };
  }

  const processed = lenientPreprocess(parsed, {
    maxDescription: 500,
    maxExpectedFiles: 2,
    maxExpectedAnchors: REPLAN_ANCHOR_MAX_PER_TODO,
    maxCommand: 500,
  });
  const v = ReplannerResponseSchema.safeParse(processed);
  if (!v.success) {
    const reason = v.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return { ok: false, reason };
  }

  if ("revised" in v.data) {
    const isBuild = v.data.revised.kind === "build";
    return {
      ok: true,
      action: "revised",
      kind: v.data.revised.kind ?? "hunks",
      ...(isBuild ? { command: v.data.revised.command } : {}),
      description: v.data.revised.description,
      expectedFiles: [...v.data.revised.expectedFiles],
      expectedAnchors: v.data.revised.expectedAnchors
        ? [...v.data.revised.expectedAnchors]
        : undefined,
      contextFiles: v.data.revised.contextFiles
        ? [...v.data.revised.contextFiles]
        : undefined,
    };
  }
  return { ok: true, action: "skip", reason: v.data.reason };
}

// ---------------------------------------------------------------------------
// Prompts. The planner agent is reused with a different prompt — see
// docs/known-limitations.md for why there is no dedicated replanner agent.
// ---------------------------------------------------------------------------

export const REPLANNER_SYSTEM_PROMPT = [
  "You are the REPLANNER. A TODO went STALE; revise it for the current files or skip it.",
  "",
  "TOOLS: read, grep, glob, list — use especially after CAS/hunk-apply failures so the revision matches NEW file state.",
  "",
  "RULES:",
  "1. Final response:",
  ...JSON_ONLY_FINAL_RULE_LINES.map((line) => `   ${line}`),
  "2. Exactly one of: {\"revised\":{\"description\",\"expectedFiles\", optional kind/command/expectedAnchors}} OR {\"skip\":true,\"reason\"}.",
  "3. description: one imperative sentence. expectedFiles: 1–2 FILE paths (repo-relative).",
  "4. Optional kind:\"build\" + command when a project script is the right fix (default hunks).",
  "5. Optional expectedAnchors for middle-of-large-file targets.",
  "SKIP if already satisfied, obsolete, or same failure would recur. REVISE with smaller scope when still needed.",
  "Auditor-stale reasons: treat auditor rationale as given; decide keep/revise vs discard, do not re-litigate the worker.",
].join("\n");

export interface ReplannerSeed {
  todoId: string;
  originalDescription: string;
  originalExpectedFiles: string[];
  staleReason: string;
  // null = file does not exist on disk right now.
  fileContents: Record<string, string | null>;
  replanCount: number;
  /** Auto-detected anchors from todo description (for large files) */
  autoAnchors?: string[];
  /** Directive + steer amendments (mid-run nudges). */
  userDirective?: string;
  /** Mid-run suggest/ask messages from user chat. */
  userChatBlock?: string;
  /** Prior planning explore briefs — avoid broad repo re-tours during replan. */
  explorationCache?: readonly ExplorationCacheEntry[];
  /**
   * Disk tab inventory for multi-tab HTML — ground truth so replan does not
   * re-mint "add tabs that already exist" or invent wrong counts.
   */
  tabInventoryBlock?: string;
}

export function buildReplannerUserPrompt(seed: ReplannerSeed): string {
  const parts: string[] = [];
  const directiveLines = buildBlackboardDirectiveBlock(seed.userDirective, {
    labelSuffix: "(includes any mid-run steer nudges)",
    authoritative: true,
  });
  if (directiveLines.length > 0) {
    parts.push(...directiveLines);
  }
  if (seed.userChatBlock && seed.userChatBlock.trim().length > 0) {
    parts.push(seed.userChatBlock.trim(), "");
  }
  const explorationBlock = buildExplorationCacheBlock(
    seed.explorationCache ? [...seed.explorationCache] : undefined,
  );
  if (explorationBlock) parts.push(explorationBlock);
  parts.push(
    `Stale TODO id: ${seed.todoId}`,
    `Original description: ${seed.originalDescription}`,
    `Original expected files: ${seed.originalExpectedFiles.join(", ")}`,
    `Stale reason: ${seed.staleReason}`,
    `Prior replan attempts: ${seed.replanCount}`,
    "",
  );
  if (seed.tabInventoryBlock && seed.tabInventoryBlock.trim().length > 0) {
    parts.push(seed.tabInventoryBlock.trim());
    parts.push(
      "When revising: only ask for topics NOT already listed above. " +
        "If every requested topic is already on disk, prefer {\"skip\":true,...}.",
    );
    parts.push("");
  }
  if (seed.autoAnchors && seed.autoAnchors.length > 0) {
    parts.push(`Auto-detected anchors from description: ${seed.autoAnchors.join(", ")}`);
    parts.push("(These sections exist in the file — use them as context for your revision)");
    parts.push("");
  }
  for (const f of seed.originalExpectedFiles) {
    const content = seed.fileContents[f];
    if (content === null || content === undefined) {
      parts.push(`=== ${f} (does not exist on disk right now) ===`);
    } else if (seed.autoAnchors && seed.autoAnchors.length > 0 && content.length > WORKER_FILE_WINDOW_THRESHOLD) {
      // For large files with auto-anchors, use windowed view with anchors
      const anchored = windowFileWithAnchors(content, seed.autoAnchors);
      const reportSummary = anchored.anchorReports
        .map((r) => `${JSON.stringify(r.anchor)}=${r.found === null ? "MISS" : `line ${r.found}`}`)
        .join(", ");
      parts.push(`=== Current contents of ${f} (${content.length} chars, ANCHORED) [anchors: ${reportSummary}] ===`);
      parts.push(anchored.content);
      parts.push(`=== end ${f} ===`);
    } else {
      parts.push(`=== Current contents of ${f} ===`);
      parts.push(content);
      parts.push(`=== end ${f} ===`);
    }
    parts.push("");
  }
  parts.push("Output your JSON object now. Remember: one shape only, no prose, <=2 files if revising.");
  return parts.join("\n");
}

export function buildReplannerFullPrompt(seed: ReplannerSeed): string {
  return `${REPLANNER_SYSTEM_PROMPT}\n\n${buildReplannerUserPrompt(seed)}`;
}

export function buildReplannerRepairFullPrompt(
  seed: ReplannerSeed,
  previousResponse: string,
  parseError: string,
): string {
  return [
    buildReplannerFullPrompt(seed),
    "",
    buildReplannerRepairPrompt(previousResponse, parseError),
  ].join("\n");
}

/** Stale-reason-specific guidance appended to replanner system prompt. */
export function buildReplanPolicyGuidance(policy: {
  emitFirst: boolean;
  staleClass: string;
}): string {
  if (policy.emitFirst) {
    return [
      "REPLAN POLICY (worker timeout / tool-cap):",
      "The prior worker already toured the repo and failed to emit JSON.",
      "Do NOT call read/grep/glob/list — revise or skip from the TODO + file state below.",
      "Output exactly one JSON object now.",
      "",
    ].join("\n");
  }
  if (policy.staleClass === "cas-drift" || policy.staleClass === "hunk-fail") {
    return [
      "REPLAN POLICY (CAS / hunk drift):",
      "Use tools sparingly (≤4 calls) to read files that changed while the TODO was in flight.",
      "",
    ].join("\n");
  }
  return "";
}

export function buildReplannerRepairPrompt(previousResponse: string, parseError: string): string {
  return [
    "Your previous response could not be parsed as the required JSON object.",
    `Parser error: ${parseError}`,
    "",
    "Your previous response was:",
    "--- BEGIN PREVIOUS RESPONSE ---",
    previousResponse,
    "--- END PREVIOUS RESPONSE ---",
    "",
    "Respond now with ONLY a JSON object matching one of:",
    '  {"revised": {"description": "one sentence", "expectedFiles": ["path1"]}}',
    '  {"skip": true, "reason": "why this is no longer worth doing"}',
    "",
    "No prose. No markdown fences. No commentary. Just the JSON object.",
  ].join("\n");
}
