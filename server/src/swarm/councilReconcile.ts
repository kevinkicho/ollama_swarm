// T-Item-CouncilRec (2026-05-04): pure helpers for the council
// reconcile policies (vote / judge). Default reconcile (revise+merge)
// stays in CouncilRunner.runSynthesisPass.
//
// `tallyVotes` is the load-bearing pure function. Each drafter casts
// ONE vote naming the BEST OTHER agent's draft. We aggregate, pick
// the highest, break ties by lowest agent index for determinism.

export interface VoteRecord {
  /** Agent that cast the vote. */
  voterIndex: number;
  /** Agent index they voted FOR (≠ voterIndex). null when the model
   *  didn't comply with the format / voted for self / for an unknown
   *  index — counted as an abstention. */
  votedForIndex: number | null;
  /** One-sentence rationale (best-effort; empty when not provided). */
  rationale: string;
}

export interface VoteTally {
  /** Map agentIndex → vote count. Non-voted agents have count 0. */
  countsByIndex: Map<number, number>;
  /** Winner: highest count, lowest-index tie-break. null when no
   *  vote landed (all abstentions). */
  winnerIndex: number | null;
  /** Total non-abstention votes counted. */
  totalVotes: number;
  /** Total abstentions (votedForIndex null OR self-vote). */
  abstentions: number;
}

/** Tally a list of vote records into a winner. Self-votes + null
 *  votes count as abstentions. Tie-break: lowest agentIndex among
 *  the top-tied candidates wins (deterministic). */
export function tallyVotes(
  votes: readonly VoteRecord[],
  validAgentIndexes: readonly number[],
): VoteTally {
  const countsByIndex = new Map<number, number>();
  for (const i of validAgentIndexes) countsByIndex.set(i, 0);
  let totalVotes = 0;
  let abstentions = 0;
  const validSet = new Set(validAgentIndexes);
  for (const v of votes) {
    if (
      v.votedForIndex === null ||
      v.votedForIndex === v.voterIndex ||
      !validSet.has(v.votedForIndex)
    ) {
      abstentions++;
      continue;
    }
    countsByIndex.set(
      v.votedForIndex,
      (countsByIndex.get(v.votedForIndex) ?? 0) + 1,
    );
    totalVotes++;
  }
  // Pick the winner: highest count, tie-break by lowest index
  let winnerIndex: number | null = null;
  let topCount = 0;
  for (const [idx, count] of [...countsByIndex.entries()].sort(
    (a, b) => a[0] - b[0],
  )) {
    if (count > topCount) {
      topCount = count;
      winnerIndex = idx;
    }
  }
  if (topCount === 0) winnerIndex = null;
  return { countsByIndex, winnerIndex, totalVotes, abstentions };
}

/** Build the per-drafter vote prompt. The drafter has just finished
 *  the final round + sees ALL drafts — now they pick the best OTHER
 *  one. Output schema is strict JSON for parser stability. */
export function buildVotePrompt(args: {
  voterIndex: number;
  /** All draft entries from the final round, in agent-index order.
   *  Each carries the agentIndex for cross-reference. */
  drafts: readonly { agentIndex: number; text: string }[];
  userDirective?: string;
}): string {
  const { voterIndex, drafts, userDirective } = args;
  const directive = userDirective?.trim();
  const draftBlocks = drafts.map(
    (d) =>
      `=== DRAFT FROM AGENT ${d.agentIndex} ===\n${d.text.trim()}\n=== END ===`,
  );
  return [
    `You are Agent ${voterIndex} casting a vote in the council reconcile phase.`,
    `Read every OTHER agent's final draft below. Pick the ONE you find most`,
    `compelling — best evidence, sharpest reasoning, most actionable.`,
    `You may NOT vote for yourself.`,
    ...(directive ? [``, `Directive: ${directive}`, ``] : []),
    ``,
    ...draftBlocks,
    ``,
    `Output STRICT JSON only (no prose, no fences):`,
    `{"votedForIndex": <agent index, integer ≠ ${voterIndex}>, "rationale": "<one sentence why>"}`,
  ].join("\n");
}

