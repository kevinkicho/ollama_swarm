import { useSwarm } from "../state/store";
import { CopyChip } from "./CopyChip";

// Truncate-from-LEFT (per Kevin's Unit 52c spec preference): the
// distinguishing tail of a path is the run-name + repo-name, not the
// shared `/mnt/c/Users/...` prefix.
export function truncateLeft(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return "…" + s.slice(s.length - maxLen + 1);
}

// Unit 52c (Unit 56-consolidated): single run-identity topbar showing
// run uuid + run name + preset + planner/worker models + agent count
// + clone path. The path is click-to-open via POST /api/swarm/open
// (server validates the request matches the active run's clonePath,
// then shells out to Explorer/Finder/xdg-open). Per-agent session ids
// + models live in the AgentPanel cards (Unit 56) — this strip only
// carries run-level metadata.
export function IdentityStrip() {
  const cfg = useSwarm((s) => s.runConfig);
  const runId = useSwarm((s) => s.runId);
  // Task #85: history dropdown moved to the App-level header so it's
  // also reachable from the SetupForm. IdentityStrip no longer
  // renders it — keep `history = null` so existing layout doesn't
  // shift when this strip appears.
  const history = null;
  if (!cfg && !runId) return null;
  const runName = cfg ? deriveRunName(cfg.clonePath) : "(unnamed run)";
  const onOpen = async () => {
    if (!cfg) return;
    // Task #45: retry on TypeError: Failed to fetch (tsx-watch restart
    // window makes the backend briefly unreachable — 2-5s typical).
    // Retry 3 times with 500ms backoff before giving up.
    const attemptOnce = async (): Promise<{ ok: boolean; err?: unknown }> => {
      try {
        const res = await fetch("/api/swarm/open", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: cfg.clonePath }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          return { ok: false, err: body.error ?? `HTTP ${res.status}` };
        }
        return { ok: true };
      } catch (err) {
        return { ok: false, err };
      }
    };
    for (let i = 0; i < 3; i++) {
      const result = await attemptOnce();
      if (result.ok) return;
      // Only retry on TypeError (network-level). HTTP errors are permanent.
      if (!(result.err instanceof TypeError)) {
        console.warn("open clone path failed:", result.err);
        return;
      }
      if (i < 2) {
        await new Promise((r) => setTimeout(r, 500));
      } else {
        console.warn("open clone path failed after 3 retries:", result.err);
      }
    }
  };
  const sameModel = cfg && cfg.plannerModel === cfg.workerModel;
  return (
    <div className="bg-ink-900/60 border-b border-ink-700 px-4 py-1.5 flex items-center gap-2.5 text-xs font-mono text-ink-300 flex-wrap">
      {runId ? (
        <CopyChip label="run" value={runId} short={runId.slice(0, 8)} />
      ) : null}
      {/* Task #35: preset badge immediately after the runId chip — they're
          the two most-scanned anchors in the strip, and pairing them lets
          users instantly see "this is the {preset} run with id {short}".
          Uppercase pill style is intentional: visually distinct from the
          monospace runId and the model chips. */}
      {cfg ? (
        <PresetBadge preset={cfg.preset} />
      ) : null}
      {cfg ? (
        <>
          <span className="text-ink-600">·</span>
          <span className="text-ink-100 font-semibold">{runName}</span>
          <span className="text-ink-600">·</span>
          {sameModel ? (
            <span title="Planner + worker model"><span className="text-ink-500">model</span> {cfg.plannerModel}</span>
          ) : (
            <>
              <span title="Planner model"><span className="text-ink-500">planner</span> {cfg.plannerModel}</span>
              <span className="text-ink-600">·</span>
              <span title="Worker model"><span className="text-ink-500">worker</span> {cfg.workerModel}</span>
            </>
          )}
          {/* Topbar dedup: dropped the "agents N" segment. cfg.agentCount
              excludes the dedicated auditor (Unit 58) so the count was
              wrong for 4-agent runs, and the live agent count is already
              in the left sidebar header. Dedup over fix-the-count. */}
          <button
            onClick={onOpen}
            title={`Open in OS file manager — ${cfg.clonePath}`}
            className="text-ink-400 hover:text-ink-100 hover:underline truncate max-w-md inline-block align-bottom ml-auto"
          >
            {truncateLeft(cfg.clonePath, 60)}
          </button>
        </>
      ) : null}
      {history}
    </div>
  );
}

// Task #35: pill-style badge for the active preset, rendered right
// after the runId chip in IdentityStrip. Per-preset color so a quick
// glance distinguishes a write-capable blackboard run from a read-
// only discussion preset. Uppercase + tracking for visual weight
// against the surrounding monospace chips.
function PresetBadge({ preset }: { preset: string }) {
  // Color buckets: write-capable = emerald (signals "this run will
  // change files"); read-only discussion presets = ink-blue tones.
  // Debate-judge (PRO/CON dynamic) gets amber. Stigmergy (self-
  // organizing) gets teal. Council/role-diff/orchestrator-worker/
  // map-reduce/round-robin share a neutral indigo.
  const palette = ((): { bg: string; fg: string; border: string } => {
    switch (preset) {
      case "blackboard":
        return { bg: "bg-emerald-900/40", fg: "text-emerald-200", border: "border-emerald-700" };
      case "debate-judge":
        return { bg: "bg-amber-900/30", fg: "text-amber-200", border: "border-amber-700" };
      case "stigmergy":
        return { bg: "bg-teal-900/30", fg: "text-teal-200", border: "border-teal-700" };
      default:
        return { bg: "bg-indigo-900/30", fg: "text-indigo-200", border: "border-indigo-700" };
    }
  })();
  return (
    <span
      title={`Preset: ${preset}`}
      className={`inline-flex items-center px-2 py-0.5 rounded-full border text-[10px] uppercase tracking-wider font-semibold ${palette.bg} ${palette.fg} ${palette.border}`}
    >
      {preset}
    </span>
  );
}

// Run name = basename of the clone path. Falls back to a placeholder
// if the path lacks a meaningful tail (defensive).
function deriveRunName(clonePath: string): string {
  // Cross-platform basename: split on either separator and grab the
  // non-empty tail. Path module on web is overkill for this.
  const parts = clonePath.split(/[\\/]/).filter((p) => p.length > 0);
  return parts[parts.length - 1] ?? "(unnamed run)";
}
