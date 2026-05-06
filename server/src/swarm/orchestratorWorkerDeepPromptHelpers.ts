import type { TranscriptEntry } from "../types.js";
import type { Plan } from "./OrchestratorWorkerRunner.js";
import {
  readDirective,
  buildDirectiveBlock,
} from "./directivePromptHelpers.js";

export function buildTopPlanPrompt(
  round: number,
  totalRounds: number,
  midLeadIndices: readonly number[],
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
  const midList = midLeadIndices.map((i) => `Agent ${i}`).join(", ");
  const dirCtx = readDirective({ userDirective });
  const directiveBlock = buildDirectiveBlock(dirCtx, {
    labelSuffix: "(the question this 3-tier swarm is answering)",
    framingLines: [
      "Decompose the directive into ONE coarse sub-question per mid-lead. Each coarse subtask should target a distinct angle of the directive (e.g. for 'refactor X to Y': call-site mapping, API design, test coverage, migration path). Mid-leads will further decompose into per-worker subtasks.",
    ],
  });
  const directive = dirCtx.directive;
  return [
    "You are the ORCHESTRATOR (top tier) of a 3-tier swarm.",
    `This is the planning phase of cycle ${round}/${totalRounds}.`,
    `Below you are ${midLeadIndices.length} MID-LEADS: ${midList}. Each manages its own pool of workers; you do NOT see workers directly.`,
    "Assign ONE coarse subtask per mid-lead — they will break it down further for their workers.",
    "",
    ...directiveBlock,
    "REQUIRED VERIFICATION (Task #83 carry-over): use `list` / `glob` / `read` first to confirm the directories you intend to dispatch ACTUALLY EXIST. Don't dispatch a mid-lead to /src/utils/ if there is no utils dir.",
    "",
    "Output ONLY a JSON object (no prose, no fences):",
    '{"done": false, "assignments": [{"agentIndex": 2, "subtask": "…"}, …]}',
    "",
    "Rules:",
    "- Each subtask is COARSE: one paragraph or so describing a major area of investigation. The mid-lead will further decompose it into per-worker subtasks.",
    "- Do NOT specify worker-level detail — that's the mid-lead's job.",
    "- One subtask per mid-lead per cycle. Avoid overlap between mid-leads.",
    `- On cycle ${round}, ${round === 1
      ? directive.length > 0
        ? "decompose the directive into orthogonal sub-questions — one coarse subtask per mid-lead. Verify paths exist before dispatching."
        : "start with broad coverage of the repo (e.g. one mid-lead per top-level directory or per system area)."
      : "use prior cycle syntheses to narrow into gaps the prior cycle surfaced."
    }`,
    "",
    "Set `done: true` (assignments: []) ONLY when prior cycles have exhausted meaningful coverage. On cycle 1, `done` MUST be false.",
    "",
    "=== TRANSCRIPT SO FAR ===",
    transcriptText || "(empty — this is the first planning step)",
    "=== END TRANSCRIPT ===",
  ].join("\n");
}

export function buildMidLeadPlanPrompt(
  midLeadIndex: number,
  round: number,
  totalRounds: number,
  coarseSubtask: string,
  workerIndices: readonly number[],
  seedSnapshot: readonly TranscriptEntry[],
  userDirective?: string,
): string {
  const seedText = seedSnapshot.map((e) => `[SYSTEM] ${e.text}`).join("\n\n");
  const workerList = workerIndices.map((i) => `Agent ${i}`).join(", ");
  const dirCtx = readDirective({ userDirective });
  const directiveBlock = buildDirectiveBlock(dirCtx, {
    labelSuffix: "(the question the whole swarm is answering)",
    framingLines: [
      "Your coarse subtask is the orchestrator's decomposition of one piece of the directive. Decompose IT further so each worker subtask produces evidence the orchestrator needs to answer the directive.",
    ],
  });
  return [
    `You are MID-LEAD Agent ${midLeadIndex} in a 3-tier orchestrator-worker swarm.`,
    `This is cycle ${round}/${totalRounds}. The orchestrator just dispatched you a coarse subtask, and you have ${workerIndices.length} workers under you: ${workerList}.`,
    "",
    ...directiveBlock,
    "=== YOUR COARSE SUBTASK FROM ORCHESTRATOR ===",
    coarseSubtask,
    "=== END COARSE SUBTASK ===",
    "",
    `Break the coarse subtask into ${workerIndices.length} fine-grained worker subtasks — one per worker — that COLLECTIVELY cover what the orchestrator asked.`,
    "Workers see only their fine subtask + the seed below; not your plan, not the orchestrator's plan, not peer worker reports. Subtasks must be self-contained.",
    "",
    "Output ONLY a JSON object (no prose, no fences):",
    '{"assignments": [{"agentIndex": <worker-index>, "subtask": "…"}, …], "tierSkip": false}',
    "",
    "Rules:",
    "- One assignment per worker. Cover non-overlapping aspects.",
    "- Use file paths from the seed when relevant. Be concrete.",
    "- Subtask text under ~200 chars each. Workers should be able to act on them without further clarification.",
    "",
    "**Tier-skipping (optional)** — set `\"tierSkip\": true` AND include `\"selfReport\": \"<one-paragraph answer to the coarse subtask>\"` if the coarse subtask is genuinely trivial enough that you can do it yourself in one paragraph (e.g. \"name the file that defines X\" or \"check whether dir Y exists\"). Cuts the round-trip through workers when over-decomposed. Otherwise leave it false / omit and dispatch normally.",
    "",
    "**Pushback (optional, T198f)** — if the coarse subtask doesn't make sense (orchestrator over-decomposed, asked you to investigate something off-topic from the directive, or assumed a structure that doesn't exist in the repo), include `\"pushback\": \"<one-line concrete issue>\"` in your JSON. The runner logs it for the next orchestrator turn to see; you should still dispatch a best-effort plan if you can. Use sparingly — most coarse subtasks should be actionable as given.",
    "",
    "=== SEED ===",
    seedText || "(empty seed)",
    "=== END SEED ===",
  ].join("\n");
}

