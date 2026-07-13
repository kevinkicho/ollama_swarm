import { useEffect, useState } from "react";
import { Routes, Route, useParams, useNavigate, useLocation, useSearchParams } from "react-router-dom";
import { useSwarm } from "./state/store";
import { useSwarmSocket } from "./hooks/useSwarmSocket";
import { SetupForm } from "./components/SetupForm";
import { SwarmView } from "./components/SwarmView";
import { ErrorBanner } from "./components/ErrorBanner";
import { BubbleGallery } from "./components/BubbleGallery";
import { EventLogMirrorPanel } from "./components/EventLogMirrorPanel";
import { TimeTravelReplayPanel } from "./components/TimeTravelReplayPanel";
import { RunCompareReplayPanel } from "./components/RunCompareReplayPanel";
import { ActiveRunsPanel } from "./components/ActiveRunsPanel";
import { AuditorGateBanner } from "./components/AuditorGateBanner";
import { SwarmStoreProvider } from "./state/SwarmStoreProvider";
import type { RunSummary } from "./types";
import { PlanningTab } from "./components/PlanningTab";
import { notificationService } from "./services/notificationService";
import { SystemWrapper } from "./components/SystemWrapper";
import { ProjectGrowthPage } from "./features/projectGrowth/ProjectGrowthPage";
import { apiFetch } from "./lib/apiFetch";
import {
  consumeDeferredAppliedNotice,
  type DeferredReconfigAppliedNotice,
} from "./lib/deferredReconfig";

// Task #65 (2026-04-24): URL-based review mode. When the user opens a
// past run from the history modal we set ?review=<runId>&path=<encoded>.
// In that mode the app skips the live WebSocket and instead hydrates
// the store from the saved summary (which now persists transcript +
// agent stats), so existing components — IdentityStrip, AgentPanel,
// Transcript, MetricsPanel — render the past run as if it were live.
function parseReviewParams(): { runId: string; clonePath: string } | null {
  if (typeof window === "undefined") return null;
  const sp = new URLSearchParams(window.location.search);
  const runId = sp.get("review");
  const clonePath = sp.get("path");
  if (!runId || !clonePath) return null;
  return { runId, clonePath };
}

// Validation tour fixture (2026-04-27): ?gallery=1 short-circuits the
// app and renders BubbleGallery instead. Lets us audit every bubble in
// isolation without waiting for runs to surface each summary.kind.
function isGalleryMode(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).has("gallery");
}

// E2 next slice (#333): ?eventLogMirror=1 routes to a side-by-side
// debug view comparing WebSocket-store state to event-log-stream
// state. Used to validate the data path before the full E2 cutover.
function isEventLogMirrorMode(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).has("eventLogMirror");
}

// #90 (2026-05-01): ?replay=<runId> routes to the time-travel replay
// panel — scrub backwards/forwards through any past run's event-log
// records via /api/v2/event-log/runs/:runId. Pure debug tool.
function isReplayMode(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).has("replay");
}

// #99 (2026-05-01): ?compare=<runIdA>,<runIdB> routes to the two-run
// side-by-side comparison panel. Loads BOTH runs via independent
// useReplayState hooks; supports independent + lock-step scrubbers.
function isCompareMode(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).has("compare");
}

export default function App() {
  // Short-circuits: rendered as siblings (not nested inside AppMain)
  // so the conditional doesn't violate rules-of-hooks.
  if (isGalleryMode()) return <BubbleGallery />;
  if (isEventLogMirrorMode()) return <EventLogMirrorPanel />;
  if (isCompareMode()) return <RunCompareReplayPanel />;
  if (isReplayMode()) return <TimeTravelReplayPanel />;
  // T-Item-MultiTenant Phase 9 (2026-05-04): route-based per-run URLs.
  // /runs/:runId is a deep-link to a specific run — currently both
  // routes render the same AppMain (the singleton store still tracks
  // "the active run"). Future deep refactor: per-run zustand factory
  // so /runs/:runId can show a different run than what's active.
  // For now the route URL is meaningful as a shareable link; the
  // RunRouteHook below logs the runId so the UI can later use it for
  // scoped subscriptions.
  return (
    <Routes>
      <Route path="/" element={<HomeRoute />} />
      <Route path="/runs/:runId" element={<RunRouteWrapper />} />
      <Route path="/planning" element={<PlanningTab />} />
      <Route path="/growth" element={<GrowthRoute />} />
    </Routes>
  );
}

