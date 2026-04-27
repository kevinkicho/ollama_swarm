import { create } from "zustand";
import type {
  AgentState,
  BoardSnapshot,
  Claim,
  CloneState,
  ExitContract,
  Finding,
  LatencySample,
  PheromoneEntry,
  RunConfigSnapshot,
  RunSummary,
  SwarmPhase,
  Todo,
  TranscriptEntry,
} from "../types";

// Unit 40: cap per-agent rolling window. 20 samples is enough for a
// sparkline to show "is the current wait unusually long vs. recent
// attempts?" without unbounded growth over a multi-hour run.
const LATENCY_WINDOW = 20;

interface SwarmStore {
  phase: SwarmPhase;
  round: number;
  agents: Record<string, AgentState>;
  transcript: TranscriptEntry[];
  streaming: Record<string, string>;
  // Task #176 Phase A+B: per-agent streaming metadata. Drives the
  // "thinking N.Ns…" subtitle (lastTextAt → wall-clock since last
  // chunk) and the post-completion persistent bubble (status="done"
  // keeps the bubble visible with ✓ until transcript_append takes
  // over the same DOM position).
  streamingMeta: Record<
    string,
    { startedAt: number; lastTextAt: number; status: "live" | "done"; endedAt?: number }
  >;
  todos: Record<string, Todo>;
  findings: Finding[];
  contract?: ExitContract;
  summary?: RunSummary;
  // Topbar error banner. Carries runId at error-time so a stale error
  // from a long-dead run is obvious to the user (and can be dismissed).
  error?: { message: string; runId?: string; ts: number };
  latency: Record<string, LatencySample[]>;
  // Unit 47: latest clone_state event for the current run, or
  // undefined before the runner emits it. UI uses this to show the
  // "you're resuming an existing clone" banner.
  cloneState?: CloneState;
  // Unit 47: user has dismissed the resume banner for this run; the
  // banner stays hidden until the next reset (new run start).
  cloneBannerDismissed: boolean;
  // Unit 52a: wall-clock ms-since-epoch at which the orchestrator
  // started this run. Anchors the runtime ticker. Undefined when no
  // run has fired this session OR after reset().
  runStartedAt?: number;
  // Unit 52c: snapshot of the run's config (preset, models, paths)
  // captured from the same run_started event. Drives the
  // run-identity strip.
  runConfig?: RunConfigSnapshot;
  // Unit 52d: app-level run id (uuid) minted at run-start. Distinct
  // from opencode session ids. Used in the identifiers row for
  // click-to-copy + future cross-referencing of per-run artifacts.
  runId?: string;
  // Phase 2a: stigmergy pheromone table. Empty for non-stigmergy
  // presets. Keyed by file path.
  pheromones: Record<string, PheromoneEntry>;
  // Phase 2d: map-reduce mapper slice assignments. Keyed by agentId.
  mapperSlices: Record<string, string[]>;

  setPhase: (phase: SwarmPhase, round: number) => void;
  upsertAgent: (a: AgentState) => void;
  appendEntry: (e: TranscriptEntry) => void;
  setStreaming: (agentId: string, text: string) => void;
  clearStreaming: (agentId: string) => void;
  // Task #176 Phase A: agent_streaming_end now marks the entry as
  // "done" (visual ✓ + fade) but doesn't remove it. The eventual
  // transcript_append takes over that DOM position naturally via
  // appendEntry's existing delete-from-streaming side effect.
  markStreamingEnded: (agentId: string) => void;

  upsertTodo: (t: Todo) => void;
  applyClaim: (todoId: string, claim: Claim) => void;
  markCommitted: (todoId: string) => void;
  markStale: (todoId: string, reason: string, replanCount: number) => void;
  markSkipped: (todoId: string, reason: string) => void;
  applyReplan: (todoId: string, description: string, expectedFiles: string[], replanCount: number) => void;
  appendFinding: (f: Finding) => void;
  replaceBoard: (snapshot: BoardSnapshot) => void;
  setContract: (c: ExitContract) => void;
  setSummary: (s: RunSummary) => void;
  pushLatencySample: (agentId: string, sample: LatencySample) => void;
  setCloneState: (c: CloneState) => void;
  dismissCloneBanner: () => void;
  setRunStartedAt: (ts: number) => void;
  setRunConfig: (c: RunConfigSnapshot) => void;
  setRunId: (id: string) => void;
  upsertPheromone: (file: string, state: PheromoneEntry) => void;
  setMapperSlices: (slices: Record<string, string[]>) => void;

