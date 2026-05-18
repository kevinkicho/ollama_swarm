/**
 * Auto-resume plugin — uses opencode run CLI (like watchdog) via $ shell.
 * This spawns an external process, avoiding the in-process session deadlock.
 * Only fires when checkpoint status is in_progress.
 */

import type { Plugin } from "@opencode-ai/plugin";
import fs from "node:fs";
import path from "node:path";

const CHECKPOINT_FILE = ".opencode/session-checkpoint.md";

function readStatus(workdir: string): string | null {
  try {
    const p = path.resolve(workdir, CHECKPOINT_FILE);
    if (!fs.existsSync(p)) return null;
    const content = fs.readFileSync(p, "utf8");
    const m = content.match(/^> Status:\s*\*{2}(\w+)\*{2}/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export const SessionCheckpointPlugin: Plugin = async ({ directory, $ }) => {
  let firing = false;

  return {
    event: async ({ event }) => {
      if (event.type !== "session.idle") return;
      if (firing) return;

      const status = readStatus(directory);
      if (status !== "in_progress") return;

      firing = true;
      try {
        await $`opencode run "autoresearch"`.cwd(directory).quiet();
      } catch {
        // subprocess may exit non-zero — ignore and retry next idle
      } finally {
        firing = false;
      }
    },
  };
};
