import { z } from "zod";
import type { ExitCriterion } from "../types.js";

// ---------------------------------------------------------------------------
// Phase 11c: auditor.
//
// Called when the board drains (no open/claimed/stale todos, no pending
// replans). Takes the current contract + recent committed work and decides,
// per unmet criterion, whether it's now "met", "wont-do", or still "unmet"
// (in which case the auditor proposes fresh todos to satisfy it).
//
// Also allowed to add brand-new criteria it discovered during the run. Those
// start "unmet" with no todos — the next audit round (or planner pass) picks
// them up.
// ---------------------------------------------------------------------------

const AuditorTodoSchema = z.object({
  description: z.string().trim().min(1).max(500),
  expectedFiles: z.array(z.string().trim().min(1)).min(1).max(2),
});

const VerdictStatusSchema = z.enum(["met", "wont-do", "unmet"]);

const AuditorVerdictSchema = z.object({
  id: z.string().trim().min(1).max(64),
  status: VerdictStatusSchema,
  rationale: z.string().trim().min(1).max(800),
  todos: z.array(AuditorTodoSchema).max(4).optional(),
});

const AuditorNewCriterionSchema = z.object({
  description: z.string().trim().min(1).max(400),
  expectedFiles: z.array(z.string().trim().min(1)).min(0).max(4),
});

const AuditorResponseSchema = z.object({
  verdicts: z.array(AuditorVerdictSchema).max(20),
  newCriteria: z.array(AuditorNewCriterionSchema).max(8).optional(),
});

export interface AuditorTodo {
  description: string;
  expectedFiles: string[];
}

export interface AuditorVerdict {
  id: string;
  status: "met" | "wont-do" | "unmet";
  rationale: string;
  todos: AuditorTodo[];
}

export interface AuditorNewCriterion {
  description: string;
  expectedFiles: string[];
}

export interface AuditorResult {
  verdicts: AuditorVerdict[];
  newCriteria: AuditorNewCriterion[];
}

export interface AuditorDropped {
  reason: string;
  raw: unknown;
}

export type AuditorParseResult =
  | { ok: true; result: AuditorResult; dropped: AuditorDropped[] }
  | { ok: false; reason: string };

function stripFences(raw: string): string | null {
  const s = raw.trim();
  const fenceMatch = s.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
  if (fenceMatch) return fenceMatch[1].trim();
  const innerFence = s.match(/```(?:json)?\s*\n([\s\S]*?)\n```/i);
  if (innerFence) return innerFence[1].trim();
  const firstBrace = s.indexOf("{");
  const lastBrace = s.lastIndexOf("}");
  if (firstBrace > 0 && lastBrace > firstBrace) {
    return s.slice(firstBrace, lastBrace + 1);
  }
  return null;
}

