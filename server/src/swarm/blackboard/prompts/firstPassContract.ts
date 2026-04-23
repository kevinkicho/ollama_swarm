import { z } from "zod";
import type { PlannerSeed } from "./planner.js";

// ---------------------------------------------------------------------------
// Phase 11b: first-pass exit contract.
//
// Before the normal planner posts todos, we ask the same planner agent for an
// ExitContract — a mission statement plus a list of concrete criteria that
// define "done" for this run. Each criterion names expectedFiles the same way
// todos do, so downstream phases (11c auditor) can check "did any commit touch
// those files?" as a coarse satisfaction signal.
//
// Phase 11b only emits the contract and broadcasts it to the UI. It does NOT
// yet gate termination on it — the run still exits when the board drains.
// That gating lands in 11c.
// ---------------------------------------------------------------------------

// File paths only — see planner.ts for the motivating incident. Contract
// criteria feed the auditor, which reads/diffs expectedFiles to check "did
// any commit touch those files?"; a directory entry breaks that coarse check.
const filePathEntry = z
  .string()
  .trim()
  .min(1)
  .refine((p) => !p.endsWith("/") && !p.endsWith("\\"), {
    message: "must be a file path, not a directory (no trailing / or \\)",
  });

const CriterionSchema = z.object({
  description: z.string().trim().min(1).max(400),
  expectedFiles: z.array(filePathEntry).min(0).max(4),
});

// Contract envelope. missionStatement is the one-line framing; criteria is the
// bounded list (planner-side cap of 12 keeps LLMs from over-decomposing).
const ContractSchema = z.object({
  missionStatement: z.string().trim().min(1).max(500),
  criteria: z.array(CriterionSchema).min(0).max(12),
});

export interface ParsedCriterion {
  description: string;
  expectedFiles: string[];
}

export interface ParsedContract {
  missionStatement: string;
  criteria: ParsedCriterion[];
}

export interface ContractDropped {
  reason: string;
  raw: unknown;
}

export type ContractParseResult =
  | { ok: true; contract: ParsedContract; dropped: ContractDropped[] }
  | { ok: false; reason: string };

// Planners tend to wrap JSON in ```json fences or prose ("Here is the
// contract: {...}"). Try progressively looser extraction only if the raw
// text fails straight-up JSON.parse. Extracts object, not array — the
// contract is a top-level object.
function stripFences(raw: string): string | null {
  const s = raw.trim();
  const fenceMatch = s.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
  if (fenceMatch) return fenceMatch[1].trim();
  const innerFence = s.match(/```(?:json)?\s*\n([\s\S]*?)\n```/i);
  if (innerFence) return innerFence[1].trim();
  // Prose-then-object: slice between first `{` and last `}`. Only meaningful
  // when prose prefixes the brace (firstBrace > 0).
  const firstBrace = s.indexOf("{");
  const lastBrace = s.lastIndexOf("}");
  if (firstBrace > 0 && lastBrace > firstBrace) {
    return s.slice(firstBrace, lastBrace + 1);
  }
  return null;
}

export function parseFirstPassContractResponse(raw: string): ContractParseResult {
  let parsed: unknown;
  let lastError = "";
  try {
    parsed = JSON.parse(raw.trim());
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    const cleaned = stripFences(raw);
    if (cleaned === null) {
      return { ok: false, reason: `JSON parse failed: ${lastError}` };
    }
    try {
      parsed = JSON.parse(cleaned);
    } catch (err2) {
      const msg = err2 instanceof Error ? err2.message : String(err2);
      return { ok: false, reason: `JSON parse failed: ${msg}` };
    }
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      reason: `expected top-level JSON object, got ${Array.isArray(parsed) ? "array" : typeof parsed}`,
    };
  }

  const envelope = parsed as Record<string, unknown>;
  const missionRaw = envelope.missionStatement;
  if (typeof missionRaw !== "string" || missionRaw.trim().length === 0) {
    return { ok: false, reason: "missionStatement missing or empty" };
  }
  if (!Array.isArray(envelope.criteria)) {
    return { ok: false, reason: "criteria must be an array" };
  }

  const criteria: ParsedCriterion[] = [];
  const dropped: ContractDropped[] = [];
  for (const item of envelope.criteria) {
    const v = CriterionSchema.safeParse(item);
    if (v.success) {
      criteria.push({ description: v.data.description, expectedFiles: v.data.expectedFiles });
    } else {
      const reason = v.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
      dropped.push({ reason, raw: item });
    }
  }

  // Validate the envelope AFTER per-item filtering, so a single junk criterion
  // doesn't poison the whole contract.
  const capResult = ContractSchema.safeParse({
    missionStatement: missionRaw.trim(),
    criteria,
  });
  if (!capResult.success) {
    const reason = capResult.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return { ok: false, reason };
  }

  return {
    ok: true,
    contract: {
      missionStatement: capResult.data.missionStatement,
      criteria: capResult.data.criteria.map((c) => ({
        description: c.description,
        expectedFiles: [...c.expectedFiles],
      })),
    },
    dropped,
  };
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

