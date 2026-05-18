/**
 * Auto-resume plugin — spawns opencode run "autoresearch" via $ shell
 * when session.idle fires and checkpoint status is in_progress.
 * Uses fire-and-forget to avoid blocking the idle event handler.
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
  console.log("[autoresume] Plugin loaded, watching session.idle");

  return {
    event: async ({ event }) => {
      if (event.type !== "session.idle") return;

      console.log("[autoresume] session.idle fired");

      if (firing) {
        console.log("[autoresume] Still firing from previous cycle, skipping");
        return;
      }

      const status = readStatus(directory);
      console.log("[autoresume] Checkpoint status:", status);

      if (status !== "in_progress") {
        console.log("[autoresume] Status not in_progress, skipping");
        return;
      }

      console.log("[autoresume] Firing autoresearch...");
      firing = true;

      $`opencode run "autoresearch"`.cwd(directory).quiet().then(
        () => {
          console.log("[autoresume] Cycle complete");
          firing = false;
        },
        (err) => {
          console.log("[autoresume] Cycle failed:", err);
          firing = false;
        },
      );
    },
  };
};
