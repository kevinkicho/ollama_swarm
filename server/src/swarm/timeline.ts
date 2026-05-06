// Direction 6 Phase 2: event timeline API.
//
// Replays the event log persisted by RunStatePersister to build a
// structured timeline of a run's lifecycle — phases, agent activity,
// and checkpoint markers. The timeline UI component consumes this
// to render a scrubable view of what happened during the run.

import { promises as fs } from "node:fs";
import path from "node:path";

import type { SwarmPhase } from "../types.js";

export interface TimelinePhase {
  phase: SwarmPhase;
  startEventIndex: number;
  endEventIndex?: number;
  round?: number;
}

export interface TimelineAgent {
  agentId: string;
  agentIndex: number;
  model?: string;
  startEventIndex: number;
  endEventIndex?: number;
  turnCount: number;
}

export interface TimelineCheckpoint {
  round: number;
  agentIndex: number;
  timestamp: number;
  fileName: string;
}

export interface Timeline {
  runId: string;
  startTime: number;
  endTime?: number;
  phases: TimelinePhase[];
  agents: TimelineAgent[];
  checkpoints: TimelineCheckpoint[];
  totalEvents: number;
}

interface PersistedEvent {
  type: string;
  ts?: number;
  phase?: SwarmPhase;
  round?: number;
  agentId?: string;
  agentIndex?: number;
  model?: string;
  runId?: string;
  startedAt?: number;
}

const STATE_DIR = ".swarm-state";

async function readEventLog(clonePath: string, runId: string): Promise<PersistedEvent[]> {
  const dir = path.join(clonePath, STATE_DIR);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const events: PersistedEvent[] = [];
  for (const entry of entries) {
    if (!entry.startsWith(`events-${runId}`) || !entry.endsWith(".jsonl")) continue;
    const filePath = path.join(dir, entry);
    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object" && typeof parsed.type === "string") {
          events.push(parsed);
        }
      } catch {
        // skip malformed
      }
    }
  }
  return events;
}

export function buildTimeline(events: PersistedEvent[], checkpoints?: TimelineCheckpoint[]): Timeline | null {
  if (events.length === 0) return null;

  let runId = "";
  let startTime: number | undefined;
  let endTime: number | undefined;
  const phases: TimelinePhase[] = [];
  const agents: Map<string, TimelineAgent> = new Map();

  let currentPhase: SwarmPhase | undefined;
  let phaseStartIndex = 0;

  for (let i = 0; i < events.length; i++) {
    const ev = events[i]!;

    if (ev.type === "run_started") {
      runId = ev.runId ?? "";
      startTime = ev.startedAt ?? ev.ts;
    }

    if (ev.type === "run_summary" && ev.ts) {
      endTime = ev.ts;
    }

    if (ev.type === "swarm_state" && ev.phase && ev.phase !== currentPhase) {
      if (currentPhase !== undefined) {
        phases[phases.length - 1]!.endEventIndex = i - 1;
      }
      phases.push({
        phase: ev.phase,
        startEventIndex: i,
        round: ev.round,
      });
      currentPhase = ev.phase;
    }

    if (ev.type === "agent_state" && ev.agentId) {
      const existing = agents.get(ev.agentId);
      if (!existing) {
        agents.set(ev.agentId, {
          agentId: ev.agentId,
          agentIndex: ev.agentIndex ?? 0,
          model: ev.model,
          startEventIndex: i,
          turnCount: 0,
        });
      }
      if (ev.model) {
        const a = agents.get(ev.agentId);
        if (a) a.model = ev.model;
      }
    }

    if (ev.type === "transcript_append" && ev.agentId) {
      const a = agents.get(ev.agentId);
      if (a) a.turnCount++;
    }
  }

  if (startTime === undefined) {
    startTime = events[0]?.ts ?? 0;
  }

  return {
    runId,
    startTime,
    endTime,
    phases,
    agents: [...agents.values()],
    checkpoints: checkpoints ?? [],
    totalEvents: events.length,
  };
}

export async function getTimeline(clonePath: string, runId: string): Promise<Timeline | null> {
  const events = await readEventLog(clonePath, runId);
  if (events.length === 0) return null;

  let checkpoints: TimelineCheckpoint[] = [];
  try {
    const { listCheckpoints } = await import("../swarm/checkpoint.js");
    const ckpts = await listCheckpoints(clonePath, runId);
    checkpoints = ckpts.map((c) => ({
      round: c.round,
      agentIndex: c.agentIndex,
      timestamp: c.timestamp,
      fileName: `checkpoint-${c.round}-${c.agentIndex}-${c.timestamp}.json`,
    }));
  } catch {
    // checkpoints not available
  }

  return buildTimeline(events, checkpoints);
}