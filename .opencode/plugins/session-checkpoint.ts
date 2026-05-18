/**
 * Auto-resume plugin for autoresearch.
 *
 * Watches session.idle events. When the checkpoint status is in_progress,
 * sends "autoresearch" as a user message via session.prompt(), which
 * triggers the AI to load the autoresearch skill and continue working.
 *
 * To manually stop: set Status: **finished** in .opencode/session-checkpoint.md
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

export const SessionCheckpointPlugin: Plugin = async ({ client, directory }) => {
  let firing = false;

  return {
    event: async ({ event }) => {
      if (event.type !== "session.idle") return;

      // Prevent re-entrant fires.
      if (firing) return;

      const props = event.properties as Record<string, unknown> | undefined;
      const sessionObj = props?.session as Record<string, unknown> | undefined;
      const sid = (sessionObj?.id as string | undefined) ?? "";

      const status = readStatus(directory);
      if (status !== "in_progress") return;

      firing = true;
      try {
        await client.session.prompt({
          path: { id: sid },
          body: {
            noReply: false,
            parts: [{ type: "text", text: "autoresearch" }],
          },
        });
      } finally {
        firing = false;
      }
    },
  };
};
