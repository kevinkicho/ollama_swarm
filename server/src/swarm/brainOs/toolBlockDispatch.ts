/**
 * Fire Brain OS on repeated tool failures (tool_block interrupt).
 * Called from SwarmControlCenter after coach threshold; non-blocking.
 */

import type { Agent } from "../../services/AgentManager.js";
import {
  createRunBrainOs,
  dispatchBrainOsConflict,
  resolveBrainOsConfig,
} from "./adapter.js";

export interface ToolBlockDispatchOpts {
  runId?: string;
  clonePath?: string;
  autoApprove?: boolean;
  brainOs?: boolean | { enabled?: boolean; helperModel?: string };
  helperModel?: string;
  agentId: string;
  tool: string;
  error: string;
  count: number;
  appendSystem?: (msg: string) => void;
  coachAgent?: Agent;
}

const fired = new Set<string>();

/** Reset between runs (call from lifecycle start). */
export function resetToolBlockDispatchFires(): void {
  fired.clear();
}

/**
 * Dispatch tool_block at most once per (runId, agent, tool, error-prefix).
 * Fire-and-forget safe: never throws to callers.
 */
export async function maybeDispatchToolBlock(opts: ToolBlockDispatchOpts): Promise<void> {
  try {
    const bcfg = resolveBrainOsConfig({
      autoApprove: opts.autoApprove,
      brainOs: opts.brainOs as boolean | undefined,
    });
    if (!bcfg.enabled) return;
    if (!opts.runId || !opts.clonePath) return;

    const fp = `${opts.runId}|${opts.agentId}|${opts.tool}|${opts.error.slice(0, 60)}`;
    if (fired.has(fp)) return;
    fired.add(fp);
    // Cap memory
    if (fired.size > 200) {
      const first = fired.values().next().value;
      if (first) fired.delete(first);
    }

    opts.appendSystem?.(
      `[brain-os] tool_block: ${opts.tool} failed ${opts.count}× for ${opts.agentId} — recruiting helper`,
    );

    const bos = createRunBrainOs(
      {
        autoApprove: opts.autoApprove,
        brainOs: bcfg,
        model: opts.helperModel,
        auditorModel: opts.helperModel,
      },
      {
        appendSystem: (t) => opts.appendSystem?.(t),
      },
    );

    const r = await dispatchBrainOsConflict(
      bos,
      {
        runId: opts.runId,
        kind: "tool_block",
        clonePath: opts.clonePath,
        privileges: opts.autoApprove ? "runner" : "repairer",
        lastErrors: [
          `tool=${opts.tool}`,
          `count=${opts.count}`,
          opts.error.slice(0, 500),
        ],
        autoApprove: opts.autoApprove,
        helperModel: opts.helperModel,
        phase: "tool_block",
      },
      {
        appendSystem: (t) => opts.appendSystem?.(t),
      },
    );

    opts.appendSystem?.(
      `[brain-os] tool_block result: ${r.status} — ${r.summary.slice(0, 200)}`,
    );
  } catch (err) {
    opts.appendSystem?.(
      `[brain-os] tool_block dispatch error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