  setError: (msg: string | undefined) => void;
  // Dismiss the topbar error banner (sets error → undefined).
  dismissError: () => void;
  reset: () => void;
  // Task #37 (partial): lighter reset fired on WS run_started — drops
  // agents/streaming/latency only so prior transcript stays readable.
  // Task #46: accepts run metadata so the transcript divider can
  // render the runId + preset + models + agent count + repo instead
  // of a plain "— new run started —" line.
  resetForNewRun: (info?: RunStartDividerInfo) => void;
}

// Task #46: metadata threaded into the transcript divider that
// resetForNewRun appends. All optional — if missing, we fall back
// to the plain "— new run started —" text for back-compat with any
// caller (tests, future code paths) that doesn't have the info.
export interface RunStartDividerInfo {
  runId?: string;
  preset?: string;
  plannerModel?: string;
  workerModel?: string;
  agentCount?: number;
  repoUrl?: string;
}

export const useSwarm = create<SwarmStore>((set) => ({
  phase: "idle",
  round: 0,
  agents: {},
  transcript: [],
  streaming: {},
  streamingMeta: {},
  todos: {},
  findings: [],
  contract: undefined,
  summary: undefined,
  error: undefined,
  latency: {},
  cloneState: undefined,
  cloneBannerDismissed: false,
  runStartedAt: undefined,
  runConfig: undefined,
  runId: undefined,
  pheromones: {},
  mapperSlices: {},

  setPhase: (phase, round) =>
    set((s) => {
      // Task #214: when transitioning to a terminal phase, hard-clear
      // any leftover streaming state. Late `agent_streaming` events
      // arriving AFTER the run-finished transcript_append would
      // re-populate the StreamingDock and render bubbles AFTER the
      // "Run finished" card — confusing post-run order. Forcing the
      // streaming maps empty at terminal-phase guarantees the dock
      // renders nothing and any late events get re-set into an empty
      // map (still cleaned up by the 30s sweeper in Transcript.tsx).
      const isTerminal = phase === "completed" || phase === "stopped" || phase === "failed";
      if (isTerminal && (Object.keys(s.streaming).length > 0 || Object.keys(s.streamingMeta).length > 0)) {
        return { phase, round, streaming: {}, streamingMeta: {} };
      }
      return { phase, round };
    }),
  upsertAgent: (a) => set((s) => ({ agents: { ...s.agents, [a.id]: a } })),
  appendEntry: (e) =>
    set((s) => {
      if (s.transcript.some((t) => t.id === e.id)) return s;
      const nextStreaming = { ...s.streaming };
      const nextMeta = { ...s.streamingMeta };
      if (e.agentId) {
        delete nextStreaming[e.agentId];
        delete nextMeta[e.agentId];
      }
      return { transcript: [...s.transcript, e], streaming: nextStreaming, streamingMeta: nextMeta };
    }),
  setStreaming: (agentId, text) =>
    set((s) => {
      const now = Date.now();
      const prior = s.streamingMeta[agentId];
      const nextMeta = {
        ...s.streamingMeta,
        [agentId]: {
          startedAt: prior?.startedAt ?? now,
          lastTextAt: now,
          status: "live" as const,
          endedAt: undefined,
        },
      };
      return { streaming: { ...s.streaming, [agentId]: text }, streamingMeta: nextMeta };
    }),
  clearStreaming: (agentId) =>
    set((s) => {
      const haveText = agentId in s.streaming;
      const haveMeta = agentId in s.streamingMeta;
      if (!haveText && !haveMeta) return s;
      const next = { ...s.streaming };
      const nextMeta = { ...s.streamingMeta };
      delete next[agentId];
      delete nextMeta[agentId];
      return { streaming: next, streamingMeta: nextMeta };
    }),
  // Task #176 Phase A: ended → "done" but keep the bubble visible.
  // The transcript_append's existing delete-from-streaming side
  // effect will clear it once the matching transcript entry lands.
  // Safety: a 30s sweeper in StreamingDock removes stragglers if
  // the transcript_append never arrives.
  markStreamingEnded: (agentId) =>
    set((s) => {
      if (!(agentId in s.streamingMeta)) return s;
      const prior = s.streamingMeta[agentId];
      return {
        streamingMeta: {
          ...s.streamingMeta,
          [agentId]: { ...prior, status: "done", endedAt: Date.now() },
        },
      };
    }),

  upsertTodo: (t) => set((s) => ({ todos: { ...s.todos, [t.id]: t } })),
  applyClaim: (todoId, claim) =>
    set((s) => {
      const existing = s.todos[todoId];
      if (!existing) return s;
      return {
        todos: { ...s.todos, [todoId]: { ...existing, status: "claimed", claim } },
      };
    }),
  markCommitted: (todoId) =>
    set((s) => {
      const existing = s.todos[todoId];
      if (!existing) return s;
      // committedAt here is a UI-side approximation; a follow-up board_state
      // snapshot replaces it with the authoritative server timestamp.
      return {
        todos: {
          ...s.todos,
          [todoId]: { ...existing, status: "committed", committedAt: Date.now() },
        },
      };
    }),
  markStale: (todoId, reason, replanCount) =>
    set((s) => {
      const existing = s.todos[todoId];
      if (!existing) return s;
      return {
        todos: {
          ...s.todos,
          [todoId]: { ...existing, status: "stale", staleReason: reason, replanCount },
        },
      };
    }),
  markSkipped: (todoId, reason) =>
    set((s) => {
      const existing = s.todos[todoId];
      if (!existing) return s;
      return {
        todos: {
          ...s.todos,
          [todoId]: { ...existing, status: "skipped", skippedReason: reason },
        },
      };
    }),
  applyReplan: (todoId, description, expectedFiles, replanCount) =>
    set((s) => {
      const existing = s.todos[todoId];
      if (!existing) return s;
      return {
        todos: {
          ...s.todos,
          [todoId]: {
            ...existing,
            description,
            expectedFiles,
            replanCount,
            status: "open",
            staleReason: undefined,
            claim: undefined,
          },
        },
      };
    }),
  appendFinding: (f) =>
    set((s) => {
      if (s.findings.some((existing) => existing.id === f.id)) return s;
      return { findings: [...s.findings, f] };
    }),
  replaceBoard: (snapshot) =>
    set(() => {
      const todos: Record<string, Todo> = {};
      for (const t of snapshot.todos) todos[t.id] = t;
      return { todos, findings: snapshot.findings.slice() };
    }),
  setContract: (c) => set({ contract: c }),
  setSummary: (s) => set({ summary: s }),
  pushLatencySample: (agentId, sample) =>
    set((s) => {
      const existing = s.latency[agentId] ?? [];
      const next = existing.concat(sample);
      if (next.length > LATENCY_WINDOW) next.splice(0, next.length - LATENCY_WINDOW);
      return { latency: { ...s.latency, [agentId]: next } };
    }),
  // Unit 47: clone_state arrives once per run. Setting it ALSO clears
  // the dismissed flag so a fresh run shows its banner even if a
  // prior banner was dismissed mid-session (each run has its own
  // dismissal scope).
  setCloneState: (c) => set({ cloneState: c, cloneBannerDismissed: false }),
  dismissCloneBanner: () => set({ cloneBannerDismissed: true }),
  setRunStartedAt: (ts) => set({ runStartedAt: ts }),
  setRunConfig: (c) => set({ runConfig: c }),
  setRunId: (id) => set({ runId: id }),
  upsertPheromone: (file, state) =>
    set((s) => ({ pheromones: { ...s.pheromones, [file]: state } })),
  setMapperSlices: (slices) => set({ mapperSlices: { ...slices } }),

  setError: (msg) =>
    set((s) =>
      msg === undefined
        ? { error: undefined }
        : { error: { message: msg, runId: s.runId, ts: Date.now() } },
    ),
  dismissError: () => set({ error: undefined }),
  reset: () =>
    set({
      phase: "idle",
      round: 0,
      agents: {},
      transcript: [],
      streaming: {}, streamingMeta: {},
      todos: {},
      findings: [],
      contract: undefined,
      summary: undefined,
      error: undefined,
      latency: {},
      cloneState: undefined,
      cloneBannerDismissed: false,
      runStartedAt: undefined,
      runConfig: undefined,
      runId: undefined,
      pheromones: {},
      mapperSlices: {},
    }),
  // Task #37 (partial): clear per-run state when a new run kicks off
  // WITHOUT blowing away transcript/findings/board — those are the
  // history the user may still want to scroll. This addresses the
  // Agent N leftover problem (role-diff's 5 agents lingering after
  // council started with 4) without destroying context from the prior
  // run.
  // Task #46: emits a structured divider marker with run metadata
  // (runId + preset + models + agentCount + repo) so the Transcript
  // renderer can show a rich horizontal-rule block instead of a plain
  // "— new run started —" line. The divider's text uses a sentinel
  // prefix "▸▸RUN-START▸▸" so Transcript.tsx can detect it and render
  // a custom component; fall back to the plain text when no metadata
  // is supplied (test rigs, future callers that lack the fields).
  resetForNewRun: (info) =>
    set((s) => {
      // Fix 2026-04-24 (Kevin caught stigmergy run showing a prior
      // blackboard contract): resetForNewRun must ALSO clear the
      // blackboard-specific panels' data (contract + todos + findings
      // + summary). Otherwise they cross-contaminate — a non-blackboard
      // run inherits the previous blackboard run's contract, making
      // the Contract tab show misleading stale data. Cross-run history
      // lives in the run-history dropdown (task #36), not in the
      // live tabs.
      const blackboardReset: Partial<SwarmStore> = {
        contract: undefined,
        todos: {},
        findings: [],
        summary: undefined,
        // Phase 2a: stigmergy pheromone table is also preset-specific
        // state that shouldn't leak across runs. Cleared here too.
        pheromones: {},
        // Phase 2d: map-reduce slice assignments — same cross-run
        // leak category; cleared on new-run boundary.
        mapperSlices: {},
        // Task #189: clear stale topbar error when a new run starts.
        // A failed prior run's "blackboard run failed: …" banner
        // shouldn't ride along into the new run's session — if the
        // new run hits its own error, the server will set a fresh one.
        error: undefined,
      };
      // Skip the divider entirely on an empty transcript — nothing to
      // divide yet, and it avoids the "first-paint shows a divider"
      // weirdness at run start.
      if (s.transcript.length === 0) {
        return { agents: {}, streaming: {}, streamingMeta: {}, latency: {}, ...blackboardReset };
      }
      // Task #46 also: dedupe consecutive dividers. If the last entry
      // is already a run-start marker, don't stack a second one —
      // fixes the "— new run started — / — new run started —" stack
      // that Kevin flagged during UI testing.
      const lastEntry = s.transcript[s.transcript.length - 1];
      const isLastADivider =
        lastEntry?.role === "system" &&
        (lastEntry.text === "— new run started —" ||
          lastEntry.text.startsWith("▸▸RUN-START▸▸"));
      if (isLastADivider) {
        return { agents: {}, streaming: {}, streamingMeta: {}, latency: {}, ...blackboardReset };
      }
      // Build the divider text. When metadata is supplied, prefix
      // with the sentinel + encode fields as a pipe-separated line
      // the renderer can parse. Otherwise fall back to the old
      // plain-text format.
      const text = info
        ? [
            "▸▸RUN-START▸▸",
            `runId=${info.runId ?? ""}`,
            `preset=${info.preset ?? ""}`,
            `plannerModel=${info.plannerModel ?? ""}`,
            `workerModel=${info.workerModel ?? ""}`,
            `agentCount=${info.agentCount ?? ""}`,
            `repoUrl=${info.repoUrl ?? ""}`,
          ].join("|")
        : "— new run started —";
      return {
        agents: {},
        streaming: {}, streamingMeta: {},
        latency: {},
        ...blackboardReset,
        transcript: [
          ...s.transcript,
          {
            id: `divider-${Date.now()}`,
            role: "system" as const,
            text,
            ts: Date.now(),
          },
        ],
      };
    }),
}));