/** Lenient parser for the per-drafter vote response. Returns null
 *  on any parse failure — caller treats as abstention. */
export function parseVoteResponse(
  raw: string,
  voterIndex: number,
): { votedForIndex: number | null; rationale: string } {
  const text = raw.trim();
  if (!text) return { votedForIndex: null, rationale: "" };
  const candidates: string[] = [text];
  const fence = /```(?:json)?\s*\n?([\s\S]*?)\n?```/m.exec(text);
  if (fence) candidates.push(fence[1].trim());
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(text.slice(firstBrace, lastBrace + 1));
  }
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c) as Record<string, unknown>;
      const v = parsed.votedForIndex;
      if (typeof v === "number" && Number.isInteger(v) && v !== voterIndex) {
        const rationale =
          typeof parsed.rationale === "string" ? parsed.rationale.trim() : "";
        return { votedForIndex: v, rationale };
      }
    } catch {
      // try next candidate
    }
  }
  return { votedForIndex: null, rationale: "" };
}

/**
 * Lead-agent "judge" reconcile prompt: pick ONE draft as canonical
 * (vs. revise+merge synthesis). Used when cfg.councilReconcile === "judge".
 */
export function buildJudgePickPrompt(args: {
  drafts: readonly { agentIndex: number; text: string }[];
  userDirective?: string;
}): string {
  const { drafts, userDirective } = args;
  const directive = userDirective?.trim();
  const draftBlocks = drafts.map(
    (d) =>
      `=== DRAFT FROM AGENT ${d.agentIndex} ===\n${d.text.trim()}\n=== END ===`,
  );
  return [
    `You are the council lead reconciling peer drafts.`,
    `Read every draft below. PICK ONE as the canonical answer — do not merge`,
    `conflicting claims into a compromise unless they genuinely agree.`,
    `You may briefly cite why the winner is strongest, then present that draft's`,
    `substance as the final council output (paraphrase or quote key points).`,
    ...(directive ? [``, `Directive: ${directive}`, ``] : [``]),
    ...draftBlocks,
    ``,
    `Start with a one-line header: WINNER: agent-<index>`,
    `Then the full canonical answer (clear, actionable, grounded in the winner).`,
  ].join("\n");
}

/** Keep the latest non-empty draft per agentIndex (sorted by index). */
export function latestDraftsByAgent(
  drafts: readonly { agentIndex: number; text: string }[],
): { agentIndex: number; text: string }[] {
  const map = new Map<number, string>();
  for (const d of drafts) {
    const t = (d.text ?? "").trim();
    if (!t) continue;
    map.set(d.agentIndex, t);
  }
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([agentIndex, text]) => ({ agentIndex, text }));
}

/** Compact tally for system lines / lead present prompt. */
export function formatVoteTallySummary(tally: VoteTally): string {
  const parts = [...tally.countsByIndex.entries()]
    .filter(([, c]) => c > 0)
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([idx, c]) => `agent-${idx}:${c}`);
  const body = parts.length > 0 ? parts.join(" ") : "no votes";
  return `${body} (total=${tally.totalVotes}, abstain=${tally.abstentions})`;
}

/**
 * After ballots, lead presents the winning draft as the council answer
 * (does not re-merge peers). Used when cfg.councilReconcile === "vote".
 */
export function buildVoteWinnerPresentPrompt(args: {
  winnerIndex: number;
  winnerText: string;
  tallySummary: string;
  userDirective?: string;
}): string {
  const directive = args.userDirective?.trim();
  return [
    `The council vote selected agent-${args.winnerIndex} as the winning draft.`,
    `Tally: ${args.tallySummary}`,
    `Present that draft as the FINAL council output.`,
    `You may polish clarity and structure, but do NOT invent new claims or`,
    `merge rejected drafts. Stay faithful to the winner.`,
    ...(directive ? [``, `Directive: ${directive}`, ``] : [``]),
    `=== WINNING DRAFT (agent-${args.winnerIndex}) ===`,
    args.winnerText.trim(),
    `=== END WINNING DRAFT ===`,
    ``,
    `Start with: WINNER: agent-${args.winnerIndex}`,
    `Then the full canonical answer.`,
  ].join("\n");
}