/**
 * HomeRoute for legacy "/".
 * After more aggressive guard removal: no resets at all.
 * Root simply renders the setup form + ActiveRunsPanel.
 */
function HomeRoute() {
  return <AppMain />;
}

function GrowthRoute() {
  const [searchParams] = useSearchParams();
  const pathParam = searchParams.get("path") ?? undefined;
  const parentPath = pathParam
    ? pathParam.replace(/[/\\][^/\\]*$/, "")
    : undefined;
  return (
    <SystemWrapper parentPath={parentPath}>
      <ProjectGrowthPage parentPath={pathParam} />
    </SystemWrapper>
  );
}

// T-Item-MultiTenant Phase 9 (2026-05-04): per-run route wrapper.
// T-Item-PerRunStore (2026-05-04): now wraps the subtree in
// SwarmStoreProvider so AppMain (and every component below it)
// reads from a per-run scoped zustand store. The Provider opens
// its OWN per-runId WS subscription + REST hydration; events
// dispatch into the per-run store, NOT the singleton.
//
// The /runs/:runId route is now genuinely per-run: switching
// runIds tears down + recreates the store; the legacy "/" route
// keeps reading from the singleton store unchanged.
function RunRouteWrapper() {
  const { runId } = useParams<{ runId: string }>();
  if (!runId) {
    // Defensive: react-router's typing technically allows undefined.
    return <AppMain />;
  }
  return (
    <SwarmStoreProvider runId={runId}>
      <AppMain />
    </SwarmStoreProvider>
  );
}

