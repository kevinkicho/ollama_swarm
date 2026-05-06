import type { TranscriptEntry } from "../types.js";
import { readDirective, buildDirectiveBlock } from "./directivePromptHelpers.js";

// Skip repo entries that don't contribute to understanding: VCS metadata,
// node_modules, build output. The mapper listing already truncated by
// RepoService.listTopLevel; this is a further filter on the labeled slice.
//
// Task #106 (2026-04-25): expanded with trivial config files that
// caused "tiny single-file slice" collapse in run 2bcf662f — when a
// mapper's slice was just `.editorconfig`, the model latched onto its
// numeric values and emitted just "0.5", "11.4", etc. These configs
// rarely contain anything a swarm needs to reason about; skipping them
// keeps slices semantically meaningful even at small mapper counts.
export const SKIP_ENTRIES = new Set([
  ".git/", ".git", "node_modules/", "node_modules", ".DS_Store",
  // Task #106 (2026-04-25):
  ".editorconfig",
  ".gitignore",
  ".gitattributes",
  ".npmrc",
  ".nvmrc",
  ".prettierrc", ".prettierrc.json", ".prettierrc.js",
  ".eslintrc", ".eslintrc.json", ".eslintrc.js",
  ".env.example",
  "LICENSE", "LICENSE.md", "LICENSE.txt",
]);

// Phase B (Task #97): scan a mapper's response for the
// "COMPLETE: true|false" declaration. Looks at the LAST 3 non-blank
// lines, then within each line searches for the COMPLETE: pattern
// anywhere (not just line-start) — observed in v1 validation that
// the model sometimes prefixes with "Final line:" (literal echo of
// the instruction), so an anchored regex would miss it.
export function parseMapperComplete(text: string): boolean {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const tail = lines.slice(-3);
  for (const line of tail) {
    const m = /\bcomplete\s*:\s*(true|false)\b/i.exec(line);
    if (m) return m[1].toLowerCase() === "true";
  }
  return false;
}

// Round-robin partition of `entries` into `k` slices. Exported so tests
// can lock down the distribution (every entry appears in exactly one
// slice; slices differ in length by at most 1).
export function sliceRoundRobin<T>(entries: readonly T[], k: number): T[][] {
  if (k <= 0) return [];
  const slices: T[][] = Array.from({ length: k }, () => []);
  entries.forEach((e, i) => slices[i % k].push(e));
  return slices;
}

// T-Item-MapPart (2026-05-04): size-balanced slicing — greedy LPT
// ("longest processing time first"). Each entry has a weight (e.g.,
// recursive file count); sort entries descending by weight, then
// assign each to the currently-lightest-loaded mapper. Bounds the
// max-load-vs-min-load ratio better than round-robin when weights
// are skewed (one giant `node_modules`-style dir + many tiny ones).
//
// Pure — exported for tests.
export function sliceSizeBalanced<T>(
  entries: readonly { item: T; weight: number }[],
  k: number,
): T[][] {
  if (k <= 0) return [];
  const slices: T[][] = Array.from({ length: k }, () => []);
  const loads: number[] = Array.from({ length: k }, () => 0);
  // Sort descending by weight so LPT places heavy items first.
  const sorted = [...entries].sort((a, b) => b.weight - a.weight);
  for (const { item, weight } of sorted) {
    // Pick the slice with the smallest current load. Tie-break by
    // lowest index for determinism.
    let pickIdx = 0;
    let minLoad = loads[0];
    for (let i = 1; i < k; i++) {
      if (loads[i] < minLoad) {
        minLoad = loads[i];
        pickIdx = i;
      }
    }
    slices[pickIdx].push(item);
    loads[pickIdx] += weight;
  }
  return slices;
}

