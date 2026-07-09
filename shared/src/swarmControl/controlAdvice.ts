/** Persisted / hydrated swarm control center advice records. */

export interface SwarmControlAdviceRecord {
  ts: number;
  kind: "stall_gate" | "tool_coach";
  action?: "backoff" | "retry" | "stop";
  source?: "rule" | "arbitrator";
  rationale: string;
  plannerHint?: string;
  agentId?: string;
  tool?: string;
}

const STALL_GATE_RE =
  /^\[control\] Stall gate \((rule|arbitrator)\): (backoff|retry|stop) — (.+)$/i;
const TOOL_COACH_RE = /^\[control\] Tool coach \(([^,]+), \d+×\): (.+)$/i;
const STALL_ARBITRATOR_RE =
  /^\[control\] Stall arbitrator invoked \(\d+\/\d+\) — class=(.+)\.$/i;

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