/**
 * Auto-resume plugin for autoresearch.
 *
 * When the autoresearch skill runs, it writes status to
 * .opencode/session-checkpoint.md. This plugin watches for session.idle,
 * reads the checkpoint, and if status=in_progress, auto-sends "autoresearch"
 * to keep the ratchet rolling. Stops when status transitions to "finished"
 * or when the checkpoint file is absent.
 *
 * To manually stop autoresearch: set Status: **finished** in the checkpoint.
 *
 * Reliability notes:
 * - The pending map prevents double-fire when session.idle events queue up.
 * - Failures are logged but never stop the loop. Only the checkpoint
 *   transitioning to "finished" (set manually by the user) stops it.
 * - No first-idle guard — if checkpoint is in_progress when opencode
 *   starts, autoresearch fires immediately. Set it to finished manually
 *   if you want to prevent this.
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
  const pending = new Map<string, boolean>();

  return {
    event: async ({ event }) => {
      if (event.type !== "session.idle") return;

      const props = event.properties as Record<string, unknown> | undefined;
      const sessionObj = props?.session as Record<string, unknown> | undefined;
      const sid =
        sessionObj?.id as string | undefined
        ?? props?.id as string | undefined
        ?? props?.sessionID as string | undefined;

      if (!sid) {
        await client.app.log({
          body: {
            service: "autoresume",
            level: "warn",
            message: "session.idle with no recognizable session id",
            extra: { props: Object.keys(props ?? {}).join(", ") },
          },
        }).catch(() => {});
        return;
      }

      if (pending.get(sid)) return;

      pending.set(sid, true);

      try {
        const status = readStatus(directory);
        if (status !== "in_progress") return;

        // Brief settle so queued events drain before we fire a new prompt.
        await new Promise((r) => setTimeout(r, 500));

        // Fire-and-forget — do NOT await. Awaiting inside the event
        // handler can deadlock the session (session can't leave idle
        // state until handler returns, but prompt needs the session
        // to process). Let the handler return first, then the session
        // picks up the injected "autoresearch" message naturally.
        client.session.prompt({
          path: { id: sid },
          body: {
            parts: [{ type: "text", text: "autoresearch" }],
          },
        }).catch(async (err) => {
          const msg = err instanceof Error ? err.message : String(err);
          await client.app.log({
            body: {
              service: "autoresume",
              level: "error",
              message: `Auto-resume prompt failed for ${sid.slice(0, 8)}: ${msg}`,
              extra: { sessionId: sid },
            },
          }).catch(() => {});
        });
      } finally {
        pending.delete(sid);
      }
    },
  };
};
