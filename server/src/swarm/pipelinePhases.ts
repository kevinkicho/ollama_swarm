import type { PresetId } from "./SwarmRunner.js";

export interface PipelinePhase {
  preset: PresetId;
  rounds?: number;
  agentCount?: number;
  model?: string;
}

export interface PipelineConfig {
  phases: PipelinePhase[];
  /** How to pipe the previous phase's output into the next:
   *  "transcript" — inject last N transcript entries as seed context
   *  "deliverable" — inject deliverable.md content as directive
   *  "both" — transcript + deliverable
   */
  pipeMode?: "transcript" | "deliverable" | "both";
  /** Max transcript entries to pipe forward (default 20) */
  pipeMaxEntries?: number;
}

export const DEFAULT_PIPELINE: PipelineConfig = {
  phases: [
    { preset: "stigmergy", rounds: 2 },
    { preset: "orchestrator-worker", rounds: 4 },
    { preset: "debate-judge", rounds: 1 },
  ],
  pipeMode: "both",
  pipeMaxEntries: 20,
};

/** Council exploration → map-reduce synthesis → blackboard implementation. Pair with webTools. */
export const RESEARCH_PIPELINE: PipelineConfig = {
  phases: [
    { preset: "council", rounds: 2, agentCount: 5 },
    { preset: "map-reduce", rounds: 2 },
    { preset: "blackboard", rounds: 1 },
  ],
  pipeMode: "both",
  pipeMaxEntries: 30,
};

export function buildPipedDirective(
  baseDirective: string | undefined,
  previousTranscript: readonly { text: string; role: string; agentIndex?: number }[],
  previousDeliverable: string | undefined,
  pipeMode: "transcript" | "deliverable" | "both",
  maxEntries: number,
): string {
  const parts: string[] = [];
  if (baseDirective) {
    parts.push(baseDirective);
    parts.push("");
  }
  if ((pipeMode === "transcript" || pipeMode === "both") && previousTranscript.length > 0) {
    parts.push("## Prior Phase Output (transcript)");
    const entries = previousTranscript.slice(-maxEntries);
    for (const e of entries) {
      const label = e.agentIndex !== undefined ? `Agent ${e.agentIndex}` : e.role;
      parts.push(`[${label}] ${e.text.slice(0, 500)}`);
    }
    parts.push("");
  }
  if ((pipeMode === "deliverable" || pipeMode === "both") && previousDeliverable) {
    parts.push("## Prior Phase Output (deliverable)");
    parts.push(previousDeliverable.slice(0, 4000));
    parts.push("");
  }
  return parts.join("\n");
}