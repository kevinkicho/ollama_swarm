import type { TranscriptEntry, TranscriptEntrySummary } from "../types.js";
import {
  readDirective,
  buildDirectiveBlock,
} from "./directivePromptHelpers.js";

export interface Assignment {
  agentIndex: number;
  subtask: string;
  /** T175 (2026-05-04): per-subtask "how I'll know this worker
   *  succeeded" rubric. The lead writes one short sentence describing
   *  the shape of a successful worker report; the worker self-evaluates
   *  against it before reporting. Optional for backward-compat — old
   *  plan responses without successCriteria still parse cleanly. */
  successCriteria?: string;
  /** T182 (2026-05-04): per-subtask effort estimate. The lead rates
   *  difficulty as small | medium | large so the runner could load-
   *  balance — today it just surfaces in the system bubble so the
   *  reader can spot lopsided plans. Optional for backward-compat. */
  effort?: "small" | "medium" | "large";
}

export interface Plan {
  assignments: Assignment[];
  // Phase B (Task #101): lead can short-circuit the loop by setting
  // done:true. Means "no useful work remains; stop now". Independent
  // of `assignments` — done:true with assignments=[] is the canonical
  // shape, but if the model still emits assignments alongside, we
  // honor done:true and skip them.
  done?: boolean;
}

// Exported for testability. Accepts either a clean JSON object with
// `assignments: [{agentIndex, subtask}]` or a JSON object wrapped in a
// markdown fence. Silently drops malformed assignments. Filters out any
// agentIndex not in the allowed worker set (so a confused lead can't
// assign work to itself or to a non-spawned worker).
export function parsePlan(raw: string, allowedWorkerIndices: readonly number[]): Plan {
  const allowed = new Set(allowedWorkerIndices);
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const candidate = fenceMatch ? fenceMatch[1] : raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    // Try to find the first {...} JSON-looking block
    const braceMatch = candidate.match(/\{[\s\S]*\}/);
    if (!braceMatch) return { assignments: [] };
    try {
      parsed = JSON.parse(braceMatch[0]);
    } catch {
      return { assignments: [] };
    }
  }
  if (!parsed || typeof parsed !== "object") return { assignments: [] };
  const doneRaw = (parsed as { done?: unknown }).done;
  const done = doneRaw === true ? true : undefined;
  const assignmentsRaw = (parsed as { assignments?: unknown }).assignments;
  if (!Array.isArray(assignmentsRaw)) return { assignments: [], done };
  const assignments: Assignment[] = [];
  const seenAgents = new Set<number>();
  for (const a of assignmentsRaw) {
    if (!a || typeof a !== "object") continue;
    const idx = (a as { agentIndex?: unknown }).agentIndex;
    const subtask = (a as { subtask?: unknown }).subtask;
    const successCriteriaRaw = (a as { successCriteria?: unknown }).successCriteria;
    const effortRaw = (a as { effort?: unknown }).effort;
    if (typeof idx !== "number" || !allowed.has(idx)) continue;
    if (typeof subtask !== "string" || subtask.trim().length === 0) continue;
    if (seenAgents.has(idx)) continue; // one subtask per worker per cycle
    seenAgents.add(idx);
    // T175: extract optional successCriteria. Empty/missing → undefined,
    // worker prompt skips the rubric block. String values get trimmed.
    const successCriteria =
      typeof successCriteriaRaw === "string" && successCriteriaRaw.trim().length > 0
        ? successCriteriaRaw.trim()
        : undefined;
    // T182: extract optional effort. Whitelist against catalog so a
    // model emitting "huge" or "tiny" doesn't poison the field.
    const effortLower =
      typeof effortRaw === "string" ? effortRaw.trim().toLowerCase() : "";
    const effort =
      effortLower === "small" || effortLower === "medium" || effortLower === "large"
        ? (effortLower as "small" | "medium" | "large")
        : undefined;
    assignments.push({
      agentIndex: idx,
      subtask: subtask.trim(),
      ...(successCriteria ? { successCriteria } : {}),
      ...(effort ? { effort } : {}),
    });
  }
  return { assignments, done };
}

