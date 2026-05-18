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
 * - On the first session.idle, any leftover in_progress is reset to finished
 *   (prevents automatic carryover to a fresh session). Only when the
 *   autoresearch skill explicitly writes in_progress this session will the
 *   plugin auto-resume on subsequent idle events.
 * - Failures are logged but never cause the plugin to give up. Only the
 *   checkpoint transitioning to "finished" (set manually by the user) stops
 *   the loop.
 */

import type { Plugin } from "@opencode-ai/plugin";
import fs from "node:fs";
import path from "node:path";

const CHECKPOINT_FILE = ".opencode/session-checkpoint.md";
const MAX_CONSECUTIVE_FAILURES = Number.POSITIVE_INFINITY;

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
  const firstIdle = new Map<string, boolean>();

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

      // On the very first idle of a session, reset any leftover in_progress
      // from a prior session to finished. This prevents the plugin from
      // auto-triggering autoresearch on every fresh opencode start. The
      // autoresearch skill must explicitly write in_progress this session.
      if (!firstIdle.get(sid)) {
        firstIdle.set(sid, true);
        const status = readStatus(directory);
        if (status === "in_progress") {
          const p = path.resolve(directory, CHECKPOINT_FILE);
          try {
            const content = fs.readFileSync(p, "utf8");
            const updated = content.replace(
              /^> Status:\s*\*{2}\w+\*{2}/m,
              "> Status: **finished**",
            );
            fs.writeFileSync(p, updated, "utf8");
            await client.app.log({
              body: {
                service: "autoresume",
                level: "info",
                message: "First idle: reset leftover in_progress to finished",
                extra: { sessionId: sid },
              },
            }).catch(() => {});
          } catch { /* checkpoint write failed — ignore */ }
        }
        return;
      }

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
