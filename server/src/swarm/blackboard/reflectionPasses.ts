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
import {
  appendDecisions,
  parseDesignUpdateResponse,
  readDesignMemory,
  writeNorthStar,
  writeRoadmap,
} from "./designMemoryStore.js";
import { parseGoalList } from "./goalListParser.js";

// Task #183: helper to send a reflection-pass prompt on a FRESH
// session (mirrors the critic/verifier pattern). The planner's main
// session has accumulated huge context by reflection-pass time
// (every prompt + response from the run); reusing it caused glm-5.1
// to return empty for stretch / memory / design passes — observed
// across multiple runs. A fresh session per pass keeps each prompt's
// context bounded to just the pass's prompt itself.
//
// Returns the extracted text (or undefined if the prompt failed in a
// way that should be logged + skipped). Failure-open: any error
// resolves to undefined, callers handle the empty case.
async function promptOnFreshSession(
  planner: Agent,
  prompt: string,
  label: string,
): Promise<string | undefined> {
  let sessionId: string;
  try {
    const created = await planner.client.session.create({
      body: { title: `${label}-${Date.now()}` },
    });
    const any = created as { data?: { id?: string; info?: { id?: string } }; id?: string };
    const sid = any?.data?.id ?? any?.data?.info?.id ?? any?.id;
    if (!sid) return undefined;
    sessionId = sid;
  } catch {
    return undefined;
  }
  try {
    const res = await planner.client.session.prompt({
      path: { id: sessionId },
      body: {
        agent: "swarm-read",
        model: { providerID: "ollama", modelID: planner.model },
        parts: [{ type: "text", text: prompt }],
      },
    });
    return extractText(res);
  } catch {
    return undefined;
  }
}

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
    // Task #183: fresh session — planner's main session has too much
    // context by reflection-pass time, was returning empty.
    const text = await promptOnFreshSession(planner, prompt, "stretch");
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

  // Task #183: fresh session.
  const responseText = await promptOnFreshSession(planner, prompt, "memory-distill");
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

// Task #177: design-memory update pass. Asks the planner to refresh
// the long-horizon CREATIVE / PRODUCT memory at <clone>/.swarm-design/
// — north-star vision, design decisions, and roadmap. Runs AFTER
// memory distillation (so the planner has the freshest context). Same
// gating as the other reflection passes plus autoDesignMemory !== false.
export async function runDesignMemoryUpdatePass(
  planner: Agent,
  clonePath: string | undefined,
  ctx: ReflectionContext,
): Promise<void> {
  if (!clonePath) {
    ctx.appendSystem("Design memory update skipped: clone path missing.");
    return;
  }
  const tier = ctx.currentTier;
  const committed = ctx.committedCount;
  // Read existing memory so the planner sees the current vision/decisions/
  // roadmap. Helps it produce DELTA updates rather than re-inventing.
  const prior = await readDesignMemory(clonePath).catch(() =>
    ({ decisions: [], roadmap: [] } as Awaited<ReturnType<typeof readDesignMemory>>),
  );
  ctx.appendSystem(
    "Design memory update: asking planner to refresh north-star / decisions / roadmap…",
  );
  const priorBlock = [
    prior.northStar
      ? `=== Current north star ===\n${prior.northStar}\n=== END ===`
      : "(no north star yet — propose the FIRST one based on this run's outcome)",
    prior.roadmap.length > 0
      ? `=== Current roadmap (top ${Math.min(prior.roadmap.length, 5)}) ===\n` +
        prior.roadmap.slice(0, 5).map((r, i) => `${i + 1}. ${r}`).join("\n") +
        `\n=== END ===`
      : "(no roadmap yet — propose 3-5 ranked features)",
    prior.decisions.length > 0
      ? `=== Last 3 design decisions ===\n` +
        prior.decisions
          .slice(-3)
          .map((d) => `## ${d.date} · ${d.title}\n${d.body}`)
          .join("\n\n") +
        `\n=== END ===`
      : "(no decisions logged yet)",
  ].join("\n\n");
  const prompt = [
    "You are doing a CREATIVE / PRODUCT post-run reflection. Update the long-horizon design memory for this clone.",
    "",
    `This run reached tier ${tier} with ${committed} commits.`,
    "",
    priorBlock,
    "",
    ctx.contractCriteria.length > 0
      ? `=== This run's final contract ===\n${ctx.contractCriteria
          .map((c, i) => `${i + 1}. [${c.status}] ${c.description}`)
          .join("\n")}\n=== END ===`
      : "(no contract on file)",
    "",
    "Update the design memory across three dimensions:",
    "",
    '1. NORTH STAR (1-2 paragraphs): the long-term VISION for what this codebase is becoming. Refine if the work this run REVEALED something about direction. Keep stable if not. Speak about WHAT the product should be, who it serves, what makes it distinctive.',
    "",
    '2. NEW DECISIONS (0-3 entries): meaningful design CHOICES made this run that future runs should respect. Each: {title, body}. Title is short; body is 1-3 sentences explaining the choice + rationale. Skip trivial/mechanical commits.',
    "",
    "3. ROADMAP (3-7 items, ranked): the top features to build next. Be ambitious — these are creative product decisions, not next-sprint tickets. Compare against EXISTING products in the genre (you know them). What would make this product distinctive vs them?",
    "",
    "Output format — ONE JSON object only, no fences, no prose:",
    `{"northStar": "...", "newDecisions": [{"title":"...", "body":"..."}], "roadmap": ["item1", "item2", ...]}`,
    "",
    'If a field has no meaningful update, OMIT it (don\'t echo the prior value).',
  ].join("\n");

  // Task #183: fresh session.
  const responseText = await promptOnFreshSession(planner, prompt, "design-memory");
  if (!responseText) {
    ctx.appendSystem("Design memory update: planner returned empty.");
    return;
  }
  const update = parseDesignUpdateResponse(responseText);
  let wrote = 0;
  try {
    if (update.northStar) {
      await writeNorthStar(clonePath, update.northStar);
      wrote++;
    }
    if (update.newDecisions.length > 0) {
      await appendDecisions(clonePath, update.newDecisions);
      wrote += update.newDecisions.length;
    }
    if (update.roadmap.length > 0) {
      await writeRoadmap(clonePath, update.roadmap);
      wrote++;
    }
    if (wrote === 0) {
      ctx.appendSystem(
        "Design memory update: planner produced nothing parseable (no changes written).",
      );
    } else {
      const parts: string[] = [];
      if (update.northStar) parts.push("north-star refreshed");
      if (update.newDecisions.length > 0) parts.push(`${update.newDecisions.length} decision(s) appended`);
      if (update.roadmap.length > 0) parts.push(`roadmap of ${update.roadmap.length} items written`);
      ctx.appendSystem(`Design memory update: ${parts.join(", ")} → .swarm-design/`);
    }
  } catch (err) {
    ctx.appendSystem(
      `Design memory write failed (${err instanceof Error ? err.message : String(err)}); skipped.`,
    );
  }
}
