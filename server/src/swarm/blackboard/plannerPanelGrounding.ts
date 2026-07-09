import {
  applyPanelConvention,
  type PanelConventionOutcome,
} from "@ollama-swarm/shared/panelConvention";
import type { PlannerTodoInput } from "./prompts/planner.js";

export interface PanelGroundingNote {
  description: string;
  note: string;
}

export function applyPanelConventionToTodos(
  todos: PlannerTodoInput[],
  repoFiles: readonly string[],
): { todos: PlannerTodoInput[]; notes: PanelGroundingNote[]; skipped: string[] } {
  const notes: PanelGroundingNote[] = [];
  const skipped: string[] = [];
  const kept: PlannerTodoInput[] = [];

  for (const t of todos) {
    const outcome: PanelConventionOutcome = applyPanelConvention(
      { description: t.description, expectedFiles: t.expectedFiles },
      repoFiles,
    );
    switch (outcome.action) {
      case "unchanged":
        kept.push(t);
        break;
      case "repath":
      case "register-existing":
        kept.push({
          ...t,
          description: outcome.description,
          expectedFiles: outcome.expectedFiles,
        });
        notes.push({ description: t.description, note: outcome.note });
        break;
      case "skip":
        skipped.push(`${t.description.slice(0, 60)}: ${outcome.reason}`);
        break;
    }
  }

  return { todos: kept, notes, skipped };
}