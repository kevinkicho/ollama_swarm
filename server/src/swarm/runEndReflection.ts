// Task #150: shared end-of-run reflection helper for non-blackboard
// presets. Today only blackboard writes to .swarm-memory.jsonl (#130);
// the 7 discussion presets produce no persistent artifact, so cross-
// preset comparison requires manual transcript reading. This module
// fires one cheap prompt at run-end asking the most-senior agent to
// emit a structured JSON envelope:
//
//   { "score": 1..10,
//     "summary": "one-line meta-comment",
//     "lessons": ["bullet 1", "bullet 2", ...] }
//
// Result: every preset writes a row to .swarm-memory.jsonl, and the
// comparator can rank runs by self-reported score (Option A from the
// earlier discussion — biased but cheap; Option B's third-party judge
// is a follow-up).
//
// Score semantics: 1=run produced no useful output, 5=did its job,
// 10=exceptional insight. The model is asked to be honest, not
// generous.

import type { Agent } from "../services/AgentManager.js";
import {
  appendMemoryEntry,
  type MemoryEntry,
} from "./blackboard/memoryStore.js";
import { extractText } from "./extractText.js";

export interface ReflectionResult {
  score: number;
  summary: string;
  lessons: string[];
}

const MAX_LESSONS = 8;

// Pure parser, exported for tests. Tolerant of fenced JSON and prose-
// then-JSON same as parseMemoryLessons.
export function parseReflectionResponse(text: string): ReflectionResult | null {
  const tryParse = (s: string): unknown => {
    try { return JSON.parse(s.trim()); } catch { return null; }
  };
  let parsed = tryParse(text);
  if (!parsed) {
    const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/i);
    if (fenced) parsed = tryParse(fenced[1]!);
  }
  if (!parsed) {
    const f = text.indexOf("{");
    const l = text.lastIndexOf("}");
    if (f >= 0 && l > f) parsed = tryParse(text.slice(f, l + 1));
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as { score?: unknown; summary?: unknown; lessons?: unknown };
  const scoreNum = typeof obj.score === "number" ? obj.score : Number(obj.score);
  if (!Number.isFinite(scoreNum)) return null;
  const score = Math.max(1, Math.min(10, Math.round(scoreNum)));
  const summary = typeof obj.summary === "string" ? obj.summary.trim().slice(0, 200) : "";
  if (!summary) return null;
  const lessons: string[] = Array.isArray(obj.lessons)
    ? obj.lessons
        .filter((l): l is string => typeof l === "string")
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .slice(0, MAX_LESSONS)
    : [];
  return { score, summary, lessons };
}

export interface ReflectionContext {
  agent: Agent;
  preset: string;
  runId: string;
  clonePath: string;
  // What the run "looked like" — drives the prompt's grounding context.
  // Caller assembles a short stat line; we don't reach into the runner's
  // internals from here.
  contextSummary: string;
  // Caller's logger (each runner has its own appendSystem). Optional.
  log?: (msg: string) => void;
}

// Build the prompt — same shape across all presets; the contextSummary
// the caller passes lets each preset hint at its own structure (council
// emphasizes synthesis convergence; OW emphasizes lead/worker turns;
// etc.) without requiring per-preset prompts.
export function buildReflectionPrompt(preset: string, contextSummary: string): string {
  return [
    `You are doing a brief end-of-run reflection for a "${preset}" swarm preset that just finished.`,
    `This summary will be SAVED for future runs and surfaced in a comparison table — be honest, not generous.`,
    "",
    `Run context:`,
    contextSummary,
    "",
    "Output ONE JSON object only — no fences, no prose:",
    `{"score": <1-10 integer>, "summary": "<one-line meta-comment under 150 chars>", "lessons": ["bullet 1", "bullet 2", ...]}`,
    "",
    "Score rubric:",
    "  1-2 = run produced no useful output (empty turns, parse failures, no actionable findings)",
    "  3-4 = output exists but is shallow / vague / repeats prior material",
    "  5-6 = did the job — produced concrete observations grounded in real files / behaviors",
    "  7-8 = strong run — surfaced a non-obvious finding OR proposed a specific actionable change",
    "  9-10 = exceptional — caught a real bug / proposed a structural insight a human would commit",
    "",
    "Lessons (2-4 typical, max 8): durable bullets that a future run on this same clone should know.",
    "  - One sentence each. Concrete and actionable. \"X file pattern is fragile, prefer Y\" beats \"be careful\".",
    "  - Either AVOIDANCE (\"don't try X — wasted N turns\") or BUILDING (\"the Z scaffold landed is ready for follow-up W\").",
    "",
    "If the run produced nothing memorable, output \"lessons\": [] — a future run will skip the entry.",
  ].join("\n");
}

// Fires the reflection prompt + writes a memory entry. Returns the
// parsed result so the runner can stash score/summary in summary.json
// (caller's responsibility; this module just persists the lesson set).
// Best-effort throughout: any failure logs a warning and returns null;
// run completion is never blocked by reflection.
export async function runEndReflection(
  ctx: ReflectionContext,
): Promise<ReflectionResult | null> {
  const prompt = buildReflectionPrompt(ctx.preset, ctx.contextSummary);
  let responseText: string;
  try {
    const res = await ctx.agent.client.session.prompt({
      sessionID: ctx.agent.sessionId,
      agent: "swarm-read",
      model: { providerID: "ollama", modelID: ctx.agent.model },
      parts: [{ type: "text", text: prompt }],
    });
    responseText = extractText(res) ?? "";
  } catch (err) {
    ctx.log?.(`End-of-run reflection prompt failed (${err instanceof Error ? err.message : String(err)}).`);
    return null;
  }
  if (!responseText) {
    ctx.log?.("End-of-run reflection: model returned empty.");
    return null;
  }
  const parsed = parseReflectionResponse(responseText);
  if (!parsed) {
    ctx.log?.("End-of-run reflection: response did not parse as a {score,summary,lessons} envelope.");
    return null;
  }
  // Write a memory entry. Use commits=0 + tier=0 for non-blackboard
  // presets — the field exists for blackboard's tier-ratchet semantics
  // and isn't meaningful for discussion presets, but the schema requires it.
  if (parsed.lessons.length > 0) {
    const entry: MemoryEntry = {
      ts: Date.now(),
      runId: ctx.runId,
      tier: 0,
      commits: 0,
      lessons: parsed.lessons,
    };
    try {
      const total = await appendMemoryEntry(ctx.clonePath, entry);
      ctx.log?.(`End-of-run reflection: appended ${parsed.lessons.length} lesson(s) (score ${parsed.score}/10) to .swarm-memory.jsonl (${total} entries).`);
    } catch (err) {
      ctx.log?.(`Memory write failed (${err instanceof Error ? err.message : String(err)}); reflection captured but not persisted.`);
    }
  } else {
    ctx.log?.(`End-of-run reflection: score ${parsed.score}/10 — "${parsed.summary}" (no lessons worth persisting).`);
  }
  return parsed;
}