function AppMain() {
  const review = parseReviewParams();
  const location = useLocation();
  const pathname = location.pathname;
  const isOnRoot = pathname === "/";
  const { runId: routeRunId } = useParams<{ runId?: string }>();

  // No reliance on removed composite phase state or helper.

  useSwarmSocket(review === null);
  useReviewHydration(review);
  const phase = useSwarm((s) => s.phase);
  const error = useSwarm((s) => s.error);
  const clonePath = useSwarm((s) => s.runConfig?.clonePath);
  const storeRunId = useSwarm((s) => s.runId);
  const hasSummary = useSwarm((s) => !!s.summary);
  const txLen = useSwarm((s) => s.transcript.length);
  // Derive parentPath from clonePath (the clone dir's parent) so history
  // endpoints scan broadly for sibling runs (including under logs/ subdirs
  // for per-run summaries). This makes the runs dropdown show more relevant
  // history when viewing a specific run.
  // Scan the clone/workspace directory itself — summaries live in <clone>/logs/.
  const parentPath = review?.clonePath || clonePath || undefined;

  // Subscribe to run completion/failure events for notifications
  useEffect(() => {
    const unsubComplete = notificationService.on('run:completed', (runId: string) => {
      // handle notification
    });
    const unsubFailed = notificationService.on('run:failed', (runId: string) => {
      // handle notification
    });
    return () => {
      unsubComplete();
      unsubFailed();
    };
  }, []);

  // One-shot: Brain RECONFIG deferred from a finished run was folded into Start.
  const [deferredApplied, setDeferredApplied] = useState<DeferredReconfigAppliedNotice | null>(null);
  useEffect(() => {
    const notice = consumeDeferredAppliedNotice();
    if (notice) setDeferredApplied(notice);
  }, [routeRunId, storeRunId]);

  // Task #163: when in review mode, poll /api/swarm/status to detect
  // whether the run being reviewed is ALSO the currently-live run. If
  // yes, surface "View Live" + "Stop" buttons next to the REVIEW MODE
  // badge so the user can switch to the live view or abort without
  // hunting for the controls.
  const reviewedRunIsLive = useReviewedRunIsLive(review);

  // Root shows SetupForm (new swarms). 
  // Active runs now visible via the (always-on for non-review) ActiveRunsPanel.
  // No more root-specific reset guards or singleton pollution hacks.
  const showSetup = review === null && isOnRoot;

  const effectiveShowSetup = showSetup;

  return (
    <SystemWrapper parentPath={parentPath}>
      {/* Banners — fixed height, never shrink */}
      <div className="shrink-0">
        {/* Per-run route banner (inside flex layout so it counts toward height) */}
        {routeRunId ? (
          <div
            className="px-3 py-1 bg-emerald-950/60 border-b border-emerald-800/50 text-xs font-mono text-emerald-300"
          >
            Viewing run <strong>{routeRunId}</strong> · per-run scoped store
            + WS subscription
          </div>
        ) : null}

        {/* Review mode banner */}
        {review ? (
          <div className="px-4 py-1.5 bg-amber-950/40 border-b border-amber-700/50 flex items-center gap-2">
            <span className="text-xs text-amber-300 font-mono">
              REVIEW MODE · run {review.runId.slice(0, 8)}
            </span>
            {reviewedRunIsLive ? <ReviewActiveControls /> : null}
          </div>
        ) : null}

        {/* Error banner */}
        {error ? <ErrorBanner error={error} /> : null}

        {deferredApplied ? (
          <div
            className="px-4 py-1.5 bg-sky-950/50 border-b border-sky-700/40 text-xs text-sky-100 flex items-center gap-2"
            role="status"
          >
            <span className="font-semibold text-sky-200 shrink-0">RECONFIG applied on Start</span>
            <span className="font-mono text-sky-100/90 truncate" title={deferredApplied.applied.join(", ")}>
              {deferredApplied.applied.join(" · ")}
            </span>
            <button
              type="button"
              onClick={() => setDeferredApplied(null)}
              className="ml-auto shrink-0 text-sky-300 hover:text-white text-lg leading-none px-1"
              aria-label="Dismiss RECONFIG notice"
            >
              ×
            </button>
          </div>
        ) : null}

        <AuditorGateBanner />

        {/* Active runs panel (when ≥1 run).
            Now shown on root too after aggressive guard removal.
            Lets users see/ manage concurrent runs directly from the setup view.
            The old !isOnRoot was a display-blocking guard. */}
        {review === null && <ActiveRunsPanel />}
      </div>

      {/* Main content: SetupForm or SwarmView */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {effectiveShowSetup ? <SetupForm /> : <SwarmView key={routeRunId ?? storeRunId ?? "singleton"} />}
      </div>
    </SystemWrapper>
  );
}

// Task #163: poll /api/swarm/status while in review mode to detect
// whether the reviewed run is the currently-active live run. Returns
// true once status.runId matches review.runId (and stays true until
// the live run ends or the user navigates away).
function useReviewedRunIsLive(review: { runId: string; clonePath: string } | null): boolean {
  const [isLive, setIsLive] = useState(false);
  useEffect(() => {
    if (!review) {
      setIsLive(false);
      return;
    }
    // Fakes and review-only entries never become "live" runs; avoid 404 spam on /status.
    if (review.runId.startsWith('fake-') || review.runId.includes('fake')) {
      setIsLive(false);
      return;
    }
    let cancelled = false;
    const ctrl = new AbortController();
    async function check() {
      try {
        const r = await apiFetch(`/api/swarm/runs/${encodeURIComponent(review!.runId)}/status`,
          { signal: ctrl.signal },
        );
        if (!r.ok) return;
        const body = (await r.json()) as { runId?: string; phase?: string };
        if (!cancelled) {
          const live =
            body.runId === review!.runId &&
            body.phase !== "completed" &&
            body.phase !== "stopped" &&
            body.phase !== "failed";
          setIsLive(live);
        }
      } catch {
        // ignore — next tick will retry
      }
    }
    void check();
    const t = setInterval(check, 15_000);
    return () => {
      cancelled = true;
      clearInterval(t);
      ctrl.abort();
    };
  }, [review]);
  return isLive;
}

// Task #163: control row shown in REVIEW MODE when the reviewed run is
// the live one. Single "View Live" button exits review mode (clears the
// ?review URL params and reloads). The Stop button lives in live mode
// (SwarmView header), not here — review mode is for inspection, not
// control. Once the user hits "View Live", they get the existing Stop
// button in SwarmView.
function ReviewActiveControls() {
  const onViewLive = () => {
    // Clear the review params and reload — re-mount drops review mode
    // and re-attaches the live WebSocket.
    const url = new URL(window.location.href);
    url.searchParams.delete("review");
    url.searchParams.delete("path");
    window.location.href = url.toString();
  };
  return (
    <span className="flex items-center gap-2">
      <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-700/30 border border-emerald-600/40 text-emerald-300 font-semibold">
        ● live
      </span>
      <button
        onClick={onViewLive}
        title="Switch out of REVIEW MODE and connect to the live WebSocket for this run (the Stop button is in the live view)"
        className="text-xs px-2 py-0.5 rounded border border-emerald-700/60 text-emerald-200 hover:bg-emerald-900/40 hover:border-emerald-600 transition"
      >
        View Live ↗
      </button>
    </span>
  );
}

// Hydrates the store from a saved RunSummary so the existing live-view
// components render a past run. Only runs in review mode; no-op otherwise.
function useReviewHydration(review: { runId: string; clonePath: string } | null) {
  const setRunId = useSwarm((s) => s.setRunId);
  const setRunStartedAt = useSwarm((s) => s.setRunStartedAt);
  const setRunConfig = useSwarm((s) => s.setRunConfig);
  const setSummary = useSwarm((s) => s.setSummary);
  const setContract = useSwarm((s) => s.setContract);
  const appendEntry = useSwarm((s) => s.appendEntry);
  const setError = useSwarm((s) => s.setError);
  const setPhase = useSwarm((s) => s.setPhase);
  const setBrainChatHistory = useSwarm((s: any) => s.setBrainChatHistory);
  const upsertAgent = useSwarm((s) => s.upsertAgent);

  useEffect(() => {
    if (!review) return;
    let cancelled = false;
    const ctrl = new AbortController();
    (async () => {
      try {
        const params = new URLSearchParams({
          clonePath: review.clonePath,
          runId: review.runId,
        });
        const r = await apiFetch(`/api/swarm/run-summary?${params.toString()}`, { signal: ctrl.signal });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const summary = (await r.json()) as RunSummary;
        if (cancelled) return;
        // Hydrate identity + ticker + topbar.
        setRunId(review.runId);
        setRunStartedAt(summary.startedAt);
        setRunConfig({
          preset: summary.preset,
          plannerModel: summary.model,
          workerModel: summary.model,
          auditorModel: summary.model,
          dedicatedAuditor: false,
          repoUrl: summary.repoUrl,
          clonePath: summary.localPath || review.clonePath,
          agentCount: Array.isArray(summary.agents) ? summary.agents.length : ((summary as any).agentCount || 0),
          rounds: 0,
          wallClockCapMin: (summary as any).wallClockCapMin,
          ambitionTiers: (summary as any).ambitionTiers,
        });
        setSummary(summary);
        if (summary.contract) setContract(summary.contract);
        // Replay transcript through the existing append path so
        // Transcript / MetricsPanel / etc. don't need to know they're
        // looking at a snapshot.
        if (summary.transcript) {
          for (const e of summary.transcript) appendEntry(e);
        }
        // Load prior brain chat history on review/recovery
        if (summary.brainChatHistory && Array.isArray(summary.brainChatHistory)) {
          setBrainChatHistory(summary.brainChatHistory);
        }
        // Phase is whatever the run terminated as; map stopReason →
        // a display phase that makes the PhasePill render sensibly.
        const phase = summary.stopReason === "completed" ? "completed"
          : summary.stopReason === "crash" || summary.stopReason === "crashed" ? "failed"
          : summary.stopReason === "user" ? "stopped"
          : summary.stopReason === "no-progress" || summary.stopReason === "partial-progress" ? "stopped"
          : "stopped";
        setPhase(phase, 0);
      } catch (err) {
        if (!cancelled) {
          setError(`Review hydration failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    })();
    return () => {
      cancelled = true;
      ctrl.abort();
    };
    // Hydrate once per (runId, clonePath); store setters are stable references.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [review?.runId, review?.clonePath]);
}