export function buildLeadPlanPrompt(
  round: number,
  totalRounds: number,
  workerIndices: readonly number[],
  transcript: readonly TranscriptEntry[],
  userDirective?: string,
): string {
  const transcriptText = transcript
    .map((e) => {
      if (e.role === "system") return `[SYSTEM] ${e.text}`;
      if (e.role === "user") return `[HUMAN] ${e.text}`;
      return `[Agent ${e.agentIndex}] ${e.text}`;
    })
    .join("\n\n");

  const workerList = workerIndices.map((i) => `Agent ${i}`).join(", ");

  // 2026-05-02 (OW directive lever): when a directive is set the
  // plan must DECOMPOSE the directive into worker subtasks. Each
  // subtask should advance the directive, not just describe a slice
  // of the repo. The "rules for good subtasks" guidance is augmented
  // accordingly.
  // 2026-05-03 (Phase A): directive helpers extracted to shared module.
  const dirCtx = readDirective({ userDirective });
  const directiveBlock = buildDirectiveBlock(dirCtx, {
    labelSuffix: "(the question this OW swarm is answering)",
    framingLines: [
      "Your job is to DECOMPOSE the directive into worker subtasks. Each subtask should produce a piece of the answer (a finding, a proposal, an investigation). Do NOT dispatch generic 'inspect this dir' subtasks unless that inspection directly bears on the directive.",
    ],
  });
  // Local alias for branches further down.
  const directive = dirCtx.directive;

  return [
    `You are the LEAD agent in an orchestrator–worker swarm inspecting a cloned GitHub project.`,
    `This is planning phase of cycle ${round}/${totalRounds}.`,
    `Your workers are: ${workerList}. Assign ONE subtask to each — workers execute in parallel with no visibility of each other.`,
    "",
    ...directiveBlock,
    // Task #83 (2026-04-25): repo-grounding for subtask quality.
    // Mirror of the planner-grounding rule from #69 (blackboard).
    // Lead frequently dispatches workers to inspect things that
    // don't exist in the codebase ("audit src/utils/" when there's
    // no utils dir). Forcing a tool-call pass before assignments
    // dramatically reduces wasted worker cycles.
    "REQUIRED VERIFICATION (Task #83) — BEFORE writing assignments:",
    "  - Use `list` / `glob` / `read` tools on the cloned repo to confirm the directories and files you intend to dispatch workers to ACTUALLY EXIST.",
    "  - If you assume a path (e.g. `src/utils/`, `tests/`, `docs/`) that turns out to not exist, the worker will return a 'not found' report and burn the cycle.",
    "  - Cheapest verification: read README.md + a top-level `list` first. Then assign workers to paths that appeared in those listings.",
    "",
    "Output ONLY a JSON object with this shape (no prose, no markdown fences):",
    '{"done": false, "assignments": [{"agentIndex": 2, "subtask": "…", "successCriteria": "…", "effort": "small|medium|large"}, …]}',
    "",
    // T175 (2026-05-04): per-subtask successCriteria. Sets a clear bar
    // the worker self-evaluates against before reporting.
    "**successCriteria** is a one-sentence rubric for what a SUCCESSFUL worker report looks like.",
    "  Examples:",
    "    \"Report names every call site of X.foo() with file:line citations.\"",
    "    \"Report identifies whether the auth flow uses JWT or sessions, with file evidence.\"",
    "    \"Report concludes with a clear PROPOSE: <new shape> line backed by current code.\"",
    "  Skip the field (or empty string) for genuinely open-ended subtasks. Most subtasks should have one.",
    "",
    // T182 (2026-05-04): per-subtask effort estimate. small|medium|large
    // so the reader can spot lopsided plans (3 large + 1 small = the
    // small worker will idle while the large ones grind). Future
    // runner work can use this for actual load-balancing.
    "**effort** is your difficulty estimate for the subtask:",
    "    small  — tightly scoped, one file or one function (e.g. \"list every call site of X\")",
    "    medium — multi-file investigation or multi-step reasoning (e.g. \"map auth flow end-to-end\")",
    "    large  — open-ended exploration or many files (e.g. \"propose new module shape\")",
    "  Skip the field for genuinely uncertain estimates.",
    "",
    // Phase B (Task #101): early-stop signal. The lead can short-
    // circuit the loop when there is genuinely nothing useful left
    // to dispatch — e.g. every prior worker reported "no further
    // changes needed" or the prior synthesis already covered the
    // remaining gaps. Be honest: if any meaningful gap remains,
    // dispatch to investigate it.
    'Set `done: true` (with assignments: []) ONLY when one of these holds:',
    "  • All workers in the prior cycle returned NO_CHANGE / nothing-new / no-issues-found.",
    "  • The prior synthesis explicitly stated a complete, satisfactory picture and there is no remaining gap to investigate.",
    "Otherwise set `done: false` and dispatch real subtasks. On cycle 1, `done` MUST be false — there's nothing yet to be done about.",
    "",
    "Rules for good subtasks:",
    "- Each subtask is self-contained (the worker sees only its subtask + the seed; no peer context, no your planning text).",
    directive.length > 0
      ? "- Subtasks DECOMPOSE THE DIRECTIVE: each one investigates / proposes / verifies a different piece of the answer. Cite the real paths you verified above. Examples (for a 'refactor X' directive): \"map every call site of X.foo() and report file:line list\", \"propose the new API shape for X based on src/x.ts\", \"identify tests that cover X today and gaps that need new ones\"."
      : "- Subtasks should DIVIDE LABOR: e.g. \"inspect src/foo/\", \"read README and package.json\", \"inspect src/__tests__/ and note coverage\", \"audit dependencies in package.json\". Avoid duplicate assignments. Reference REAL paths you verified above.",
    "- Keep subtask text under ~200 chars. Be specific about what to report back.",
    "- One assignment per worker. Do NOT assign more than one subtask to the same agent.",
    round > 1
      ? "- This is a later cycle: you have prior cycle syntheses in the transcript. Use them to refine — dispatch workers to fill gaps the prior synthesis surfaced."
      : directive.length > 0
        ? "- This is cycle 1: dispatch workers to gather the FOUNDATIONAL evidence the directive needs answered. Verify the top-level structure with `list .` first so your dispatched paths are real."
        : "- This is cycle 1: start with broad coverage of the repo. Verify the top-level structure with `list .` first so your dispatched paths are real.",
    "",
    "=== TRANSCRIPT SO FAR ===",
    transcriptText || "(empty — this is the first planning step)",
    "=== END TRANSCRIPT ===",
  ].join("\n");
}