export const FIRST_PASS_CONTRACT_SYSTEM_PROMPT = [
  "You are the PLANNER for a swarm of coding agents working on a cloned repository.",
  "Before you hand out work, write an EXIT CONTRACT — a short mission statement plus the specific criteria that will count as 'done' for this run.",
  "",
  "HARD RULES:",
  "1. Output ONLY a single JSON object. No prose. No markdown fences. No commentary before or after.",
  "2. The object MUST have shape: {\"missionStatement\": string, \"criteria\": Array<{\"description\": string, \"expectedFiles\": string[]}>}.",
  "3. `missionStatement` is one sentence describing the purpose of this run (e.g., \"Document the public API and add a contributor guide.\").",
  "4. Each criterion's `description` is one imperative sentence naming an observable, checkable outcome (e.g., \"README has a Quick Start section with runnable example.\").",
  "5. Each criterion's `expectedFiles` lists 0–4 repo-relative paths that the criterion's satisfying change is expected to touch. Use [] only when the outcome is non-file (e.g., a test passes).",
  "6. Do NOT invent files that do not plausibly exist or plausibly need to be created.",
  "7. Maximum 20 criteria. Prefer 3–7 focused criteria for small scoped missions, 10–20 when the user's directive is ambitious (Rule 11 below).",
  "8. Do NOT include implementation detail — criteria are outcomes, not steps. The planner will turn each criterion into todos separately.",
  "9. `expectedFiles` entries are FILE paths, never directories. Do NOT emit `src/`, `__tests__/`, `docs/`, or any path ending in `/` or `\\`. If you don't know which specific file the criterion will land in, prefer an empty `expectedFiles: []` over a guessed directory — the planner will bind real paths after its own read pass. Directory entries are rejected by the parser and the criterion is dropped.",
  "10. When `expectedFiles` is non-empty, ground every entry in the REPO FILE LIST provided in the user message. Each entry MUST either (a) appear verbatim in the list (for edits to existing files), or (b) be a new file whose parent directory appears in the list (for criteria that demand a new file at a known location). When unsure, prefer `expectedFiles: []` — the auditor has a linked-commit fallback that will bind real files from later todo activity.",
  "11. USER DIRECTIVE (Unit 25): if the user message contains a `USER DIRECTIVE` block, that directive is AUTHORITATIVE. Your `missionStatement` MUST be shaped to deliver what the directive asks for; your `criteria` list MUST cover every distinct outcome the directive names (up to the 20-criterion cap). Do NOT substitute your own judgment about what the repo \"needs\" for what the directive explicitly requests. Generate as many criteria as needed to comprehensively address the directive — prefer more (up to 20) over fewer when the directive is broad. When the directive is absent, fall back to your own read of repo gaps as usual.",
  "",
  "Criteria should be WHAT SUCCESS LOOKS LIKE when this run ends, not a to-do list.",
  "Paths must be relative to the repo root. Never use absolute paths or `..`.",
].join("\n");

