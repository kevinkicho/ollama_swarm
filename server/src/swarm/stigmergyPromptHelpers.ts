// Module-level helpers extracted from StigmergyRunner.ts — pure prompt
// builders, parsers, annotation formatters, convergence checks, and
// supporting types/constants.  Kept in a separate file so the runner
// class stays focused on orchestration logic.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AnnotationState {
  visits: number;
  avgInterest: number;
  avgConfidence: number;
  latestNote: string;
  // 2026-05-02 (stigmergy improvement #5): round of last visit. Lets
  // the ranking formula apply pheromone decay — annotations from
  // earlier rounds with no follow-up fade vs files multiple explorers
  // revisited recently. Defaults to 1 for back-compat with pre-fix
  // states (e.g. recovered serialized annotations).
  lastVisitedRound?: number;
}

// T177 (2026-05-04): typed pheromones. Beyond the numeric interest +
// confidence, agents now tag annotations with a semantic kind so peer
// explorers + the final synthesis can read the pheromone trail with
// more nuance. Old annotations (no kind) still parse cleanly — kind
// is optional.
//
//   relevant       — file directly bears on the directive / project goal
//   dead-end       — file looks promising but doesn't help; don't burn turns here
//   needs-more-eyes — interesting but the agent's confidence is low; another agent should re-read
//   contradicts    — finding here disagrees with what another file/finding suggests
export type PheromoneKind = "relevant" | "dead-end" | "needs-more-eyes" | "contradicts";
export const PHEROMONE_KINDS: readonly PheromoneKind[] = [
  "relevant",
  "dead-end",
  "needs-more-eyes",
  "contradicts",
];

export interface ParsedAnnotation {
  file: string;
  interest: number;
  confidence: number;
  note: string;
  /** T177: optional semantic tag. Defaults to undefined for back-compat. */
  kind?: PheromoneKind;
}

