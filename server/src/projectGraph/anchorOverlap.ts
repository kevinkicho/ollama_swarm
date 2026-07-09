import type { ProjectGraphAnchors } from "./types.js";

export interface AnchorOverlapResult {
  /** 0–100: share of touched paths that overlap hot/mission anchors. */
  anchorOverlap: number;
  offGraphPaths: string[];
  recoverySuggested: boolean;
}

const RECOVERY_THRESHOLD = 40;

/** Deterministic: how much recent file activity aligns with graph anchors. */
export function computeAnchorOverlap(
  touchedPaths: readonly string[],
  anchors: ProjectGraphAnchors,
): AnchorOverlapResult {
  if (touchedPaths.length === 0) {
    return { anchorOverlap: 100, offGraphPaths: [], recoverySuggested: false };
  }

  const anchorSet = new Set<string>([
    ...anchors.missionFiles,
    ...anchors.hotFiles.map((h) => h.path),
  ]);

  const normalized = touchedPaths.map((p) => p.replace(/\\/g, "/").trim()).filter(Boolean);
  const offGraph: string[] = [];

  let overlapCount = 0;
  for (const p of normalized) {
    const onGraph = anchorSet.has(p);
    if (onGraph) {
      overlapCount++;
    } else {
      offGraph.push(p);
    }
  }

  const anchorOverlap = Math.round((overlapCount / normalized.length) * 100);
  return {
    anchorOverlap,
    offGraphPaths: offGraph.slice(0, 10),
    recoverySuggested: anchorOverlap < RECOVERY_THRESHOLD && offGraph.length > 0,
  };
}