export function buildFirstPassContractUserPrompt(seed: PlannerSeed): string {
  const tree = seed.topLevel.length > 0 ? seed.topLevel.join(", ") : "(empty)";
  const readme = seed.readmeExcerpt
    ? seed.readmeExcerpt.slice(0, 4000)
    : "(no README found at repo root)";
  // Grounding Unit 6a: shared with buildPlannerUserPrompt so contract criteria
  // name real paths the auditor can later check. Empty-state copy matches the
  // planner prompt verbatim to avoid two slightly-different fallback strings.
  const fileList = seed.repoFiles.length > 0
    ? seed.repoFiles.join("\n")
    : "(no files listed — clone may be unreadable; use top-level entries above as a weaker guide)";
  // Unit 25: if the user supplied a directive, put it FIRST in the user
  // prompt so the planner reads it before it reads the repo structure.
  // The system prompt's Rule 11 tells the planner this block is
  // authoritative. When the directive is absent, the prompt is
  // bit-for-bit identical to the pre-Unit-25 shape.
  const directive = seed.userDirective?.trim();
  const directiveBlock = directive
    ? [
        "=== USER DIRECTIVE (AUTHORITATIVE — see Rule 11) ===",
        directive,
        "=== end USER DIRECTIVE ===",
        "",
      ]
    : [];
  return [
    ...directiveBlock,
    `Repository: ${seed.repoUrl}`,
    `Clone path: ${seed.clonePath}`,
    `Top-level entries: ${tree}`,
    "",
    "=== REPO FILE LIST (up to 150 paths, BFS order, ignores applied) ===",
    fileList,
    "=== end REPO FILE LIST ===",
    "",
    "=== README excerpt (first 4000 chars) ===",
    readme,
    "=== end README ===",
    "",
    directive
      ? "Output the exit contract JSON object now. Your missionStatement and criteria MUST address the USER DIRECTIVE above (Rule 11). Use the REPO FILE LIST to ground expectedFiles."
      : "Using ONLY the information above, output the exit contract JSON object now.",
    'Remember: single JSON object, no prose, shape {"missionStatement": "...", "criteria": [...]}. When expectedFiles is non-empty, prefer paths that appear in the REPO FILE LIST; if a criterion implies a new file, its parent directory should appear there.',
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Unit 30: council-style initial contract.
//
// Opt-in via COUNCIL_CONTRACT_ENABLED. When enabled, every agent in the
// swarm produces a first-pass contract DRAFT independently from the same
// seed (parallel, peer-hidden, same prompt as the single-agent path).
// Then the planner sees every draft and produces the final authoritative
// contract via buildCouncilContractMergePrompt. The merge prompt reuses
// the seed's grounding material (REPO FILE LIST, README excerpt, user
// directive) so merge decisions can still be grounded in real repo
// structure rather than just averaged across drafts.
//
// Draft shape matches ParsedContract (the same shape
// parseFirstPassContractResponse emits). Each draft is tagged with its
// producing agent's id so the merge prompt can cite who proposed what.
// ---------------------------------------------------------------------------

export interface CouncilContractDraft {
  agentId: string;
  contract: ParsedContract;
}

export function buildCouncilContractMergePrompt(
  seed: PlannerSeed,
  drafts: readonly CouncilContractDraft[],
): string {
  const draftBlocks = drafts
    .map((d, i) => {
      const criteriaList = d.contract.criteria
        .map((c, ci) => {
          const files = c.expectedFiles.length > 0
            ? c.expectedFiles.join(", ")
            : "(none)";
          return `    ${ci + 1}. ${c.description}  [expectedFiles: ${files}]`;
        })
        .join("\n");
      return [
        `=== Draft ${i + 1} — by ${d.agentId} ===`,
        `missionStatement: ${d.contract.missionStatement}`,
        `criteria (${d.contract.criteria.length}):`,
        criteriaList.length > 0 ? criteriaList : "    (none)",
        `=== end Draft ${i + 1} ===`,
      ].join("\n");
    })
    .join("\n\n");

  const fileList = seed.repoFiles.length > 0
    ? seed.repoFiles.join("\n")
    : "(no files listed — clone may be unreadable)";
  const readme = seed.readmeExcerpt
    ? seed.readmeExcerpt.slice(0, 2000)
    : "(no README found at repo root)";

  const directive = seed.userDirective?.trim();
  const directiveBlock = directive
    ? [
        "=== USER DIRECTIVE (AUTHORITATIVE — see Rule 11) ===",
        directive,
        "=== end USER DIRECTIVE ===",
        "",
      ]
    : [];

  return [
    ...directiveBlock,
    `Repository: ${seed.repoUrl}`,
    `Clone path: ${seed.clonePath}`,
    "",
    `You are the PLANNER. ${drafts.length} agents (including you) each drafted an EXIT CONTRACT for this run INDEPENDENTLY — none of them saw each other's drafts. Your task NOW is to MERGE their drafts into ONE authoritative contract that this run will be audited against.`,
    "",
    "=== DRAFTS ===",
    draftBlocks,
    "=== end DRAFTS ===",
    "",
    "=== REPO FILE LIST (for grounding expectedFiles) ===",
    fileList,
    "=== end REPO FILE LIST ===",
    "",
    "=== README excerpt (first 2000 chars) ===",
    readme,
    "=== end README ===",
    "",
    "MERGE RULES:",
    "1. Output ONLY a single JSON object of shape {\"missionStatement\": string, \"criteria\": [...]}. No prose, no fences.",
    "2. `missionStatement`: pick the clearest wording across the drafts, or synthesize a sharper one. One sentence.",
    "3. `criteria`: UNION the distinct outcomes across drafts. DEDUPE criteria that express the same outcome in different wording — pick the clearest phrasing and keep it once. Prefer SPECIFIC over VAGUE.",
    "4. For each criterion's `expectedFiles`: when drafts disagree on paths, pick paths grounded in the REPO FILE LIST; when unsure, default to `[]` (the auditor's linked-commit fallback will rebind from later work).",
    "5. Maximum 20 criteria. If drafts collectively propose more, pick the most important, specific, and repo-grounded ones.",
    "6. `expectedFiles` entries are FILE paths, never directories. No trailing `/` or `\\`.",
    directive
      ? "7. USER DIRECTIVE (above) is AUTHORITATIVE. The merged `missionStatement` and `criteria` MUST address every distinct outcome the directive names, regardless of whether individual drafts missed any."
      : "7. No user directive this run — merge based on the drafts and repo alone.",
    "",
    "Output the merged JSON object now.",
  ].join("\n");
}

export function buildFirstPassContractRepairPrompt(
  previousResponse: string,
  parseError: string,
): string {
  return [
    "Your previous response could not be parsed as the required JSON object.",
    `Parser error: ${parseError}`,
    "",
    "Your previous response was:",
    "--- BEGIN PREVIOUS RESPONSE ---",
    previousResponse,
    "--- END PREVIOUS RESPONSE ---",
    "",
    "Respond now with ONLY a JSON object matching the schema:",
    '{"missionStatement": "one sentence", "criteria": [{"description": "one sentence", "expectedFiles": ["path1"]}, ...]}',
    "",
    "No prose. No markdown fences. No commentary. Just the JSON object.",
  ].join("\n");
}
