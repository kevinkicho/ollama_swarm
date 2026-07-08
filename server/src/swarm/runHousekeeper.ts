import { randomUUID } from "node:crypto";
import type { TranscriptEntry } from "../types.js";
import type { TranscriptEntrySummary } from "../types.js";
import {
  detectStreamAnomalies,
  type StreamAnomalyFinding,
} from "./streamAnomalyDetector.js";

export type HousekeeperEmit = (entry: TranscriptEntry) => void;

interface AgentTurnState {
  lastCheckedLen: number;
  emittedFingerprints: Set<string>;
  lengthMilestones: Set<number>;
}

const CHECK_CHAR_INTERVAL = 5_000;
const MIN_STREAM_LEN = 10_000;

/**
 * Agent-0 run housekeeper: watches all agents' streaming text and posts
 * evidence-backed alerts when anomalies appear.
 */
export class RunHousekeeper {
  private readonly perAgent = new Map<string, AgentTurnState>();

  constructor(
    private readonly emit: HousekeeperEmit,
    private readonly runId: string,
  ) {}

  resetTurn(agentId: string): void {
    this.perAgent.delete(agentId);
  }

  observe(agentId: string, agentIndex: number, cumulativeText: string): void {
    if (agentIndex === 0) return;
    if (cumulativeText.length < MIN_STREAM_LEN) return;

    let state = this.perAgent.get(agentId);
    if (!state) {
      state = {
        lastCheckedLen: 0,
        emittedFingerprints: new Set(),
        lengthMilestones: new Set(),
      };
      this.perAgent.set(agentId, state);
    }

    if (cumulativeText.length - state.lastCheckedLen < CHECK_CHAR_INTERVAL) return;
    state.lastCheckedLen = cumulativeText.length;

    const findings = detectStreamAnomalies(
      cumulativeText,
      { minLength: MIN_STREAM_LEN },
      state.lengthMilestones,
    );

    for (const finding of findings) {
      if (finding.kind === "stream_length") {
        const milestone = Number.parseInt(finding.pattern.replace(/[^\d]/g, ""), 10);
        if (Number.isFinite(milestone)) state.lengthMilestones.add(milestone);
      }
      const fingerprint = `${finding.kind}:${finding.pattern.slice(0, 48)}:${finding.count}`;
      if (state.emittedFingerprints.has(fingerprint)) continue;
      state.emittedFingerprints.add(fingerprint);
      this.postAlert(agentId, agentIndex, cumulativeText.length, finding);
    }
  }

  private postAlert(
    watchedAgentId: string,
    watchedAgentIndex: number,
    streamLen: number,
    finding: StreamAnomalyFinding,
  ): void {
    const summary: Extract<TranscriptEntrySummary, { kind: "housekeeper_alert" }> = {
      kind: "housekeeper_alert",
      watchedAgentId,
      watchedAgentIndex,
      streamLen,
      anomalyKind: finding.kind,
      repeatCount: finding.count,
      patternSample: finding.pattern,
      detail: finding.detail,
    };

    const text = [
      `[Housekeeper] Stream anomaly on ${watchedAgentId} (agent ${watchedAgentIndex})`,
      `${finding.detail} — ${streamLen.toLocaleString()} chars streamed so far.`,
      `Evidence: "${finding.pattern.slice(0, 160)}${finding.pattern.length > 160 ? "…" : ""}"`,
      `(×${finding.count})`,
    ].join("\n");

    const entry: TranscriptEntry = {
      id: randomUUID(),
      role: "agent",
      agentId: "agent-0",
      agentIndex: 0,
      text,
      ts: Date.now(),
      summary,
    };
    this.emit(entry);
  }
}