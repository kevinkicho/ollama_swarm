// selfUpgrader.ts — basic self-upgrade support (safe recording mode).
//
// Proposals from Brain insights are recorded. Full auto code patching of the
// swarm source itself remains gated (manual review + git safety recommended).

import fs from "node:fs/promises";
import path from "node:path";

export interface UpgradeResult {
  success: boolean;
  patchesApplied: number;
  error?: string;
  note?: string;
}

export interface SelfUpgrader {
  canApplyPatches(): boolean;
  applyPatch(proposal: { title: string; description: string; targetFiles?: string[] }): Promise<UpgradeResult>;
  createRollbackTag(): string | null;
  rollback(tag: string): boolean;
}

export function createSelfUpgrader(opts: { clonePath?: string; enabled?: boolean } = {}) {
  const enabled = opts.enabled ?? true;
  const upgradesLog = opts.clonePath ? path.join(opts.clonePath, "logs", "upgrades.jsonl") : null;

  return {
    canApplyPatches(): boolean {
      return enabled;
    },
    async applyPatch(proposal: { title: string; description: string; targetFiles?: string[] }): Promise<UpgradeResult> {
      if (!enabled) {
        return { success: false, patchesApplied: 0, error: "Self-upgrade disabled." };
      }
      try {
        const entry = {
          ts: Date.now(),
          title: proposal.title,
          description: proposal.description,
          targetFiles: proposal.targetFiles || [],
          note: "Recorded (apply via git review recommended for safety).",
        };
        if (upgradesLog) {
          await fs.mkdir(path.dirname(upgradesLog), { recursive: true }).catch(() => {});
          await fs.appendFile(upgradesLog, JSON.stringify(entry) + "\n", "utf8");
        }
        console.log(`[self-upgrader] Recorded upgrade proposal: ${proposal.title}`);
        return { success: true, patchesApplied: 0, note: "Proposal logged. Manual patch recommended." };
      } catch (err: any) {
        return { success: false, patchesApplied: 0, error: err.message || String(err) };
      }
    },
    createRollbackTag(): string | null {
      return `upgrade-${Date.now()}`;
    },
    rollback(tag: string): boolean {
      console.log(`[self-upgrader] Rollback stub for ${tag} (no-op; use git).`);
      return true;
    },
  };
}