export function buildMidLeadSynthesisPrompt(
  midLeadIndex: number,
  round: number,
  totalRounds: number,
  coarseSubtask: string,
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
  const dirCtx = readDirective({ userDirective });
  const directiveBlock = buildDirectiveBlock(dirCtx, {
    labelSuffix: "(the question the whole swarm is answering)",
  });
  return [
    `You are MID-LEAD Agent ${midLeadIndex}. Your workers just reported on the subtasks you assigned them this cycle.`,
    `Cycle ${round}/${totalRounds}.`,
    "",
    ...directiveBlock,
    "=== ORCHESTRATOR'S ORIGINAL COARSE SUBTASK TO YOU ===",
    coarseSubtask,
    "=== END ===",
    "",
    "Read every worker report in the transcript below. Produce a TIGHT synthesis (under ~250 words) directed UPWARD to the orchestrator. The synthesis should:",
    "- **Cluster findings into themes FIRST.** Group similar findings (e.g. \"3 workers flagged auth/ as untested\" rather than 3 separate auth-untested bullets). Distinct findings (only 1 worker raised) get their own bullet but tagged as such. Cross-worker convergence is the strongest signal — surface it.",
    "- Summarize what your workers found, attributed to specific workers (e.g. \"Agent 5 noted…\").",
    dirCtx.hasDirective
      ? "- Answer the coarse subtask the orchestrator gave you, IN SERVICE of the directive. Be honest about gaps your workers couldn't resolve."
      : "- Answer the coarse subtask the orchestrator gave you. Be honest about gaps your workers couldn't resolve.",
    "- Stay terse — the orchestrator will read N of these (one per mid-lead) and needs density.",
    "",
    "=== TRANSCRIPT ===",
    transcriptText,
    "=== END TRANSCRIPT ===",
    "",
    "Now write your synthesis upward to the orchestrator.",
  ].join("\n");
}

export function buildTopSynthesisPrompt(
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
  const dirCtx = readDirective({ userDirective });
  const isFinal = round === totalRounds;
  if (dirCtx.hasDirective) {
    const closing = isFinal
      ? "4. **Final recommendation** — your one concrete next step toward the directive. Cite mid-lead findings."
      : "4. **Coverage gap toward the directive** — name one piece next cycle's plan should target.";
    return [
      "You are the ORCHESTRATOR. Each mid-lead just reported back its synthesis of its workers' findings.",
      `Cycle ${round}/${totalRounds}.`,
      "",
      ...buildDirectiveBlock(dirCtx, {
        labelSuffix: "(the question this 3-tier swarm is answering)",
      }),
      "Read every mid-lead synthesis in the transcript. Produce the cycle's final synthesis (under ~500 words) structured as:",
      "1. **Answer to directive** — direct response built from mid-lead findings. Cite mid-leads + the workers they cited + file paths.",
      "2. **Supporting evidence** — list the specific mid-lead findings that ground the answer.",
      "3. **Tensions / open questions** — places where mid-leads disagreed or couldn't answer. Be honest about confidence.",
      closing,
      "",
      "Cite mid-leads by index (e.g. \"Mid-lead 2 surfaced…\"). Don't re-invent evidence not in a mid-lead synthesis — workers already filtered the raw observations through their mid-lead.",
      "",
      "=== TRANSCRIPT ===",
      transcriptText,
      "=== END TRANSCRIPT ===",
      "",
      "Now write your top-level synthesis.",
    ].join("\n");
  }
  return [
    "You are the ORCHESTRATOR. Each mid-lead just reported back its synthesis of its workers' findings.",
    `Cycle ${round}/${totalRounds}.`,
    "",
    "Read every mid-lead synthesis in the transcript and produce the cycle's final synthesis (under ~400 words) that:",
    "1. Names what the project is and who it's for.",
    "2. Pulls together what's working / what's missing across all mid-lead reports.",
    "3. Proposes one concrete next action the swarm should take, citing which mid-lead's findings drove it.",
    isFinal
      ? "4. Closes with a final recommendation now that this is the last cycle."
      : "4. Flags ONE gap or inconsistency across mid-lead reports that a future cycle should investigate.",
    "",
    "Cite mid-leads by index (e.g. \"Mid-lead 2 surfaced…\"). Don't re-invent evidence not in a mid-lead synthesis — workers already filtered the raw observations through their mid-lead.",
    "",
    "=== TRANSCRIPT ===",
    transcriptText,
    "=== END TRANSCRIPT ===",
    "",
    "Now write your top-level synthesis.",
  ].join("\n");
}