// 2026-05-04 (idea T174): per-mapper lens specialization. Each mapper
// gets a different reading lens (security/performance/correctness/UX/
// architecture/testability) so 4-6 mappers cover 4-6 dimensions
// instead of all reading the same way against different files. The
// reducer then synthesizes across dimensions, not just across slices.
//
// Lens cycles by mapperIndex modulo catalog length. mapperIndex starts
// at 2 (agent-1 is reducer) so we offset by -2 to start lens cycle at
// MAPPER_LENSES[0].
export interface MapperLens {
  /** Short id used in report sections + reducer aggregation. */
  id: string;
  /** Title shown to the mapper at top of its prompt. */
  title: string;
  /** What the mapper looks for under this lens. ~3 short bullets. */
  guidance: readonly string[];
}
export const MAPPER_LENSES: readonly MapperLens[] = [
  {
    id: "correctness",
    title: "Correctness lens",
    guidance: [
      "Look for bugs: off-by-one, null deref, unhandled error paths, race conditions, edge cases not tested.",
      "Watch for assumptions that aren't validated: \"this can never be empty\", \"the API always returns X\".",
      "Surface code paths that look right but lack a test that would catch a regression.",
    ],
  },
  {
    id: "security",
    title: "Security lens",
    guidance: [
      "Look for: input not validated, secrets in source, sql/cmd injection vectors, auth/authz holes, unsafe deps.",
      "Watch for default-allow patterns where default-deny is safer.",
      "Surface trust boundaries crossed without explicit checks.",
    ],
  },
  {
    id: "performance",
    title: "Performance lens",
    guidance: [
      "Look for: N+1 queries, sync I/O on hot paths, unbounded allocations, accidental quadratics, repeated parsing.",
      "Watch for blocking ops in async contexts and unbounded retry loops.",
      "Surface where caching or batching would change the order of magnitude.",
    ],
  },
  {
    id: "architecture",
    title: "Architecture lens",
    guidance: [
      "Look for: layering violations, circular deps, modules that know too much about each other, leaky abstractions.",
      "Watch for premature abstraction (helpers used once) and missing abstraction (3+ near-duplicates).",
      "Surface decisions that lock the project into a path that'll be expensive to reverse.",
    ],
  },
  {
    id: "testability",
    title: "Testability lens",
    guidance: [
      "Look for: untested critical paths, code that's hard to test (heavy I/O coupling, hidden dependencies, mocked-database gaps).",
      "Watch for tests that pass because they mock too much, not because the code works.",
      "Surface integration points that lack any end-to-end coverage.",
    ],
  },
  {
    id: "ux-and-docs",
    title: "UX / documentation lens",
    guidance: [
      "Look for: error messages that won't help a user, accessibility gaps in frontend, default values that surprise.",
      "Watch for docs that disagree with the code (README claims a feature that the code doesn't implement).",
      "Surface places where a one-paragraph explanation would save the next reader 30 minutes.",
    ],
  },
];

/** Pick the lens for a given mapper. mapperIndex starts at 2
 *  (agent-1 is reducer). Cycles through MAPPER_LENSES so a swarm
 *  with > 6 mappers wraps. */
export function lensForMapper(mapperIndex: number): MapperLens {
  const offset = Math.max(0, mapperIndex - 2);
  return MAPPER_LENSES[offset % MAPPER_LENSES.length]!;
}