export function buildWorkerPrompt(
  workerIndex: number,
  round: number,
  totalRounds: number,
  subtask: string,
  seedSnapshot: readonly TranscriptEntry[],
  userDirective?: string,
  successCriteria?: string,
): string {
  const seedText = seedSnapshot
    .map((e) => `[SYSTEM] ${e.text}`)
    .join("\n\n");

  // 2026-05-02 (OW directive lever): worker sees the directive as
  // context for WHY their subtask matters. Same anti-hallucination
  // valve as map-reduce: if the worker concludes the subtask doesn't
  // bear on the directive after investigation, that's a valid honest
  // answer — better than inventing relevance to seem useful.
  // 2026-05-03 (Phase A): directive helpers extracted to shared module.
  const dirCtx = readDirective({ userDirective });
  const directiveBlock = buildDirectiveBlock(dirCtx, {
    labelSuffix: "(the question this OW swarm is answering)",
    framingLines: [
      "Your subtask below is the lead's decomposition of one piece of the directive. Execute it, then report findings RELEVANT TO THE DIRECTIVE.",
      "**\"NO RELEVANT FINDINGS\" IS A VALID ANSWER.** If your subtask turns out to have no bearing on the directive (the lead may have over-decomposed), say so honestly: `My subtask <X> turned up no findings relevant to the directive: <one-line why>`. Do NOT invent relevance to seem useful.",
    ],
  });

  // T175 (2026-05-04): per-subtask success criteria block. When the
  // lead set a rubric for this subtask, surface it to the worker AND
  // require a self-evaluation line before the report. The lead's
  // synthesis can use the self-eval to weight reports.
  const rubricBlock = successCriteria
    ? [
        "",
        "**SUCCESS CRITERIA (rubric set by the lead):**",
        successCriteria,
        "",
        "BEFORE your report, write a one-line self-evaluation:",
        "    SELF-EVAL: PASS — <why your report meets the criteria>",
        "    SELF-EVAL: PARTIAL — <which part is met, which isn't, why>",
        "    SELF-EVAL: MISS — <why you couldn't meet it; what's blocking>",
        "Be honest — a clear PARTIAL/MISS is more useful to the lead than a falsely-claimed PASS.",
        "",
      ]
    : [];

  return [
    `You are Worker Agent ${workerIndex} in an orchestrator–worker swarm.`,
    `This is cycle ${round}/${totalRounds}. You cannot see the lead's full plan or any peer worker's output — that is deliberate, so your report is independent.`,
    "",
    ...directiveBlock,
    "Your working directory IS the project clone — use file-read, grep, and find-files tools to inspect it.",
    "Respond with a CONCRETE report (under ~300 words) of what you found, citing file paths (e.g. `src/foo.ts:42`) where relevant.",
    "Do NOT try to coordinate with other workers or ask for more scope — just execute your subtask and report.",
    // T195 (2026-05-04): cross-worker handoffs. Workers can flag
    // findings that another worker should investigate. After the
    // parallel batch, the lead sees these and dispatches a follow-up
    // mini-wave to the named workers. Format on the LAST line(s):
    //   HANDOFF: Worker N | <one-line investigation request>
    // Skip the line entirely when no handoff is appropriate.
    "**HANDOFF (optional):** If your investigation surfaced something that a SPECIFIC peer worker should look into (and you can name the worker), end your report with:",
    "    HANDOFF: Worker <N> | <one-line concrete investigation request>",
    "    HANDOFF: Worker 4 | check whether the singleton pattern in src/db/Singleton.ts has thread-safety guards.",
    "  Use sparingly. Most reports won't need handoffs. The lead picks these up + may dispatch a follow-up mini-wave to those workers BEFORE synthesis.",
    ...rubricBlock,
    "=== SEED ===",
    seedText || "(empty seed)",
    "=== END SEED ===",
    "",
    "YOUR SUBTASK:",
    subtask,
    "",
    `Now respond as Worker Agent ${workerIndex}.`,
  ].join("\n");
}