export function truncate(s: string, max: number = 80): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function buildOrchestratorReplanPrompt(input: {
  originalPlan: Plan;
  pushbacks: ReadonlyMap<number, string>;
  availableMidLeadIndices: readonly number[];
  round: number;
  totalRounds: number;
  userDirective?: string;
}): string {
  const directiveLine = input.userDirective?.trim()
    ? `User directive: ${input.userDirective.trim()}\n`
    : "";
  const planRendered = input.originalPlan.assignments
    .map(
      (a) => `- Mid-lead ${a.agentIndex}: "${a.subtask.slice(0, 200)}"`,
    )
    .join("\n");
  const pushbacksRendered = [...input.pushbacks.entries()]
    .map(([idx, pb]) => `- Mid-lead ${idx}: ${pb}`)
    .join("\n");
  const midList = input.availableMidLeadIndices.map((i) => `Agent ${i}`).join(", ");
  return [
    `You are the ORCHESTRATOR re-planning cycle ${input.round}/${input.totalRounds} based on mid-lead pushback.`,
    "",
    directiveLine,
    `Available mid-leads: ${midList}.`,
    "",
    "=== YOUR ORIGINAL DECOMPOSITION ===",
    planRendered,
    "=== END ORIGINAL ===",
    "",
    "=== MID-LEAD PUSHBACKS ===",
    pushbacksRendered,
    "=== END PUSHBACKS ===",
    "",
    "Decide: do you REVISE the decomposition based on the pushbacks, or do you stand by the original (mid-leads will execute as-is)?",
    "",
    "Output ONLY a JSON object (no prose, no fences):",
    '{"assignments": [{"agentIndex": <mid-lead-index>, "subtask": "<revised coarse subtask>"}, ...]}',
    "",
    "Rules:",
    "- One assignment per mid-lead you want to dispatch (skip mid-leads whose original subtask still stands).",
    "- A REVISED subtask should explicitly address the pushback (cite what changed + why).",
    "- An empty assignments array means \"original plan stands, no replan needed.\"",
    "- subtask text under ~250 chars each. Concrete + actionable.",
  ].join("\n");
}

export function parseMidLeadPushback(raw: string): string | null {
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const candidate = fenceMatch ? fenceMatch[1] : raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    const braceMatch = candidate.match(/\{[\s\S]*\}/);
    if (!braceMatch) return null;
    try {
      parsed = JSON.parse(braceMatch[0]);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o.pushback === "string" && o.pushback.trim().length > 0) {
    return o.pushback.trim();
  }
  return null;
}

export function parseMidLeadTierSkip(raw: string): {
  tierSkip: boolean;
  selfReport?: string;
} {
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const candidate = fenceMatch ? fenceMatch[1] : raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    const braceMatch = candidate.match(/\{[\s\S]*\}/);
    if (!braceMatch) return { tierSkip: false };
    try {
      parsed = JSON.parse(braceMatch[0]);
    } catch {
      return { tierSkip: false };
    }
  }
  if (!parsed || typeof parsed !== "object") return { tierSkip: false };
  const o = parsed as Record<string, unknown>;
  const tierSkip = o.tierSkip === true;
  if (!tierSkip) return { tierSkip: false };
  const selfReport =
    typeof o.selfReport === "string" && o.selfReport.trim().length > 0
      ? o.selfReport.trim()
      : undefined;
  return { tierSkip: true, ...(selfReport ? { selfReport } : {}) };
}