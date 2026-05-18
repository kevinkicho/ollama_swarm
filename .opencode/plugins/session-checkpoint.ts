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
 * - Failures are logged via client.app.log (not console) for server visibility.
 * - On three consecutive failures, the plugin gives up to prevent flood loops.
 */

import type { Plugin } from "@opencode-ai/plugin";
import fs from "node:fs";
import path from "node:path";

const CHECKPOINT_FILE = ".opencode/session-checkpoint.md";
const MAX_CONSECUTIVE_FAILURES = 3;

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
  const consecutiveFailures = new Map<string, number>();

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

      // Bail if this session has failed too many times consecutively.
      const failures = consecutiveFailures.get(sid) ?? 0;
      if (failures >= MAX_CONSECUTIVE_FAILURES) return;

      if (pending.get(sid)) return;
      pending.set(sid, true);

      try {
        const status = readStatus(directory);
        if (status !== "in_progress") return;

        // Brief settle so queued events drain before we fire a new prompt.
        await new Promise((r) => setTimeout(r, 500));

        await client.session.prompt({
          path: { id: sid },
          body: {
            parts: [{ type: "text", text: "autoresearch" }],
          },
        });

        // Success resets the failure counter.
        consecutiveFailures.delete(sid);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const next = (consecutiveFailures.get(sid) ?? 0) + 1;
        consecutiveFailures.set(sid, next);

        await client.app.log({
          body: {
            service: "autoresume",
            level: "error",
            message: `Auto-resume attempt ${next}/${MAX_CONSECUTIVE_FAILURES} failed for ${sid.slice(0, 8)}: ${msg}`,
            extra: { sessionId: sid, attempt: next },
          },
        }).catch(() => {});
      } finally {
        pending.delete(sid);
      }
    },
  };
};