interface BuildExplorerPromptArgs {
  agentIndex: number;
  round: number;
  totalRounds: number;
  candidatePaths: readonly string[];
  annotations: ReadonlyMap<string, AnnotationState>;
  territory?: string;
  recentlyActive?: readonly { file: string; round: number; note: string }[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SKIP_ENTRIES = new Set([".git/", ".git", "node_modules/", "node_modules", ".DS_Store"]);

// 2026-05-02 (stigmergy improvement #5): per-round decay factor.
// Each unvisited round multiplies the score by this factor — after
// 3 rounds untouched, score drops to ~34%. Tuned conservatively;
// dramatic decay would surprise users. Pure constant — exported for
// tests so the calibration is locked.
export const PHEROMONE_DECAY_PER_ROUND = 0.7;

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

// 2026-05-02 (stigmergy improvement #4): confidence weighting in the
// ranking score. Pre-fix the formula was (visits × avgInterest);
// confidence was captured but ignored. New formula:
//   score = visits × avgInterest × (avgConfidence / 10) × decay
// Confidence scaled to [0, 1] so a high-interest-low-confidence file
// (interest=10, confidence=2) ranks below a slightly-less-interesting-
// but-solid one (interest=8, confidence=9). Pure — exported for tests.
export function rankingScore(
  state: AnnotationState,
  currentRound?: number,
): number {
  const baseScore = state.visits * state.avgInterest * (state.avgConfidence / 10);
  if (currentRound === undefined || state.lastVisitedRound === undefined) {
    return baseScore;
  }
  const roundsSince = Math.max(0, currentRound - state.lastVisitedRound);
  return baseScore * Math.pow(PHEROMONE_DECAY_PER_ROUND, roundsSince);
}

// ---------------------------------------------------------------------------
// Annotation parsing
// ---------------------------------------------------------------------------

/** #303: strip the annotation JSON envelope from agent text so the
 *  visible bubble shows prose only. Removes (in order):
 *    1. ```json ... ``` fenced blocks
 *    2. ``` ... ``` (no language tag) blocks
 *    3. Trailing bare {...} blocks
 *  Trims trailing whitespace. Returns the cleaned text. Exported for
 *  tests. */
export function stripAnnotationEnvelope(text: string): string {
  let out = text;
  // Fenced JSON block (most common)
  out = out.replace(/```(?:json)?\s*\{[\s\S]*?\}\s*```\s*$/i, "");
  // Bare trailing {...} block (less common but the model sometimes
  // skips the fences and just emits raw JSON at the end)
  out = out.replace(/\s*\{[\s\S]*?\}\s*$/, "");
  return out.trimEnd();
}

// Exported for testability. Accepts JSON {file, interest, confidence, note}
// either as a raw object, fenced in markdown, or embedded in prose. Returns
// null if no usable annotation can be extracted; the caller treats this as
// "no pheromone update this turn" and just keeps the agent's text in the
// transcript. Lenient on integer-vs-float; clamps interest/confidence to
// [0, 10] so a confused model can't poison the table with extremes.
export function parseAnnotation(raw: string): ParsedAnnotation | null {
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const candidates = [fenceMatch ? fenceMatch[1] : null, raw].filter(Boolean) as string[];

  for (const candidate of candidates) {
    const ann = tryParseObject(candidate);
    if (ann) return ann;
  }
  return null;
}

function tryParseObject(input: string): ParsedAnnotation | null {
  // Try direct JSON first
  try {
    const parsed = JSON.parse(input);
    const ann = coerceAnnotation(parsed);
    if (ann) return ann;
  } catch {
    // fall through to brace-finding
  }
  // Try the first {...} block
  const braceMatch = input.match(/\{[\s\S]*?\}/);
  if (!braceMatch) return null;
  try {
    const parsed = JSON.parse(braceMatch[0]);
    return coerceAnnotation(parsed);
  } catch {
    return null;
  }
}

function coerceAnnotation(parsed: unknown): ParsedAnnotation | null {
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  const file = typeof o.file === "string" ? o.file.trim() : null;
  const interestRaw = typeof o.interest === "number" ? o.interest : null;
  const confidenceRaw = typeof o.confidence === "number" ? o.confidence : null;
  const note = typeof o.note === "string" ? o.note.trim() : "";
  if (!file || interestRaw === null || confidenceRaw === null) return null;
  // Clamp [0, 10] so a model that emits 100 or -5 can't poison the table.
  const interest = Math.max(0, Math.min(10, interestRaw));
  const confidence = Math.max(0, Math.min(10, confidenceRaw));
  // T177: optional kind. Whitelist against the catalog so a model
  // emitting "kinda-relevant" or "?" doesn't get accepted.
  const kindRaw = typeof o.kind === "string" ? o.kind.trim().toLowerCase() : "";
  const kind = (PHEROMONE_KINDS as readonly string[]).includes(kindRaw)
    ? (kindRaw as PheromoneKind)
    : undefined;
  return {
    file,
    interest,
    confidence,
    note,
    ...(kind ? { kind } : {}),
  };
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

export function buildExplorerPrompt(args: BuildExplorerPromptArgs): string {
  const { agentIndex, round, totalRounds, candidatePaths, annotations, territory, recentlyActive } = args;
  const tableText = formatAnnotations(annotations);
  const candidateText = candidatePaths.length > 0 ? candidatePaths.join(", ") : "(none — repo seems empty)";

  const parts: string[] = [
    `You are Agent ${agentIndex}, an explorer in a stigmergy swarm reviewing a cloned GitHub project.`,
    `This is round ${round}/${totalRounds}. The lead may have suggested a starting territory for you (see below); the pheromone trail is shared so every agent's exploration informs the next.`,
    "",
    "Your turn:",
    "1. Look at the annotation table. Untouched files are most attractive. Among visited files, prefer high INTEREST + low CONFIDENCE — those are interesting and not yet understood. Avoid files that are well-covered (multiple visits, high confidence).",
    "2. Pick ONE file or directory entry to inspect. Read it (or sample it if it's large) using the file-read tool. Be concrete about what you read.",
    "3. Output BOTH a short prose report (under 200 words) AND a final JSON annotation block on the last line.",
    "",
    "Annotation JSON shape (last line of your response, no markdown fences):",
    '{"file": "src/foo.ts", "interest": 0-10, "confidence": 0-10, "note": "one-line summary", "kind": "relevant"}',
    "",
    "Where:",
    "- `interest` = how much further investigation this file warrants (10 = very interesting / load-bearing / surprising; 0 = boring / trivial).",
    "- `confidence` = how well YOU understand it after this read (10 = fully understood; 0 = barely scratched the surface).",
    "- `note` = one-line summary that future agents can use as a pheromone signal.",
    // T177 (2026-05-04): typed pheromones. Optional — omit kind if
    // none clearly fits. Future explorers + the synthesis read kind
    // to make smarter next-file decisions instead of relying solely
    // on the numeric interest/confidence scores.
    '- `kind` (optional) = one of: "relevant" (directly bears on the directive), "dead-end" (looks promising but doesn\'t help — don\'t burn turns here), "needs-more-eyes" (interesting but your confidence is low; another agent should re-read), "contradicts" (your finding disagrees with another file\'s implication).',
    "",
    `Top-level candidates: ${candidateText}`,
  ];
  // 2026-05-02 (improvement #2): territory assignment from lead's plan.
  if (territory && territory.trim().length > 0) {
    parts.push("");
    parts.push(`=== YOUR ASSIGNED TERRITORY (lead's pre-round plan) ===`);
    parts.push(territory.trim());
    parts.push(`=== END TERRITORY ===`);
    parts.push(`This is a SUGGESTION — start here, but follow the pheromone trail if peers' annotations make a different file more interesting.`);
  }
  // 2026-05-02 (improvement #1): recent-activity highlight (round 2+).
  if (recentlyActive && recentlyActive.length > 0) {
    parts.push("");
    parts.push(`=== RECENTLY ACTIVE (peers' annotations from the last 1-2 rounds) ===`);
    for (const r of recentlyActive) {
      parts.push(`- ${r.file} (round ${r.round}): ${r.note}`);
    }
    parts.push(`=== END RECENT ===`);
    parts.push(`These files just got peer attention. Either VALIDATE/REFUTE the recent annotations OR seek UNEXPLORED ground — don't redundantly re-walk what was just covered.`);
  }
  parts.push("");
  parts.push("=== ANNOTATION TABLE (current, cumulative across all rounds) ===");
  parts.push(tableText);
  parts.push("=== END TABLE ===");
  parts.push("");
  parts.push(`Now respond as Agent ${agentIndex}. Remember: prose report THEN annotation JSON on the last line.`);
  return parts.join("\n");
}

// 2026-05-02 (improvement #2): pure prompt builder for the lead's
// pre-round-1 territory plan. Asks the lead to assign each explorer a
// starting territory based on the directive + repo top-level structure.
// Output is strict JSON: {"<agentIndex>": "<territory description>"}.
// Pure — exported for tests.
export function buildTerritoryPlanPrompt(input: {
  directive: string;
  candidatePaths: readonly string[];
  explorerCount: number;
}): string {
  const indices = Array.from({ length: input.explorerCount }, (_, i) => i + 1);
  return [
    "You are Agent 1, the lead explorer in a stigmergy swarm. Before round 1 starts, you're issuing per-explorer TERRITORY ASSIGNMENTS — a starting hint for each explorer based on the user's directive + the repo's top-level structure.",
    "",
    "GOAL: prevent accidental overlap. Without territory assignments, multiple explorers may walk the same area in parallel — wasted work. Your assignments give each explorer a focal point so they spread out naturally on round 1.",
    "",
    "Your assignment is a SUGGESTION. Explorers can wander based on the pheromone trail; you're seeding their starting point, not constraining them.",
    "",
    `USER DIRECTIVE: ${input.directive.trim() || "(no directive)"}`,
    `REPO TOP-LEVEL CANDIDATES: ${input.candidatePaths.length > 0 ? input.candidatePaths.join(", ") : "(empty)"}`,
    `EXPLORER COUNT: ${input.explorerCount} (you yourself are agent 1; assign all of them including yourself).`,
    "",
    "Output STRICT JSON only (no prose, no markdown fences). Shape:",
    `  {${indices.map((i) => `"${i}": "<short territory description for agent ${i}>"`).join(", ")}}`,
    "",
    "Rules:",
    "- One key per explorer index, all keys MUST be present.",
    "- Each value is 5-30 words: name a directory, file pattern, or theme.",
    "- Distribute coverage broadly — avoid sending two explorers to the same dir.",
    "- Anchor in the directive when relevant (e.g. directive about auth → assign someone to auth/).",
    "- For repos smaller than the explorer count, allow overlap with different angles (e.g. 'src/ — focus on tests' vs 'src/ — focus on entry points').",
    "",
    "Output JSON now:",
  ].join("\n");
}

/** Pure parser for the lead's territory plan response. Returns
 *  Map<agentIndex, territory> on success, null on parse failure.
 *  Best-effort — strips ```json fences, finds the first {} block.
 *  Exported for tests. */
export function parseTerritoryPlan(raw: string): Map<number, string> | null {
  if (!raw || typeof raw !== "string") return null;
  let cleaned = raw.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) cleaned = fenceMatch[1].trim();
  const objMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!objMatch) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(objMatch[0]);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const out = new Map<number, string>();
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const idx = Number.parseInt(key, 10);
    if (!Number.isFinite(idx) || idx < 1) continue;
    if (typeof value !== "string" || value.trim().length === 0) continue;
    out.set(idx, value.trim());
  }
  if (out.size === 0) return null;
  return out;
}