export function buildMapperPrompt(
  mapperIndex: number,
  round: number,
  totalRounds: number,
  slice: readonly string[],
  seedSnapshot: readonly TranscriptEntry[],
  userDirective?: string,
  // T192 (2026-05-04): optional reframing from the previous reducer
  // turn's RE-TASK line. Surfaced as a high-priority directive ABOVE
  // the lens block so the mapper applies the new framing this cycle.
  reframing?: string,
): string {
  const seedText = seedSnapshot.map((e) => `[SYSTEM] ${e.text}`).join("\n\n");
  const sliceList = slice.length === 0 ? "(empty slice)" : slice.join(", ");
  // 2026-05-04 (idea T174): per-mapper lens.
  const lens = lensForMapper(mapperIndex);

  // 2026-05-02 (map-reduce improvement #1): when a directive is set,
  // mapper's job changes from "tell me everything about my slice" to
  // "find what in my slice bears on the directive". The "no relevant
  // findings" valve is critical — without it mappers with off-topic
  // slices will hallucinate relevance to seem useful.
  // 2026-05-03 (Phase A): directive block extracted to shared helper.
  const dirCtx = readDirective({ userDirective });
  const directiveBlock = buildDirectiveBlock(dirCtx, {
    labelSuffix: "(the question this map-reduce sweep is answering)",
    framingLines: [
      "**YOUR JOB UNDER THE DIRECTIVE:** Find what in YOUR slice bears on the directive. NOT what your slice is in general — only what's RELEVANT to the directive.",
      "**\"NO RELEVANT FINDINGS\" IS A VALID ANSWER.** If your slice has nothing that bears on the directive, report that explicitly — `My slice (path/, path/) contains no findings relevant to the directive: <one-line why not>`. Do NOT invent relevance to seem useful.",
    ],
  });

  const reportInstructions = dirCtx.hasDirective
    ? [
        "Produce a CONCRETE report (under ~300 words) covering:",
        "- For each finding: which file, what's relevant to the directive, what to do about it.",
        "- Cite file paths (e.g. `src/foo.ts:42`) for every claim. No claim without a file:line attribution.",
        "- If your slice has NOTHING relevant: one short paragraph explaining what your slice IS and why it doesn't bear on the directive. That is the full report — don't pad.",
      ]
    : [
        "Produce a CONCRETE report (under ~300 words) covering:",
        "- What each entry in your slice is (purpose / role).",
        "- Anything noteworthy: obvious defects, design choices, TODOs, test coverage gaps, interesting patterns.",
        "- Cite file paths (e.g. `src/foo.ts:42`) for any claim you make.",
      ];

  return [
    `You are Mapper Agent ${mapperIndex} in a map-reduce swarm.`,
    `This is cycle ${round}/${totalRounds}. You cannot see the reducer's output or any peer mapper's report — that is deliberate, so your report is independent.`,
    "",
    ...directiveBlock,
    `Your slice of the repo: ${sliceList}`,
    "Inspect ONLY the entries in your slice. Do not read or reference files outside your slice.",
    "Your working directory IS the project clone — use file-read, grep, and find-files tools to actually read the assigned entries.",
    "",
    // T192 (2026-05-04): reducer reframing — when set, prepended above
    // the lens block as a high-priority cycle-specific instruction.
    // Tells the mapper "the previous reducer noticed X — this cycle,
    // re-examine your slice through that frame."
    ...(reframing && reframing.trim().length > 0
      ? [
          `### REDUCER RE-TASK FOR YOUR SLICE THIS CYCLE`,
          `The previous reducer flagged you for re-examination with new framing:`,
          `> ${reframing.trim()}`,
          `Apply this framing IN ADDITION TO your standard lens (below). Both signals should shape your findings.`,
          "",
        ]
      : []),
    // 2026-05-04 (idea T174): per-mapper lens. Each mapper biases its
    // reading toward a different dimension so the swarm covers more
    // ground per cycle without re-reading the same files from the
    // same angle.
    `### YOUR LENS THIS CYCLE: ${lens.title} (id: ${lens.id})`,
    `**Read your slice through this lens specifically.** Other mappers cover other lenses; the reducer aggregates across them.`,
    ...lens.guidance.map((g) => `- ${g}`),
    `Tag your findings with their lens: prefix each finding line with \`[${lens.id}]\` so the reducer can group across mappers.`,
    "",
    ...reportInstructions,
    "",
    "Do NOT speculate about entries outside your slice.",
    "",
    // Phase B (Task #97): convergence signal. Mapper declares when
    // its slice is fully understood and further cycles would only
    // re-read the same files. When EVERY mapper reports COMPLETE,
    // the run can end early. Be honest — declaring complete on a
    // partially-understood slice wastes the reducer's time.
    "On the FINAL line of your response (no markdown, nothing after it), output exactly one of:",
    "  COMPLETE: true   — your slice is fully understood; you have nothing meaningful left to add even with more cycles.",
    "  COMPLETE: false  — there is more to investigate (gaps, ambiguity, unread files in your slice, etc).",
    "",
    "=== SEED ===",
    seedText || "(empty seed)",
    "=== END SEED ===",
    "",
    `Now respond as Mapper Agent ${mapperIndex}.`,
  ].join("\n");
}

