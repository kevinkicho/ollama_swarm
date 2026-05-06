import type { AnnotationState } from "./stigmergyPromptHelpers.js";
import { rankingScore } from "./stigmergyPromptHelpers.js";

export interface FileHeat {
  path: string;
  score: number;
  visits: number;
  avgInterest: number;
  avgConfidence: number;
}

export class PheromoneHeatmap {
  private annotations = new Map<string, AnnotationState>();
  private currentRound: number = 0;

  updateFromAnnotations(annotations: ReadonlyMap<string, AnnotationState>, round: number): void {
    this.currentRound = round;
    for (const [key, val] of annotations) {
      this.annotations.set(key, val);
    }
  }

  topFiles(n: number): FileHeat[] {
    const entries = Array.from(this.annotations.entries());
    const scored = entries.map(([path, state]) => {
      const score = rankingScore(state, this.currentRound);
      return { path, score, visits: state.visits, avgInterest: state.avgInterest, avgConfidence: state.avgConfidence };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, n);
  }

  toSnapshot(): Record<string, AnnotationState> {
    return Object.fromEntries(this.annotations.entries());
  }

  fromSnapshot(data: Record<string, AnnotationState>): void {
    this.annotations.clear();
    for (const [key, val] of Object.entries(data)) {
      this.annotations.set(key, val);
    }
  }

  clear(): void {
    this.annotations.clear();
    this.currentRound = 0;
  }

  get size(): number {
    return this.annotations.size;
  }
}

export const pheromoneHeatmap = new PheromoneHeatmap();