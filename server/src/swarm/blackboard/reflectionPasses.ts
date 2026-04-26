// Task #164 (refactor): post-completion reflection passes — extracted
// from BlackboardRunner.ts as the first slice of the 4209-LOC split.
//
// Two passes fire at run-end (after final audit, before writeRunSummary):
//
//   - runStretchGoalReflectionPass (#129): asks the planner what a
//     more ambitious version of this work would have done. Result
//     surfaced as a `stretch_goals` transcript-summary entry.
//
//   - runMemoryDistillationPass (#130): asks the planner for 2-4
//     lessons-learned bullets. Appended to <clone>/.swarm-memory.jsonl
//     for next-run hydration.
//
// Both are best-effort — failures append a system note and return,
// never throwing into the runner's finally chain.

import { randomUUID } from "node:crypto";
import type { Agent } from "../../services/AgentManager.js";
import type {
  TranscriptEntry,
  TranscriptEntrySummary,
  SwarmEvent,
} from "../../types.js";
import type { ExitContract } from "./types.js";
import { extractText } from "../extractText.js";
import {
  appendMemoryEntry,
  parseMemoryLessons,
  type MemoryEntry,
} from "./memoryStore.js";
import { parseGoalList } from "./goalListParser.js";

// Bundle of runner state the passes need. Deliberately narrow — only
// the fields these passes actually touch — so future refactors of the
// runner can rearrange internals without reaching back into here.
export interface ReflectionContext {
  /** Mutated: the pass appends an `agent` entry on success. */
  transcript: TranscriptEntry[];
  /** Called for status/system lines. */
  appendSystem: (text: string, summary?: TranscriptEntrySummary) => void;
  /** Used to broadcast the new agent entry. */
  emit: (e: SwarmEvent) => void;
  /** Current ambition tier (for the stretch summary entry's tier field). */
  currentTier: number;
  /** Total commits landed across the run (for the stretch summary entry). */
  committedCount: number;
  /** Final contract criteria (with status), used to prompt-ground both
   *  passes. Empty list when no contract on file. */
  contractCriteria: ExitContract["criteria"];
  /** App-level run id for the memory entry's runId field. */
  runId: string;
}

export async function runStretchGoalReflectionPass(
  planner: Agent,
  ctx: ReflectionContext,
): Promise<void> {
  ctx.appendSystem(
    "Stretch-goal reflection: asking planner what a more ambitious version would have done…",
  );
  const tier = ctx.currentTier;
  const committed = ctx.committedCount;
  const prompt = [
    "You are a senior engineer doing a post-mortem on a swarm run that just COMPLETED on this repo.",
    `Tier reached: ${tier}`,
    `Commits made: ${committed}`,
    "",
    ctx.contractCriteria.length > 0
      ? `=== Contract criteria the swarm worked on ===\n${ctx.contractCriteria
          .map((c, i) => `${i + 1}. [${c.status}] ${c.description}`)
          .join("\n")}\n=== END ===`
      : "(no contract on file)",
    "",
    "The swarm finished its scoped work. Your job is to look UP — not at what was done, but at what a more ambitious version of this work would have tackled INSTEAD or ADDITIONALLY.",
    "",
    "Propose 3-5 STRETCH goals ranked by impact. Each:",
    "- 1 sentence describing the goal.",
    "- Cites 1-3 file paths in the repo where the work would land.",
    "- Says explicitly what the COMPLETED contract MISSED, RAN OUT OF TIME ON, or DELIBERATELY CHOSE NOT to attempt.",
    "",
    "Avoid: praising what was done; trivia (typo fixes, doc-only edits); restating the existing criteria. Favor: structural changes, new capabilities, harder correctness invariants, and changes that the run was 'one tier away' from being able to commit to.",
    "",
    "Output format:",
    "1. [TITLE] - one-sentence description (files: a/b.ts, c.ts) — Stretch because X.",
    "2. ...",
  ].join("\n");

  try {
    const res = await planner.client.session.prompt({
      path: { id: planner.sessionId },
      body: {
        agent: "swarm-read",
        model: { providerID: "ollama", modelID: planner.model },
        parts: [{ type: "text", text: prompt }],
      },
    });
    const text = extractText(res);
    if (!text) {
      ctx.appendSystem("Stretch-goal reflection: planner returned empty.");
      return;
    }
    const goals = parseGoalList(text);
    if (goals.length === 0) {
      ctx.appendSystem(
        "Stretch-goal reflection: planner response did not contain a parseable goal list.",
      );
      return;
    }
    const entry: TranscriptEntry = {
      id: randomUUID(),
      role: "agent",
      agentId: planner.id,
      agentIndex: planner.index,
      text,
      ts: Date.now(),
      summary: { kind: "stretch_goals", goals: goals.slice(0, 5), tier, committed },
    };
    ctx.transcript.push(entry);
    ctx.emit({ type: "transcript_append", entry });
    ctx.appendSystem(
      `Stretch-goal reflection: ${goals.length} goal(s) recorded for next-run consideration.`,
    );
  } catch (err) {
    ctx.appendSystem(
      `Stretch-goal reflection failed (${err instanceof Error ? err.message : String(err)}).`,
    );
  }
}