// ---------------------------------------------------------------------------
// Convergence / ranking helpers
// ---------------------------------------------------------------------------

// Phase B (Task #98): produce a stable signature of the current top-10
// ranking. Uses file names only — small score jitter shouldn't reset the
// stability window. A delimiter that can't appear in a path keeps the
// signature unambiguous.
//
// 2026-05-02 (improvements #4 + #5): now uses confidence-weighted +
// decay-aware rankingScore. currentRound is optional for back-compat
// with callers that don't have round context.
export function computeRankingSignature(
  annotations: ReadonlyMap<string, AnnotationState>,
  currentRound?: number,
): string {
  const ranked = [...annotations.entries()]
    .map(([file, a]) => ({ file, score: rankingScore(a, currentRound) }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.file.localeCompare(a.file);
    })
    .slice(0, 10)
    .map((r) => r.file);
  return ranked.join("␟");
}

// T187 (2026-05-04): build the hot-files section that the T2.3 chain
// hint will extract a recommendation from. Picks top-K files by
// rankingScore, formats them as a clear next-action prose block so
// extractNextActions sees the structure. When pheromones are absent
// (degenerate run) returns a placeholder explaining that no chain
// target was identified.
export function buildHotFilesChainSection(
  annotations: ReadonlyMap<string, AnnotationState>,
  currentRound: number,
  topN: number = 3,
): string {
  if (annotations.size === 0) {
    return "_(no annotations captured — no chain target identified; the run produced no actionable file-level signal)_";
  }
  const ranked = [...annotations.entries()]
    .map(([file, a]) => ({ file, state: a, score: rankingScore(a, currentRound) }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.file.localeCompare(a.file);
    })
    .slice(0, topN);
  if (ranked.length === 0) {
    return "_(ranking returned empty — no chain target identified)_";
  }
  const lines: string[] = [];
  lines.push(
    "These files accumulated the most pheromone signal during exploration. Recommended next blackboard run: target these files specifically as the directive.",
  );
  lines.push("");
  lines.push("**Top hot files (by pheromone score):**");
  for (const r of ranked) {
    lines.push(
      `- \`${r.file}\` — visits=${r.state.visits}, interest=${r.state.avgInterest.toFixed(1)}/10, confidence=${r.state.avgConfidence.toFixed(1)}/10, score=${r.score.toFixed(1)}. Latest note: "${r.state.latestNote}"`,
    );
  }
  lines.push("");
  lines.push("**Recommended chain action:**");
  const fileList = ranked.map((r) => r.file).join(", ");
  lines.push(
    `- Audit ${fileList} via blackboard preset; the stigmergy run flagged these as high-interest with mid-to-low confidence — they likely repay deeper investigation.`,
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatAnnotations(annotations: ReadonlyMap<string, AnnotationState>): string {
  if (annotations.size === 0) return "(empty — no files annotated yet; everything is untouched)";
  const rows: string[] = [];
  // Sort: most-visited first, then by file name for stability
  const entries = [...annotations.entries()].sort((a, b) => {
    if (b[1].visits !== a[1].visits) return b[1].visits - a[1].visits;
    return a[0].localeCompare(b[0]);
  });
  for (const [file, s] of entries) {
    rows.push(
      `${file} — visits=${s.visits} interest=${s.avgInterest.toFixed(1)} confidence=${s.avgConfidence.toFixed(1)} note="${s.latestNote}"`,
    );
  }
  return rows.join("\n");
}

// ---------------------------------------------------------------------------
// Error formatting
// ---------------------------------------------------------------------------

export function describeSdkError(err: unknown): string {
  if (err instanceof Error) {
    const parts: string[] = [err.message];
    let cause: unknown = (err as { cause?: unknown }).cause;
    let depth = 0;
    while (cause && depth < 4) {
      if (cause instanceof Error) {
        const code = (cause as { code?: string }).code;
        parts.push(code ? `${cause.message} [${code}]` : cause.message);
        cause = (cause as { cause?: unknown }).cause;
      } else {
        parts.push(String(cause));
        cause = undefined;
      }
      depth++;
    }
    return parts.join(" <- ");
  }
  if (err && typeof err === "object") {
    const o = err as { name?: string; message?: string };
    const head = o.name ? `${o.name}: ` : "";
    if (o.message) return head + o.message;
    try {
      return head + JSON.stringify(o).slice(0, 500);
    } catch {
      return head + String(err);
    }
  }
  return String(err);
}