export function buildLeadSynthesisPrompt(
  round: number,
  totalRounds: number,
  transcript: readonly TranscriptEntry[],
  userDirective?: string,
): string {
  const transcriptText = transcript
    .map((e) => {
      if (e.role === "system") return `[SYSTEM] ${e.text}`;
      if (e.role === "user") return `[HUMAN] ${e.text}`;
      return `[Agent ${e.agentIndex}] ${e.text}`;
    })
    .join("\n\n");

  // 2026-05-03 (Phase A): directive helpers extracted to shared module.
  const dirCtx = readDirective({ userDirective });
  const isFinal = round === totalRounds;

  // 2026-05-02 (OW directive lever): when a directive is set the
  // synthesis answers the directive directly using worker findings as
  // evidence, instead of producing the generic "what is this project"
  // recap.
  if (dirCtx.hasDirective) {
    const closing = isFinal
      ? "4. **Final recommendation** — your one concrete next step toward the directive. Cite worker findings + file paths."
      : "4. **Coverage gap toward the directive** — name one piece the workers couldn't answer that next cycle's plan should target.";
    return [
      `You are the LEAD agent in an orchestrator–worker swarm.`,
      `This is the synthesis phase of cycle ${round}/${totalRounds}. Your workers have just reported back on the subtasks you assigned.`,
      "",
      ...buildDirectiveBlock(dirCtx, {
        labelSuffix: "(the question this OW swarm is answering)",
      }),
      "Read every worker report in the transcript below. Produce a synthesis (under ~500 words) structured as:",
      "1. **Answer to directive** — direct response built from worker findings. Cite the workers + file paths that ground each claim.",
      "2. **Supporting evidence** — list the specific worker findings that make the answer hold up.",
      "3. **Tensions / open questions** — places where worker reports disagreed or couldn't answer. Be honest about confidence.",
      closing,
      "",
      "Cite workers by index (e.g. \"Agent 3 noted…\") when referencing their findings. Do NOT invent evidence not in a worker report — if the directive can't be answered from what workers gathered, say so explicitly.",
      "",
      "=== TRANSCRIPT ===",
      transcriptText,
      "=== END TRANSCRIPT ===",
      "",
      "Now write your synthesis.",
    ].join("\n");
  }

  return [
    `You are the LEAD agent in an orchestrator–worker swarm.`,
    `This is the synthesis phase of cycle ${round}/${totalRounds}. Your workers have just reported back on the subtasks you assigned.`,
    "",
    "Read every worker report in the transcript below. Produce a synthesis (under ~400 words) that:",
    "1. Names what the project is and who it seems to be for.",
    "2. Summarizes what's working and what's missing, drawing from worker reports.",
    "3. Proposes one concrete next action the swarm should take, with a rationale citing worker findings.",
    isFinal
      ? "4. Closes with a final recommendation now that this is the last cycle."
      : "4. Notes one gap or inconsistency across worker reports that a future cycle should investigate.",
    "",
    "Cite workers by index (e.g. \"Agent 3 noted…\") when referencing their findings. Do not re-invent evidence not in a worker report.",
    "",
    "=== TRANSCRIPT ===",
    transcriptText,
    "=== END TRANSCRIPT ===",
    "",
    "Now write your synthesis.",
  ].join("\n");
}