export function buildReducerPrompt(
  round: number,
  totalRounds: number,
  transcript: readonly TranscriptEntry[],
  userDirective?: string,
): string {
  const transcriptText = transcript
    .map((e) => {
      if (e.role === "system") return `[SYSTEM] ${e.text}`;
      if (e.role === "user") return `[HUMAN] ${e.text}`;
      return `[Mapper ${e.agentIndex}] ${e.text}`;
    })
    .join("\n\n");

  // 2026-05-03 (Phase A): directive helpers extracted to shared module.
  const dirCtx = readDirective({ userDirective });
  const isFinal = round === totalRounds;

  // 2026-05-02 (map-reduce improvement #1): directive-aware synthesis.
  // When directive is set, the synthesis answers the directive directly
  // — Project-picture framing is replaced with Answer-to-directive
  // framing. Mid-cycle gap question becomes "which slice should be
  // re-issued to dig deeper into the directive".
  if (dirCtx.hasDirective) {
    const directiveClosing = isFinal
      ? "4. **Final answer to the directive** — your unified, evidence-backed answer with mapper + file citations. Name the single most important next step."
      : "4. **Coverage gap toward the directive** — name one slice / area no mapper has dug into yet that's likely to bear on the directive. Future cycle should target it.";
    return [
      `You are the REDUCER (Agent 1) in a map-reduce swarm.`,
      `This is the reduce step of cycle ${round}/${totalRounds}. Mapper agents just reported on their assigned slices of the repo.`,
      "",
      ...buildDirectiveBlock(dirCtx, {
        labelSuffix: "(the question this map-reduce sweep is answering)",
      }),
      "Your job is to SYNTHESIZE the mappers' findings into an answer to the directive. Do NOT summarize each mapper individually. Look for the things only visible from the reducer's vantage:",
      "  - DIRECT EVIDENCE: mapper findings that directly bear on the directive — list them with file paths.",
      "  - **CROSS-LENS PATTERNS:** mappers report findings tagged with their lens (e.g. `[security]`, `[performance]`, `[correctness]`). Group findings by lens AND by file — when the SAME file gets flagged across multiple lenses, that's a hot spot worth surfacing.",
      "  - SURPRISES: cross-slice findings that change the answer (e.g. Mapper 2's finding recontextualizes Mapper 4's).",
      "  - CONTRADICTIONS: mappers disagreeing about something the directive depends on. Name the mappers and the tension.",
      "  - SLICE GAPS: which mapper's slice contained no relevant findings (`COMPLETE: true` with `no findings relevant`) and whether that's a real gap or just an off-topic slice.",
      "",
      "Produce a synthesis (under ~600 words) structured as:",
      "1. **Answer to directive** — direct response to the user's question, evidence-backed by mapper findings + file paths.",
      "2. **Supporting evidence** — the specific mapper findings that ground your answer (cite Mapper N + file paths).",
      "3. **Tensions / open questions** — contradictions or things mappers couldn't determine that affect the answer's confidence.",
      directiveClosing,
      "",
      "Cite mappers by agent index (e.g. \"Mapper 3 noted…\") and the file paths they cited. Do NOT invent evidence beyond what mappers reported — if the directive can't be answered from the union of slices, say so explicitly.",
      "",
      // T190 (2026-05-04): reducer re-tasking. When a pattern emerges
      // from one mapper that another mapper's slice would benefit from
      // re-examining with fresh framing, the reducer can REQUEST a
      // re-task. Today the runner doesn't act on this (mappers always
      // get their original slice next cycle); the request lands in
      // the transcript so a future runner-side change can honor it.
      ...(isFinal
        ? []
        : [
            "**REDUCER RE-TASK (optional, mid-run only):** If a pattern from one mapper suggests another mapper should re-examine their slice with new framing, end your synthesis with one or more `RE-TASK:` lines:",
            "    RE-TASK: Mapper <N> | new-framing: <one short sentence>",
            "    RE-TASK: Mapper 4 | new-framing: re-examine src/auth/ specifically for shared-state hazards now that Mapper 2 surfaced the singleton pattern in src/db/.",
            "Use sparingly — re-tasking only pays off when the new framing is genuinely different. Today the runner logs these but doesn't auto-redispatch; future work will honor them.",
            "",
          ]),
      "=== TRANSCRIPT ===",
      transcriptText,
      "=== END TRANSCRIPT ===",
      "",
      "Now write your synthesis.",
    ].join("\n");
  }

  // No-directive path: original "tell me about this repo" framing.
  const closingInstruction = isFinal
    ? "4. Close with your final unified picture of the project: what it is, who it's for, and the single most important next step."
    : "4. Name one GAP in coverage — an area no mapper covered well or where their reports disagree — that a future cycle should target.";

  return [
    `You are the REDUCER (Agent 1) in a map-reduce swarm.`,
    `This is the reduce step of cycle ${round}/${totalRounds}. Mapper agents just reported on their assigned slices of the repo.`,
    "",
    "Your job is NOT to summarize each mapper individually — it is to SYNTHESIZE across them. Look for the things only visible from the reducer's vantage:",
    "  - SURPRISES: a finding from one mapper that recontextualizes another's slice (e.g. Mapper 2 found a singleton that explains the duplication Mapper 4 reported).",
    "  - CONTRADICTIONS: places where mappers reached different conclusions about the same area (e.g. Mapper 1 says the API is REST, Mapper 3 says it's gRPC — both can't be right).",
    "  - GAPS: the thing nobody covered well that the union of slices makes obvious.",
    "",
    "Produce a synthesis (under ~500 words) that:",
    "1. **Project picture** — what this codebase IS, who it's for, citing mapper findings.",
    "2. **Cross-slice surprises + contradictions** — what jumped out when you read all reports together. Name the mappers and the specific tension.",
    "3. **What's solid / what's missing** — with mapper + file attributions.",
    closingInstruction,
    "",
    "Cite mappers by their agent index (e.g. \"Mapper 3 noted…\") and by file paths they cited. Do NOT invent evidence beyond what mappers reported. Do NOT just restate each mapper in turn — that's the failure mode this prompt exists to prevent.",
    "",
    "=== TRANSCRIPT ===",
    transcriptText,
    "=== END TRANSCRIPT ===",
    "",
    "Now write your synthesis.",
  ].join("\n");
}

