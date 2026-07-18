/** Persisted / hydrated swarm control center advice records.
 *  Operator mental model: **run resilience** — thrash brakes, stall recovery,
 *  quality gates, and Brain OS helpers that keep runs durable under failure. */

export interface SwarmControlAdviceRecord {
  ts: number;
  kind: "stall_gate" | "tool_coach" | "brain_os";
  action?: "backoff" | "retry" | "stop";
  source?: "rule" | "arbitrator" | "brain_os";
  rationale: string;
  plannerHint?: string;
  agentId?: string;
  tool?: string;
  /** Brain OS conflict kind when kind=brain_os. */
  conflictKind?: string;
  /** Brain OS dispatch status when kind=brain_os. */
  status?: string;
}

const STALL_GATE_RE =
  /^\[control\] Stall gate \((rule|arbitrator)\): (backoff|retry|stop) — (.+)$/i;
const TOOL_COACH_RE = /^\[control\] Tool coach \(([^,]+), \d+×\): (.+)$/i;
const STALL_ARBITRATOR_RE =
  /^\[control\] Stall arbitrator invoked \(\d+\/\d+\) — class=(.+)\.$/i;
const BRAIN_OS_DONE_RE =
  /^\[brain-os\] done status=(\w+)\s+effects[^\s]*:\s*(.+)$/i;
const BRAIN_OS_DISPATCH_RE =
  /^\[brain-os\] dispatch kind=(\S+)\s+privilege=(\S+)\s+depth=(\d+)/i;
const BRAIN_OS_HELPER_RE =
  /^\[brain-os\] helper (\S+) recruited kind=(\S+)/i;

/** Reconstruct advice entries from `[control]` system transcript lines (history fallback). */
export function extractControlAdviceFromTranscript(
  transcript: ReadonlyArray<{ role: string; text: string; ts?: number }>,
): SwarmControlAdviceRecord[] {
  const out: SwarmControlAdviceRecord[] = [];
  for (const entry of transcript) {
    if (entry.role !== "system") continue;
    const text = entry.text?.trim() ?? "";
    const ts = entry.ts ?? Date.now();

    const stall = text.match(STALL_GATE_RE);
    if (stall) {
      out.push({
        ts,
        kind: "stall_gate",
        action: stall[2] as SwarmControlAdviceRecord["action"],
        source: stall[1] as SwarmControlAdviceRecord["source"],
        rationale: stall[3]!,
      });
      continue;
    }

    const coach = text.match(TOOL_COACH_RE);
    if (coach) {
      out.push({
        ts,
        kind: "tool_coach",
        tool: coach[1]!.trim(),
        rationale: coach[2]!,
      });
      continue;
    }

    const arb = text.match(STALL_ARBITRATOR_RE);
    if (arb) {
      out.push({
        ts,
        kind: "stall_gate",
        source: "arbitrator",
        rationale: `Stall arbitrator invoked (class=${arb[1]})`,
      });
      continue;
    }

    const bosDone = text.match(BRAIN_OS_DONE_RE);
    if (bosDone) {
      out.push({
        ts,
        kind: "brain_os",
        source: "brain_os",
        status: bosDone[1],
        rationale: bosDone[2]!.slice(0, 500),
      });
      continue;
    }
    const bosDispatch = text.match(BRAIN_OS_DISPATCH_RE);
    if (bosDispatch) {
      out.push({
        ts,
        kind: "brain_os",
        source: "brain_os",
        conflictKind: bosDispatch[1],
        rationale: `dispatch ${bosDispatch[1]} (privilege=${bosDispatch[2]}, depth=${bosDispatch[3]})`,
      });
      continue;
    }
    const bosHelper = text.match(BRAIN_OS_HELPER_RE);
    if (bosHelper) {
      out.push({
        ts,
        kind: "brain_os",
        source: "brain_os",
        agentId: bosHelper[1],
        conflictKind: bosHelper[2],
        rationale: `helper recruited for ${bosHelper[2]}`,
      });
    }
  }
  return out;
}