export async function runMemoryDistillationPass(
  planner: Agent,
  clonePath: string | undefined,
  ctx: ReflectionContext,
): Promise<void> {
  if (!clonePath) {
    ctx.appendSystem("Memory distillation skipped: clone path missing.");
    return;
  }
  const tier = ctx.currentTier;
  const committed = ctx.committedCount;
  ctx.appendSystem(
    "Memory distillation: asking planner for lessons-learned bullets to log into .swarm-memory.jsonl…",
  );
  const prompt = [
    "You are doing a brief post-run reflection that will be SAVED for future runs against this same clone to read.",
    `Tier reached: ${tier}`,
    `Commits made: ${committed}`,
    "",
    ctx.contractCriteria.length > 0
      ? `=== Contract criteria (final state) ===\n${ctx.contractCriteria
          .map((c, i) => `${i + 1}. [${c.status}] ${c.description}`)
          .join("\n")}\n=== END ===`
      : "(no contract on file)",
    "",
    "Output 2-4 LESSONS LEARNED — durable bullets that a future run on this same clone should be aware of. Each:",
    "- One sentence.",
    '- Concrete and actionable. "X file pattern is fragile, prefer Y" beats "be careful".',
    '- Either AVOIDANCE ("don\'t try X — wasted N commits because Y") or BUILDING ("the Z scaffold landed in this run is ready for follow-up W").',
    "",
    "Output format — ONE JSON object only, no fences, no prose:",
    `{"lessons": ["lesson 1", "lesson 2", "lesson 3"]}`,
    "",
    'If there\'s genuinely nothing worth remembering (e.g. the run accomplished nothing new), output {"lessons": []} and a future run will skip the memory entry.',
  ].join("\n");

  let responseText: string;
  try {
    const res = await planner.client.session.prompt({
      path: { id: planner.sessionId },
      body: {
        agent: "swarm-read",
        model: { providerID: "ollama", modelID: planner.model },
        parts: [{ type: "text", text: prompt }],
      },
    });
    const text = extractText(res);
    responseText = text ?? "";
  } catch (err) {
    ctx.appendSystem(
      `Memory distillation prompt failed (${err instanceof Error ? err.message : String(err)}).`,
    );
    return;
  }
  if (!responseText) {
    ctx.appendSystem("Memory distillation: planner returned empty.");
    return;
  }
  const lessons = parseMemoryLessons(responseText);
  if (lessons.length === 0) {
    ctx.appendSystem(
      "Memory distillation: no usable lessons parsed (planner may have said nothing memorable).",
    );
    return;
  }
  const entry: MemoryEntry = {
    ts: Date.now(),
    runId: ctx.runId,
    tier,
    commits: committed,
    lessons,
  };
  try {
    const total = await appendMemoryEntry(clonePath, entry);
    ctx.appendSystem(
      `Memory distillation: appended ${lessons.length} lesson(s) to .swarm-memory.jsonl (${total} entries on file).`,
    );
  } catch (err) {
    ctx.appendSystem(
      `Memory write failed (${err instanceof Error ? err.message : String(err)}); lessons not persisted.`,
    );
  }
}
