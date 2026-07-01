// Self-upgrader — applies patches to the swarm's own code.
//
// The brain generates improvement proposals. When a proposal is ready
// to implement, the self-upgrader applies the patches, commits them,
// and optionally restarts the server.
//
// Safety: patches only apply when ALL runs are stopped.

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import type { ImprovementProposal } from "./brainOverseer.js";
import { readAppliedProposals, recordApplied } from "./proposalStore.js";

export interface UpgradeResult {
  success: boolean;
  patchesApplied: number;
  commitSha?: string;
  error?: string;
}

export interface SelfUpgraderOpts {
  /** Get the current number of active runs. */
  getActiveRunCount: () => number;
  /** Clone path for the swarm codebase. */
  clonePath: string;
  /** Whether to auto-commit patches. */
  autoCommit: boolean;
}

/**
 * Create a self-upgrader that can apply patches to the swarm codebase.
 */
export function createSelfUpgrader(opts: SelfUpgraderOpts) {
  return {
    /**
     * Check if patches can be applied (no runs active).
     */
    canApplyPatches(): boolean {
      return opts.getActiveRunCount() === 0;
    },

    /**
     * Apply a patch from a proposal.
     * Returns the result of the patch application.
     */
    async applyPatch(
      proposal: ImprovementProposal,
      patchContent: { file: string; search: string; replace: string }[],
    ): Promise<UpgradeResult> {
      if (!this.canApplyPatches()) {
        return {
          success: false,
          patchesApplied: 0,
          error: "Cannot apply patches while runs are active",
        };
      }

      // Check if already applied
      const applied = await readAppliedProposals(opts.clonePath);
      if (applied.some((p) => p === proposal.title)) {
        return {
          success: false,
          patchesApplied: 0,
          error: "Proposal already applied",
        };
      }

      let patchesApplied = 0;
      const errors: string[] = [];

      for (const patch of patchContent) {
        const filePath = path.join(opts.clonePath, patch.file);

        if (!existsSync(filePath)) {
          errors.push(`File not found: ${patch.file}`);
          continue;
        }

        try {
          const content = await readFile(filePath, "utf8");

          // Apply search/replace
          if (patch.search && patch.replace) {
            if (!content.includes(patch.search)) {
              errors.push(`Search text not found in ${patch.file}`);
              continue;
            }
            const newContent = content.replace(patch.search, patch.replace);
            await writeFile(filePath, newContent);
            patchesApplied++;
          }
        } catch (err) {
          errors.push(`Failed to patch ${patch.file}: ${err instanceof Error ? err.message : err}`);
        }
      }

      // Record as applied
      if (patchesApplied > 0) {
        await recordApplied(opts.clonePath, proposal.title);

        // Git commit if enabled
        if (opts.autoCommit) {
          try {
            execSync("git add -A", { cwd: opts.clonePath, timeout: 10_000 });
            const commitMsg = `brain: ${proposal.title}`;
            execSync(`git commit -m "${commitMsg}"`, { cwd: opts.clonePath, timeout: 10_000 });
            const sha = execSync("git rev-parse HEAD", { cwd: opts.clonePath, timeout: 5_000 })
              .toString()
              .trim();
            return { success: true, patchesApplied, commitSha: sha };
          } catch (err) {
            errors.push(`Git commit failed: ${err instanceof Error ? err.message : err}`);
          }
        }

        return { success: true, patchesApplied, error: errors.length > 0 ? errors.join("; ") : undefined };
      }

      return {
        success: false,
        patchesApplied: 0,
        error: errors.length > 0 ? errors.join("; ") : "No patches applied",
      };
    },

    /**
     * Create a git tag for rollback before applying patches.
     */
    createRollbackTag(tagName: string): string | null {
      try {
        execSync(`git tag ${tagName}`, { cwd: opts.clonePath, timeout: 5_000 });
        return tagName;
      } catch {
        return null;
      }
    },

    /**
     * Rollback to a specific tag.
     */
    rollback(tagName: string): boolean {
      try {
        execSync(`git reset --hard ${tagName}`, { cwd: opts.clonePath, timeout: 10_000 });
        return true;
      } catch {
        return false;
      }
    },
  };
}
