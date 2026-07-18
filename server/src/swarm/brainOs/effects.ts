/**
 * Deterministic effect applicator — run layer is the single writer for board/git.
 */

import type { BrainEffect, HelperPrivilege } from "@ollama-swarm/shared/brainOs";

export interface BrainEffectApplicatorDeps {
  completeTodo?: (todoId: string, reason: string) => void;
  skipTodo?: (todoId: string, reason: string) => void;
  reopenTodo?: (todoId: string, reason?: string) => void;
  postTodos?: (
    todos: Array<{ description: string; expectedFiles: string[] }>,
  ) => void;
  proposeHunks?: (todoId: string, hunks: unknown[], files: string[]) => void;
  requestApply?: (todoId?: string) => Promise<void> | void;
  appendSystem: (text: string) => void;
  recommendDrain?: () => void;
  recommendStop?: (reason: string) => void;
  privilege: HelperPrivilege;
  onEffect?: (ok: boolean) => void;
}

const PRIV_RANK: Record<HelperPrivilege, number> = {
  observer: 0,
  repairer: 1,
  runner: 2,
  board_officer: 3,
  arbiter: 4,
};

function requires(priv: HelperPrivilege, min: HelperPrivilege): boolean {
  return PRIV_RANK[priv] >= PRIV_RANK[min];
}

export function effectAllowed(
  effect: BrainEffect,
  privilege: HelperPrivilege,
): boolean {
  switch (effect.type) {
    case "none":
    case "append_system":
      return true;
    case "propose_hunks":
    case "request_apply":
      return requires(privilege, "repairer");
    case "board_complete":
    case "board_skip":
    case "board_reopen":
    case "board_post_todos":
      return requires(privilege, "board_officer");
    case "recommend_drain":
    case "recommend_stop":
      return requires(privilege, "arbiter");
    default:
      return false;
  }
}

export async function applyBrainEffects(
  effects: readonly BrainEffect[],
  deps: BrainEffectApplicatorDeps,
): Promise<{ applied: number; rejected: number }> {
  let applied = 0;
  let rejected = 0;
  for (const effect of effects) {
    if (!effectAllowed(effect, deps.privilege)) {
      deps.appendSystem(
        `[brain-os] rejected effect ${effect.type} (privilege=${deps.privilege})`,
      );
      rejected += 1;
      deps.onEffect?.(false);
      continue;
    }
    try {
      switch (effect.type) {
        case "none":
          break;
        case "append_system":
          deps.appendSystem(effect.text);
          break;
        case "board_complete":
          deps.completeTodo?.(effect.todoId, effect.reason);
          break;
        case "board_skip":
          deps.skipTodo?.(effect.todoId, effect.reason);
          break;
        case "board_reopen":
          deps.reopenTodo?.(effect.todoId, effect.reason);
          break;
        case "board_post_todos":
          deps.postTodos?.(effect.todos);
          break;
        case "propose_hunks":
          deps.proposeHunks?.(effect.todoId, effect.hunks, effect.files);
          break;
        case "request_apply":
          await deps.requestApply?.(effect.todoId);
          break;
        case "recommend_drain":
          deps.recommendDrain?.();
          break;
        case "recommend_stop":
          deps.recommendStop?.(effect.reason);
          break;
        default:
          rejected += 1;
          deps.onEffect?.(false);
          continue;
      }
      applied += 1;
      deps.onEffect?.(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      deps.appendSystem(`[brain-os] effect ${effect.type} failed: ${msg.slice(0, 200)}`);
      rejected += 1;
      deps.onEffect?.(false);
    }
  }
  return { applied, rejected };
}