export function parseAuditorResponse(raw: string): AuditorParseResult {
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
  if (!Array.isArray(envelope.verdicts)) {
    return { ok: false, reason: "verdicts must be an array" };
  }

  const verdicts: AuditorVerdict[] = [];
  const dropped: AuditorDropped[] = [];
  for (const item of envelope.verdicts) {
    const v = AuditorVerdictSchema.safeParse(item);
    if (v.success) {
      verdicts.push({
        id: v.data.id,
        status: v.data.status,
        rationale: v.data.rationale,
        todos: (v.data.todos ?? []).map((t) => ({
          description: t.description,
          expectedFiles: [...t.expectedFiles],
        })),
      });
    } else {
      const reason = v.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
      dropped.push({ reason, raw: item });
    }
  }

  const newCriteria: AuditorNewCriterion[] = [];
  if (envelope.newCriteria !== undefined) {
    if (!Array.isArray(envelope.newCriteria)) {
      return { ok: false, reason: "newCriteria must be an array when present" };
    }
    for (const item of envelope.newCriteria) {
      const v = AuditorNewCriterionSchema.safeParse(item);
      if (v.success) {
        newCriteria.push({
          description: v.data.description,
          expectedFiles: [...v.data.expectedFiles],
        });
      } else {
        const reason = v.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ");
        dropped.push({ reason, raw: item });
      }
    }
  }

  const cap = AuditorResponseSchema.safeParse({
    verdicts,
    newCriteria: newCriteria.length > 0 ? newCriteria : undefined,
  });
  if (!cap.success) {
    const reason = cap.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return { ok: false, reason };
  }

  return { ok: true, result: { verdicts, newCriteria }, dropped };
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

export const AUDITOR_SYSTEM_PROMPT = [
  "You are the AUDITOR for a swarm of coding agents.",
  "You are called at a checkpoint: the worker pool has drained (no todos left in flight). Your job is to decide whether the EXIT CONTRACT is satisfied.",
  "",
  "For each UNMET criterion, issue one of these verdicts:",
  "  - \"met\":      the committed work satisfies this criterion. Include a rationale pointing to the change.",
  "  - \"wont-do\":  this criterion is out of scope, already handled, or not worth pursuing. Include a rationale.",
  "  - \"unmet\":    criterion still needs work. MUST include 1–4 concrete todos under `todos` that, if committed, would satisfy it.",
  "",
  "You MAY add new criteria via `newCriteria` when you discover important outcomes the initial contract missed. New criteria start with no todos — future audits can propose todos for them.",
  "",
  "HARD RULES:",
  "1. Output ONLY a single JSON object. No prose. No markdown fences. No commentary.",
  "2. Shape: {\"verdicts\": [{\"id\": string, \"status\": \"met\"|\"wont-do\"|\"unmet\", \"rationale\": string, \"todos\"?: [...]}], \"newCriteria\"?: [{\"description\": string, \"expectedFiles\": string[]}]}.",
  "3. Every verdict's `id` MUST match an existing unmet criterion ID (c1, c2, ...). Do NOT include verdicts for criteria that are already met or wont-do.",
  "4. For `unmet` status, `todos` is REQUIRED and must contain 1–4 items; each todo names ≤2 expectedFiles (repo-relative paths).",
  "5. Each verdict's `rationale` is one sentence explaining the call.",
  "6. Each `newCriteria` item's `description` is one outcome (not a step). `expectedFiles` is 0–4 repo-relative paths.",
  "7. Prefer `wont-do` with a clear rationale over infinite `unmet` loops. If prior todos for a criterion failed (stale/skipped), consider whether the criterion is practical at all.",
  "",
  "Paths must be repo-relative. Never use absolute paths or `..`.",
].join("\n");

export interface CommittedTodoSummary {
  todoId: string;
  description: string;
  expectedFiles: string[];
  committedAt?: number;
}

export interface SkippedTodoSummary {
  todoId: string;
  description: string;
  skippedReason?: string;
}

export interface FindingSummary {
  agentId: string;
  text: string;
  createdAt: number;
}

export interface AuditorSeed {
  missionStatement: string;
  unmetCriteria: ExitCriterion[];
  resolvedCriteria: ExitCriterion[];
  committed: CommittedTodoSummary[];
  skipped: SkippedTodoSummary[];
  findings: FindingSummary[];
  auditInvocation: number;
  maxInvocations: number;
}

const MAX_CONTEXT_ITEMS = 40;

export function buildAuditorUserPrompt(seed: AuditorSeed): string {
  const committed = seed.committed
    .slice(-MAX_CONTEXT_ITEMS)
    .map((c) => `- [${c.todoId}] ${c.description} (files: ${c.expectedFiles.join(", ") || "none"})`)
    .join("\n");
  const skipped = seed.skipped
    .slice(-MAX_CONTEXT_ITEMS)
    .map((s) => `- [${s.todoId}] ${s.description}${s.skippedReason ? ` — ${s.skippedReason}` : ""}`)
    .join("\n");
  const findings = seed.findings
    .slice(-MAX_CONTEXT_ITEMS)
    .map((f) => `- [${f.agentId}] ${f.text}`)
    .join("\n");
  const resolved = seed.resolvedCriteria
    .map((c) => `- [${c.id}] (${c.status}) ${c.description}${c.rationale ? ` — ${c.rationale}` : ""}`)
    .join("\n");
  const unmet = seed.unmetCriteria
    .map(
      (c) =>
        `- [${c.id}] ${c.description} (expectedFiles: ${
          c.expectedFiles.length > 0 ? c.expectedFiles.join(", ") : "none"
        })`,
    )
    .join("\n");

  return [
    `Mission: ${seed.missionStatement}`,
    `Audit invocation: ${seed.auditInvocation} of ${seed.maxInvocations} (hard cap).`,
    "",
    "=== Criteria that still need a verdict (UNMET) ===",
    unmet.length > 0 ? unmet : "(none — all criteria already resolved)",
    "",
    "=== Criteria already resolved (for context only; do NOT re-verdict) ===",
    resolved.length > 0 ? resolved : "(none)",
    "",
    "=== Committed todos (most recent first, up to 40) ===",
    committed.length > 0 ? committed : "(nothing committed yet)",
    "",
    "=== Skipped todos (most recent first, up to 40) ===",
    skipped.length > 0 ? skipped : "(no skips)",
    "",
    "=== Agent findings (up to 40) ===",
    findings.length > 0 ? findings : "(no findings recorded)",
    "",
    "Respond now with ONLY the JSON envelope. No prose, no fences.",
    "Shape reminder: {\"verdicts\": [...], \"newCriteria\"?: [...]}.",
  ].join("\n");
}

export function buildAuditorRepairPrompt(previousResponse: string, parseError: string): string {
  return [
    "Your previous response could not be parsed as the required JSON envelope.",
    `Parser error: ${parseError}`,
    "",
    "Your previous response was:",
    "--- BEGIN PREVIOUS RESPONSE ---",
    previousResponse,
    "--- END PREVIOUS RESPONSE ---",
    "",
    "Respond now with ONLY a JSON object matching the schema:",
    '{"verdicts":[{"id":"c1","status":"met|wont-do|unmet","rationale":"...","todos":[{"description":"...","expectedFiles":["..."]}]}],"newCriteria":[{"description":"...","expectedFiles":["..."]}]}',
    "",
    "No prose. No markdown fences. No commentary. Just the JSON object.",
  ].join("\n");
}
