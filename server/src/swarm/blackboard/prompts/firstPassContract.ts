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

const CriterionSchema = z.object({
  description: z.string().trim().min(1).max(400),
  expectedFiles: z.array(z.string().trim().min(1)).min(0).max(4),
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
  "7. Maximum 12 criteria. Prefer 3–7 focused criteria over 12 vague ones.",
  "8. Do NOT include implementation detail — criteria are outcomes, not steps. The planner will turn each criterion into todos separately.",
  "",
  "Criteria should be WHAT SUCCESS LOOKS LIKE when this run ends, not a to-do list.",
  "Paths must be relative to the repo root. Never use absolute paths or `..`.",
].join("\n");

export function buildFirstPassContractUserPrompt(seed: PlannerSeed): string {
  const tree = seed.topLevel.length > 0 ? seed.topLevel.join(", ") : "(empty)";
  const readme = seed.readmeExcerpt
    ? seed.readmeExcerpt.slice(0, 4000)
    : "(no README found at repo root)";
  return [
    `Repository: ${seed.repoUrl}`,
    `Clone path: ${seed.clonePath}`,
    `Top-level entries: ${tree}`,
    "",
    "=== README excerpt (first 4000 chars) ===",
    readme,
    "=== end README ===",
    "",
    "Using ONLY the information above, output the exit contract JSON object now.",
    'Remember: single JSON object, no prose, shape {"missionStatement": "...", "criteria": [...]}.',
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