// T192 (2026-05-04): parse RE-TASK lines from a reducer's output.
// Format: `RE-TASK: Mapper <N> | new-framing: <one short sentence>`
// (case-insensitive on the keywords; tolerant of leading whitespace +
// optional bullet markers). Returns a Map<mapperIndex, framing>.
// Multiple RE-TASK lines for the same Mapper N → last one wins
// (assumption: reducer wouldn't naturally double-assign; if it did
// the last instruction is the latest thinking).
export function parseReducerReTaskLines(text: string): Map<number, string> {
  const out = new Map<number, string>();
  if (!text) return out;
  // Per-line scan — allow leading whitespace, optional bullet/quote
  // markers, then RE-TASK keyword.
  const re = /^[\s>*-]*RE[- ]TASK\s*:\s*Mapper\s+(\d+)\s*\|\s*new[- ]framing\s*:\s*(.+?)$/gim;
  for (const m of text.matchAll(re)) {
    const idx = Number.parseInt(m[1]!, 10);
    const framing = m[2]!.trim();
    if (Number.isFinite(idx) && idx >= 1 && framing.length > 0) {
      out.set(idx, framing);
    }
  }
  return out;
}

export function buildCouncilMapperDraftPrompt(
  slice: readonly string[],
  userDirective?: string,
  seedTranscript?: readonly TranscriptEntry[],
): string {
  const sliceList = slice.length === 0 ? "(empty slice)" : slice.join(", ");
  const seedLines =
    seedTranscript
      ?.filter((e) => e.role === "system" || e.role === "user")
      .slice(-5)
      .map((e) => `[${e.role}] ${e.text.slice(0, 300)}`)
      .join("\n") ?? "(no seed context)";

  return [
    "You are analyzing a slice of files for a map-reduce task. Produce your independent findings.",
    "",
    `Slice files: ${sliceList}`,
    "",
    `User directive: ${userDirective ?? "N/A"}`,
    "",
    "Seed context:",
    seedLines,
    "",
    "Provide your analysis in under 200 words.",
  ].join("\n");
}

export function buildCouncilMapperSynthesisPrompt(revised: string[]): string {
  return [
    "Synthesize the revised analyses into ONE unified finding for this file slice.",
    "",
    "Revised analyses:",
    ...revised.map((d, i) => `Agent ${i + 1}: ${d}`),
    "",
    "Produce a single synthesis in under 300 words.",
  ].join("\n");
}