/** Parse `swarm_control_advice` events from event-log replay records. */
export function extractControlAdviceFromEventRecords(
  records: ReadonlyArray<{ event?: { type?: string; ts?: number; [key: string]: unknown } }>,
): SwarmControlAdviceRecord[] {
  const out: SwarmControlAdviceRecord[] = [];
  for (const rec of records) {
    const ev = rec.event;
    if (!ev || ev.type !== "swarm_control_advice") continue;
    out.push({
      ts: typeof ev.ts === "number" ? ev.ts : Date.now(),
      kind: ev.kind as SwarmControlAdviceRecord["kind"],
      ...(ev.action ? { action: ev.action as SwarmControlAdviceRecord["action"] } : {}),
      ...(ev.source ? { source: ev.source as SwarmControlAdviceRecord["source"] } : {}),
      rationale: String(ev.rationale ?? ""),
      ...(ev.plannerHint ? { plannerHint: String(ev.plannerHint) } : {}),
      ...(ev.agentId ? { agentId: String(ev.agentId) } : {}),
      ...(ev.tool ? { tool: String(ev.tool) } : {}),
      ...(ev.conflictKind ? { conflictKind: String(ev.conflictKind) } : {}),
      ...(ev.status ? { status: String(ev.status) } : {}),
    });
  }
  return out;
}

/** Merge persisted, transcript-derived, and event-log advice (dedupe by kind+ts+rationale). */
export function mergeControlAdvice(
  ...sources: ReadonlyArray<SwarmControlAdviceRecord>[]
): SwarmControlAdviceRecord[] {
  const seen = new Set<string>();
  const out: SwarmControlAdviceRecord[] = [];
  for (const list of sources) {
    for (const a of list) {
      const key = `${a.kind}|${a.ts}|${a.rationale.slice(0, 80)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(a);
    }
  }
  out.sort((a, b) => a.ts - b.ts);
  return out.slice(-40);
}

/** Compact resilience rollup for UI chips + summary.json. */
export interface ResilienceRollup {
  stallGates: number;
  toolCoaches: number;
  brainOsEvents: number;
  stopActions: number;
  backoffActions: number;
  /** 0–100 heuristic: more recovery actions + fewer hard stops = healthier. */
  score: number;
  label: string;
}

export function computeResilienceRollup(
  advice: ReadonlyArray<SwarmControlAdviceRecord>,
  deliberation?: ReadonlyArray<{ verdict?: string }>,
): ResilienceRollup {
  let stallGates = 0;
  let toolCoaches = 0;
  let brainOsEvents = 0;
  let stopActions = 0;
  let backoffActions = 0;
  for (const a of advice) {
    if (a.kind === "stall_gate") stallGates += 1;
    else if (a.kind === "tool_coach") toolCoaches += 1;
    else if (a.kind === "brain_os") brainOsEvents += 1;
    if (a.action === "stop") stopActions += 1;
    if (a.action === "backoff") backoffActions += 1;
  }
  const deny = deliberation?.filter((d) => d.verdict === "deny").length ?? 0;
  const approve = deliberation?.filter((d) => d.verdict === "approve").length ?? 0;
  // Start healthy; thrash brakes and helpers add confidence; hard stops hurt.
  let score = 72;
  score += Math.min(12, toolCoaches * 2);
  score += Math.min(12, brainOsEvents * 3);
  score += Math.min(8, backoffActions * 2);
  score += Math.min(8, Math.floor(approve / 2));
  score -= Math.min(30, stopActions * 12);
  score -= Math.min(15, Math.floor(deny / 3));
  score = Math.max(0, Math.min(100, score));
  const label =
    score >= 80
      ? "durable"
      : score >= 55
        ? "stabilizing"
        : score >= 35
          ? "stressed"
          : "fragile";
  return {
    stallGates,
    toolCoaches,
    brainOsEvents,
    stopActions,
    backoffActions,
    score,
    label,
  };
}