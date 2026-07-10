// Auto-derive / parallel-pick debate proposition at run start — extracted from DebateJudgeRunner.

import type { Agent } from "../services/AgentManager.js";
import type { AgentManager } from "../services/AgentManager.js";
import { deriveProposition, type DerivedProposition } from "./propositionDerive.js";
import { rankParallelPropositions } from "./debatePromptHelpers.js";

export interface ResolveDebatePropositionOpts {
  /** Current proposition (may be empty). */
  proposition: string | undefined;
  parallelPropositions: boolean | undefined;
  directiveTrimmed: string;
  judge: Agent;
  manager: AgentManager;
  appendSystem: (text: string) => void;
}

export interface ResolveDebatePropositionResult {
  proposition: string | undefined;
  derivedMeta: DerivedProposition | null;
}

/**
 * When no proposition was supplied but a userDirective exists, derive one
 * (optionally K parallel candidates + judge rank). Best-effort: failures leave
 * proposition unchanged so the debate still proceeds with DEFAULT_PROPOSITION.
 */
export async function resolveDebatePropositionAtStart(
  opts: ResolveDebatePropositionOpts,
): Promise<ResolveDebatePropositionResult> {
  const {
    parallelPropositions,
    directiveTrimmed,
    judge,
    manager,
    appendSystem,
  } = opts;
  let proposition = opts.proposition;
  let derivedMeta: DerivedProposition | null = null;

  if (
    (proposition === undefined || proposition.length === 0) &&
    directiveTrimmed.length > 0
  ) {
    if (parallelPropositions) {
      // T199: K candidates IN PARALLEL + dedicated judge-rank step.
      appendSystem(
        `[T199 parallel propositions] Generating 3 candidates IN PARALLEL; judge will rank + pick the most informative.`,
      );
      const candidates: DerivedProposition[] = (
        await Promise.all([
          deriveProposition({ agent: judge, manager, directive: directiveTrimmed }),
          deriveProposition({ agent: judge, manager, directive: directiveTrimmed }),
          deriveProposition({ agent: judge, manager, directive: directiveTrimmed }),
        ])
      ).filter((c): c is DerivedProposition => c !== null);
      if (candidates.length > 0) {
        const seen = new Set<string>();
        const unique = candidates.filter((c) => {
          const k = c.proposition.trim().toLowerCase();
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
        let winner: DerivedProposition;
        if (unique.length === 1) {
          winner = unique[0]!;
        } else {
          const pickedIdx = await rankParallelPropositions(
            judge,
            manager,
            directiveTrimmed,
            unique.map((c) => c.proposition),
          );
          winner =
            pickedIdx !== null && pickedIdx >= 0 && pickedIdx < unique.length
              ? unique[pickedIdx]!
              : unique.find((c) => c.derived) ?? unique[0]!;
        }
        derivedMeta = winner;
        proposition = winner.proposition;
        appendSystem(
          `[T199] ${candidates.length} candidates generated, ${unique.length} unique; picked: "${winner.proposition}". Other unique candidates: ${unique
            .filter((c) => c !== winner)
            .map((c) => `"${c.proposition.slice(0, 60)}…"`)
            .join("; ") || "(none)"}.`,
        );
      }
    } else {
      appendSystem(
        `Auto-deriving debate proposition from directive (improvement #1)…`,
      );
      const derived = await deriveProposition({
        agent: judge,
        manager,
        directive: directiveTrimmed,
      });
      if (derived) {
        derivedMeta = derived;
        proposition = derived.proposition;
        const sourceLabel = derived.derived
          ? "auto-derived from directive"
          : "fallback (auto-derive failed)";
        appendSystem(
          `Proposition (${sourceLabel}): "${derived.proposition}"${derived.rationale ? ` — ${derived.rationale}` : ""}`,
        );
      }
    }
  }

  return { proposition, derivedMeta };
}