// Task #43: parse an orchestrator "assignments" envelope into a
// structured summary the transcript UI can render inline. Accepts a
// fenced ```json``` block OR a bare object. Returns undefined when
// the text isn't an assignments envelope (e.g. worker free-text
// response, lead synthesis pass). The summary carries enough for
// the UI to render a one-line summary + bullet-list expansion.
export function parseAssignmentsSummary(text: string): TranscriptEntrySummary | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  // Strip a ```json ... ``` fence if present.
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/m.exec(trimmed);
  const candidate = fenced ? fenced[1] : trimmed;
  if (candidate.charAt(0) !== "{") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const obj = parsed as { assignments?: unknown };
  if (!Array.isArray(obj.assignments)) return undefined;
  const assignments: Array<{ agentIndex: number; subtask: string }> = [];
  for (const item of obj.assignments) {
    if (!item || typeof item !== "object") continue;
    const it = item as { agentIndex?: unknown; subtask?: unknown };
    if (typeof it.agentIndex !== "number") continue;
    if (typeof it.subtask !== "string") continue;
    assignments.push({ agentIndex: it.agentIndex, subtask: it.subtask });
  }
  if (assignments.length === 0) return undefined;
  return {
    kind: "ow_assignments",
    subtaskCount: assignments.length,
    assignments,
  };
}

// T195 (2026-05-04): parse HANDOFF lines from a worker report.
// Format: `HANDOFF: Worker <N> | <one-line request>`. Returns
// list of {targetIndex, request}. Workers flag handoffs at the end
// of their report; the lead picks them up after the parallel batch
// and may dispatch a mini-wave to the named workers before synthesis.
export interface HandoffRequest {
  targetIndex: number;
  request: string;
  fromIndex: number;
}
export function parseHandoffLines(
  text: string,
  fromIndex: number,
): HandoffRequest[] {
  const out: HandoffRequest[] = [];
  if (!text) return out;
  const re = /^[\s>*-]*HANDOFF\s*:\s*Worker\s+(\d+)\s*\|\s*(.+?)$/gim;
  for (const m of text.matchAll(re)) {
    const targetIndex = Number.parseInt(m[1]!, 10);
    const request = m[2]!.trim();
    if (
      Number.isFinite(targetIndex) &&
      targetIndex >= 1 &&
      targetIndex !== fromIndex && // workers can't hand off to themselves
      request.length > 0
    ) {
      out.push({ targetIndex, request, fromIndex });
    }
  }
  return out;
}

