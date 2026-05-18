/**
 * Auto-resume plugin for autoresearch — CLI-level approach.
 *
 * When the autoresearch skill runs, it writes status to
 * .opencode/session-checkpoint.md. This plugin watches for session.idle,
 * reads the checkpoint, and if status=in_progress, spawns an opencode
 * subprocess to continue the work.
 *
 * Uses `opencode run` (CLI) instead of SDK `session.prompt()` because
 * the SDK call can deadlock when fired from inside the session.idle
 * event handler — the session can't leave idle state while the handler
 * is blocked.
 *
 * To manually stop autoresearch: set Status: **finished** in the checkpoint.
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

export const SessionCheckpointPlugin: Plugin = async ({ client, directory, $ }) => {
  const pending = new Map<string, boolean>();

  return {
    event: async ({ event }) => {
      if (event.type !== "session.idle") return;

      const props = event.properties as Record<string, unknown> | undefined;
      const sessionObj = props?.session as Record<string, unknown> | undefined;
      const sid = (sessionObj?.id as string | undefined) ?? "";

      if (pending.get(sid)) return;
      pending.set(sid, true);

      try {
        const status = readStatus(directory);
        if (status !== "in_progress") return;

        // Continue the current session with "autoresearch" prompt.
        // --continue reuses the last session (this one).
        // --dangerously-skip-permissions so it runs unattended.
        // --dir sets the working directory.
        await $`opencode run --continue --dangerously-skip-permissions --dir ${directory} "autoresearch"`
          .quiet();
      } finally {
        pending.delete(sid);
      }
    },
  };
};
