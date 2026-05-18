/**
 * Auto-resume plugin for autoresearch.
 * 
 * Uses setTimeout to defer prompt() so the idle event handler returns
 * first, allowing the session to fully transition to idle before a
 * new "autoresearch" message is injected. Stays active as long as
 * checkpoint status is in_progress.
 */

import type { Plugin } from "@opencode-ai/plugin";
import fs from "node:fs";
import path from "node:path";

const CHECKPOINT_FILE = ".opencode/session-checkpoint.md";
const RESUME_DELAY_MS = 2000;

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
  let scheduled = false;

  return {
    event: async ({ event }) => {
      if (event.type !== "session.idle") return;
      if (scheduled) return;

      const status = readStatus(directory);
      if (status !== "in_progress") return;

      const props = event.properties as Record<string, unknown> | undefined;
      const sessionObj = props?.session as Record<string, unknown> | undefined;
      const sid = (sessionObj?.id as string | undefined) ?? "";
      if (!sid) return;

      scheduled = true;

      // Defer with setTimeout so the event handler returns first,
      // session transitions to idle, then the prompt fires fresh.
      setTimeout(async () => {
        try {
          await client.session.prompt({
            path: { id: sid },
            body: {
              parts: [{ type: "text", text: "autoresearch" }],
            },
          });
        } finally {
          scheduled = false;
        }
      }, RESUME_DELAY_MS);
    },
  };
};