// T182 (2026-05-04): summarize the effort distribution of a plan as
// one-line system bubble text. Returns null when no assignments
// carry effort tags (back-compat: old plans don't have effort).
export function summarizeEffortDistribution(
  assignments: readonly Assignment[],
): string | null {
  let small = 0;
  let medium = 0;
  let large = 0;
  let untagged = 0;
  for (const a of assignments) {
    if (a.effort === "small") small++;
    else if (a.effort === "medium") medium++;
    else if (a.effort === "large") large++;
    else untagged++;
  }
  if (small + medium + large === 0) return null;
  const parts: string[] = [];
  if (small > 0) parts.push(`${small} small`);
  if (medium > 0) parts.push(`${medium} medium`);
  if (large > 0) parts.push(`${large} large`);
  if (untagged > 0) parts.push(`${untagged} untagged`);
  // Lopsided plans (every assignment is large or every is small) are
  // worth flagging — workers will idle while the heavy ones grind.
  const total = small + medium + large + untagged;
  let lopsided = "";
  if (large >= 2 && small + medium === 0) lopsided = " · LOPSIDED (all large — workers may idle if they finish at different speeds)";
  else if (small >= 2 && medium + large === 0) lopsided = " · LOPSIDED (all small — possibly under-utilizing the cycle)";
  return `${total} subtask${total === 1 ? "" : "s"}: ${parts.join(", ")}${lopsided}`;
}

// T182 (2026-05-04): build a peer-review prompt asking another agent
// to flag obvious issues with the lead's decomposition BEFORE workers
// fire. Reviewer reads the JSON plan as text + asserts whether each
// subtask makes sense, has clear successCriteria, points at real
// paths, etc. Output goes to the transcript so subsequent agents see
// any flagged concerns; the runner doesn't act on them automatically
// (lead can refine in next cycle).
export function buildDecompositionReviewPrompt(
  plan: Plan,
  round: number,
  totalRounds: number,
  userDirective?: string,
): string {
  const directiveLine = userDirective?.trim()
    ? `User directive: ${userDirective.trim()}\n`
    : "";
  const assignmentsRendered = plan.assignments
    .map((a, i) => {
      const lines: string[] = [
        `**Subtask ${i + 1}** → Agent ${a.agentIndex}`,
        `  task: ${a.subtask}`,
      ];
      if (a.successCriteria) lines.push(`  successCriteria: ${a.successCriteria}`);
      if (a.effort) lines.push(`  effort: ${a.effort}`);
      return lines.join("\n");
    })
    .join("\n\n");
  return [
    `You are a PEER REVIEWER on an orchestrator–worker swarm. The lead just produced a plan for cycle ${round}/${totalRounds}; before workers fire, you flag obvious issues.`,
    "",
    directiveLine,
    "Plan to review:",
    assignmentsRendered,
    "",
    "Your job — answer these explicitly (under 200 words total):",
    "1. **Coverage** — does the plan cover the directive? What dimensions are missing?",
    "2. **Subtask clarity** — are any subtasks too vague to execute? Name them.",
    "3. **successCriteria** — are the rubrics tight enough that a worker could honestly self-evaluate? Flag fuzzy ones.",
    "4. **Effort balance** — are the effort tags realistic? Will small workers sit idle while large ones grind?",
    "5. **Real paths** — do the subtasks reference paths that actually exist (you can use file-read / list / glob tools to verify)?",
    "",
    "Be concrete. Cite subtask numbers when flagging. If the plan looks sound, say so directly — don't manufacture concerns.",
    "End your review with one of:",
    "  REVIEW VERDICT: PROCEED — plan is sound, workers should fire.",
    "  REVIEW VERDICT: CAUTION — concerns flagged above; workers should still fire but the lead's next cycle should address them.",
    "  REVIEW VERDICT: REJECT — plan has fundamental issues; recommend the lead re-plan before workers fire.",
    "",
    "(The runner currently surfaces your verdict to the transcript but doesn't act on REJECT — it's informational. Future work may auto-replan on REJECT.)",
  ].join("\n");
}