// Stigmergy annotation table + cross-cluster pheromone spread — extracted from StigmergyRunner.

import type { SwarmEvent } from "../types.js";
import type { RunConfig } from "./SwarmRunner.js";
import {
  buildImportGraph,
  relatedFilesViaImports,
  type ImportGraph,
} from "./importGraph.js";
import type {
  AnnotationState,
  ParsedAnnotation,
} from "./stigmergyPromptHelpers.js";

export interface StigmergyPheromoneHost {
  annotations: Map<string, AnnotationState>;
  round: number;
  active: RunConfig | undefined;
  importGraphCache: ImportGraph | null;
  setImportGraphCache: (g: ImportGraph | null) => void;
  emit: (e: SwarmEvent) => void;
  appendSystem: (text: string) => void;
  listRepoFiles: (
    clonePath: string,
    opts: { maxFiles: number },
  ) => Promise<string[]>;
}

export function applyAnnotation(
  host: StigmergyPheromoneHost,
  ann: ParsedAnnotation,
  opts?: { onHighInterest?: (file: string, interest: number) => void },
): void {
  const existing = host.annotations.get(ann.file);
  let next: AnnotationState;
  if (!existing) {
    next = {
      visits: 1,
      avgInterest: ann.interest,
      avgConfidence: ann.confidence,
      latestNote: ann.note,
      lastVisitedRound: host.round,
    };
  } else {
    const n = existing.visits + 1;
    next = {
      visits: n,
      avgInterest: (existing.avgInterest * existing.visits + ann.interest) / n,
      avgConfidence: (existing.avgConfidence * existing.visits + ann.confidence) / n,
      latestNote: ann.note,
      lastVisitedRound: host.round,
    };
  }
  host.annotations.set(ann.file, next);
  host.emit({
    type: "pheromone_updated",
    file: ann.file,
    state: { ...next },
  });
  if (host.active?.crossClusterDiscovery && ann.interest >= 7) {
    opts?.onHighInterest?.(ann.file, ann.interest);
  }
}

export async function spreadCrossClusterPheromones(
  host: StigmergyPheromoneHost,
  seedFile: string,
  seedInterest: number,
): Promise<void> {
  try {
    if (host.importGraphCache === null) {
      const clonePath = host.active?.localPath;
      if (!clonePath) return;
      const allFiles = await host.listRepoFiles(clonePath, { maxFiles: 500 });
      const tsJsFiles = allFiles.filter((f) =>
        /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f),
      );
      if (tsJsFiles.length === 0) {
        host.setImportGraphCache(new Map());
        return;
      }
      host.setImportGraphCache(await buildImportGraph(clonePath, tsJsFiles));
    }
    const graph = host.importGraphCache;
    if (!graph) return;
    const related = relatedFilesViaImports(seedFile, graph, 5);
    if (related.length === 0) return;
    const bumpInterest = Math.max(1, Math.round(seedInterest / 2));
    const bumpConfidence = 2;
    for (const relFile of related) {
      if (host.annotations.has(relFile)) continue;
      applyAnnotation(host, {
        file: relFile,
        interest: bumpInterest,
        confidence: bumpConfidence,
        note: `[cross-cluster bump from ${seedFile}] related via import graph`,
      });
    }
    host.appendSystem(
      `[T197 cross-cluster] seed ${seedFile} (interest=${seedInterest}) spread soft bumps to ${related.length} related file(s) via import graph.`,
    );
  } catch {
    // best-effort
  }
}
