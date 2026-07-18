import { useState, useEffect, useLayoutEffect, useCallback, useRef } from "react";
import type { BrainConfigPatch } from "../components/BrainStartChat";
import { useSwarm } from "../state/store";
import { usePreflight } from "../hooks/usePreflight";
import { PRESETS } from "../components/setup/presets";
import { topologyForPreset } from "../components/setup/TopologyGrid";
import type { Topology } from "../../../shared/src/topology";
import { detectProvider, type Provider } from "../../../shared/src/providers";
import {
  loadRecentRuns,
  removeRecentRun,
  saveRecentRun,
  type RecentRun,
} from "../components/setup/RecentRuns";
import { apiFetch } from "../lib/apiFetch";
import {
  applyDeferredReconfigToStartFields,
  clearDeferredReconfig,
  readDeferredReconfig,
  writeDeferredAppliedNotice,
  type DeferredReconfigRecord,
} from "../lib/deferredReconfig";
import { formatReconfigLabel } from "../components/brainChat/chatHelpers";
import {
  consumePendingSetupSnapshot,
  peekPendingSetupSnapshot,
  snapshotInputToRecentRun,
} from "../lib/pendingSetupSnapshot";

// Minimal surface to keep the thin SetupForm working.
// Full logic can be expanded here later.

export function useSetupForm(navigate: (path: string) => void) {
  // Initial values may come from URL query params (e.g. from history "start on clone" links)
  const initialFromUrl = (() => {
    if (typeof window === "undefined") return { parentPath: "", repoUrl: "", preset: "", model: "" };
    const sp = new URLSearchParams(window.location.search);
    return {
      parentPath: sp.get("parentPath") || "",
      repoUrl: sp.get("repoUrl") || "",
      preset: sp.get("preset") || "",
      model: sp.get("model") || "",
    };
  })();

  const [repoUrl, setRepoUrl] = useState(initialFromUrl.repoUrl);
  const [parentPath, setParentPath] = useState(initialFromUrl.parentPath); // user must set a real local workspace/clone dir before start
  const [presetId, _setPresetId] = useState<string>(initialFromUrl.preset || "blackboard");
  const [agentCount, setAgentCount] = useState(3);
  const [model, setModel] = useState(initialFromUrl.model || PRESETS[0].recommendedModel);
  const [provider, setProvider] = useState<Provider>(() => detectProvider(PRESETS[0].recommendedModel));
  const [plannerModel, setPlannerModel] = useState("");
  const [workerModel, setWorkerModel] = useState("");
  const [auditorModel, setAuditorModel] = useState("");
  const [topology, setTopology] = useState<Topology>(() => topologyForPreset("round-robin", 3, { 
    lastUsed: true,
    plannerModel: model,
    workerModel: model,
    auditorModel: model,
  }));

  // Wrapped setter that also resets topology/agentCount for the new preset.
  // We deliberately do NOT use lastUsed here: explicit mode switch always starts
  // from the preset's recommended shape (correct roles + count). This prevents
  // stale/polluted lastUsed data (e.g. round-robin peers) from being applied to
  // a different preset.
  // lastUsed recovery only happens on initial mount via the useState initializer.
  const setPresetId = useCallback((id: string) => {
    const p = PRESETS.find((pp) => pp.id === id) ?? PRESETS[0];
    const rec = p.recommended ?? p.min;
    _setPresetId(id);
    setAgentCount(rec);
    const newTopo = topologyForPreset(id, rec, {
      // Seed per-agent models from current form state (planner etc. fall back to main model)
      plannerModel: plannerModel || model,
      workerModel: workerModel || model,
      auditorModel: auditorModel || model,
    });  // fresh synthesize for this preset
    setTopology(newTopo);
  }, [plannerModel, workerModel, auditorModel, model]);

  // Apply URL-driven prefill for preset — NEVER when loadSetup=1 or pending snapshot
  // (full history restore owns topology / directive / all flags).
  useEffect(() => {
    if (typeof window !== "undefined") {
      const sp = new URLSearchParams(window.location.search);
      if (sp.get("loadSetup") === "1" || peekPendingSetupSnapshot()) return;
    }
    if (initialFromUrl.preset) {
      setPresetId(initialFromUrl.preset);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Clean up the query params we consumed for prefill (so refresh doesn't re-trigger etc.)
  useEffect(() => {
    if (typeof window !== "undefined") {
      const sp = new URLSearchParams(window.location.search);
      if (
        sp.has("parentPath")
        || sp.has("preset")
        || sp.has("autoStart")
        || sp.has("repoUrl")
        || sp.has("model")
        || sp.has("loadSetup")
      ) {
        // remove only the setup-related ones we handled
        ["parentPath", "repoUrl", "preset", "model", "loadSetup"].forEach((k) => sp.delete(k));
        // leave autoStart for the auto-start effect to consume on this mount
        const clean = sp.toString();
        const newUrl = window.location.pathname + (clean ? "?" + clean : "") + window.location.hash;
        window.history.replaceState({}, "", newUrl);
      }
    }
  }, []);

  const [roundsInput, setRoundsInput] = useState(0);
  const [userDirective, setUserDirective] = useState("");
  const [webTools, setWebTools] = useState(true);
  /**
   * High-trust: max tools for every role + auto-approve auditor commits.
   * Default off — operator must opt in.
   */
  const [autoApprove, setAutoApprove] = useState(false);
  /** Council: shared contract explore (default off — independent explore). */
  // Default on for multi-drafter council (d3f56d9a: independent explore thrash).
  const [councilSharedExplore, setCouncilSharedExplore] = useState(true);
  /** Council: collective research standup each cycle (default off). */
  const [councilSharedResearch, setCouncilSharedResearch] = useState(false);
  /** Council: how synthesis settles (revise=merge default; judge=pick one). */
  const [councilReconcile, setCouncilReconcile] = useState<"revise" | "vote" | "judge">(
    "revise",
  );
  const [mcpServers, setMcpServers] = useState("");
  const [wallClockCapMin, setWallClockCapMin] = useState("0");
  const [ambitionTiers, setAmbitionTiers] = useState("");
  /** Write mode for discussion deliverable apply (multi is experimental). */
  const [writeMode, setWriteMode] = useState<"none" | "single" | "multi">("single");
  const [conflictPolicy, setConflictPolicy] = useState<
    "merge" | "sequential" | "vote" | "judge" | "pick"
  >("vote");
  /** Blackboard: shell command run before commit (and optional worker preflight). */
  const [verifyCommand, setVerifyCommand] = useState("");
  /** Blackboard: apply+verify+revert before proposeCommit when verifyCommand set. */
  const [preflightDryRun, setPreflightDryRun] = useState(false);
  /** Blackboard: few-shot similar past hunks in worker prompts. */
  const [hunkRag, setHunkRag] = useState(false);
  /** Round-robin: LLM picks next disposition vs fixed cycle. */
  const [dynamicRolePicker, setDynamicRolePicker] = useState(false);
  /** Discussion: structured @-mention contracts between agents. */
  const [mentionContracts, setMentionContracts] = useState(false);
  /** Council: K parallel synthesis samples + judge pick (1 = off). */
  const [bestOfNTurn, setBestOfNTurn] = useState(1);
  const [busy, setBusy] = useState(false);
  /** Brain RECONFIG saved after a finished run — shown on setup until Start or dismiss. */
  const [deferredPending, setDeferredPending] = useState<DeferredReconfigRecord | null>(
    () => readDeferredReconfig(),
  );

  const dismissDeferredPending = useCallback(() => {
    clearDeferredReconfig();
    setDeferredPending(null);
  }, []);

  // Keep the autocomplete provider in sync with the main model choice.
  // This ensures per-agent model overrides in the Topology grid (and
  // any role overrides) show the correct catalog (local Ollama tags vs
  // Ollama Cloud catalog vs Anthropic/OpenAI lists).
  useEffect(() => {
    if (model) {
      const detected = detectProvider(model);
      if (detected !== provider) {
        setProvider(detected);
      }
    }
  }, [model, provider]);

  const setError = useSwarm((s) => s.setError);
  const reset = useSwarm((s) => s.reset);

  const preset = PRESETS.find((p) => p.id === presetId) ?? PRESETS[0];
  const isActive = preset.status === "active";

  /** When true, skip preset-default side effects that would wipe a restored snapshot. */
  const restoringSnapshotRef = useRef(false);

  // Preset-aware defaults for caps/tiers — skip while hydrating a full snapshot.
  useEffect(() => {
    if (restoringSnapshotRef.current) return;
    if (preset.id === "blackboard") {
      if (!wallClockCapMin || wallClockCapMin.trim() === "") {
        setWallClockCapMin("0");
      }
      if (ambitionTiers === undefined || ambitionTiers.trim() === "") {
        setAmbitionTiers("0");
      }
      setWebTools(true);
    } else if (["round-robin", "role-diff", "council", "debate-judge", "orchestrator-worker", "map-reduce", "stigmergy"].includes(preset.id)) {
      if (!wallClockCapMin || wallClockCapMin.trim() === "") {
        setWallClockCapMin("0");
      }
    }
  }, [preset.id]);

  // Live sync caps to global store during form editing (for bar / other UI to react).
  useEffect(() => {
    useSwarm.setState((s) => ({
      wallClockCapMin: wallClockCapMin || undefined,
      ambitionTiers: ambitionTiers || undefined,
    }));
  }, [wallClockCapMin, ambitionTiers]);

  const preflight = usePreflight(repoUrl, parentPath, {
    model,
    plannerModel,
    workerModel,
    auditorModel,
  });
  const preflightBlocked = preflight.state?.blocker === "not-git-repo";

  const [topologyOpen, setTopologyOpen] = useState(false);
  const [recentRuns, setRecentRuns] = useState<RecentRun[]>(() => loadRecentRuns());

  // Re-read localStorage when user returns to setup (navigation remounts, or
  // same tab after another window wrote). Fixes "list stuck on old chips".
  useEffect(() => {
    const refresh = () => setRecentRuns(loadRecentRuns());
    refresh();
    const onVis = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  const onPresetChange = (e: any) => {
    const next = PRESETS.find((p) => p.id === e.target.value);
    if (next) setPresetId(next.id);
  };

  const onTopologyChange = (next: Topology) => setTopology(next);

  /**
   * Full form rehydrate from a recent-run / history snapshot.
   * Applies every start field; keeps restoringSnapshotRef true long enough
   * that TopologyGrid / preset default effects cannot wipe topology.
   */
  const refillFromRecent = useCallback((r: RecentRun) => {
    restoringSnapshotRef.current = true;

    const applyAll = () => {
      setRepoUrl(r.repoUrl || "");
      setParentPath(r.parentPath || "");
      if (r.model) {
        setModel(r.model);
        setProvider(detectProvider(r.model));
      }
      if (r.provider) setProvider(r.provider as Provider);
      setPlannerModel(r.plannerModel ?? "");
      setWorkerModel(r.workerModel ?? "");
      setAuditorModel(r.auditorModel ?? "");

      if (r.presetId) _setPresetId(r.presetId);

      const nAgents =
        r.topology?.agents?.length
        ?? r.agentCount
        ?? undefined;
      if (r.topology?.agents?.length) {
        // Deep clone so TopologyGrid effects cannot mutate our snapshot object.
        setTopology(JSON.parse(JSON.stringify(r.topology)) as Topology);
        setAgentCount(nAgents ?? r.topology.agents.length);
      } else if (nAgents != null && r.presetId) {
        setAgentCount(nAgents);
        setTopology(
          topologyForPreset(r.presetId, nAgents, {
            plannerModel: r.plannerModel || r.model,
            workerModel: r.workerModel || r.model,
            auditorModel: r.auditorModel || r.model,
          }),
        );
      }

      setUserDirective(r.directive ?? r.directiveSnippet ?? "");
      setWallClockCapMin(r.wallClockCapMin != null ? String(r.wallClockCapMin) : "0");
      setAmbitionTiers(r.ambitionTiers != null ? String(r.ambitionTiers) : "");
      if (r.rounds != null) setRoundsInput(r.rounds);
      if (r.webTools != null) setWebTools(!!r.webTools);
      if (r.autoApprove != null) setAutoApprove(!!r.autoApprove);
      setMcpServers(r.mcpServers ?? "");
      if (r.writeMode != null) setWriteMode(r.writeMode);
      if (r.conflictPolicy != null) setConflictPolicy(r.conflictPolicy);
      if (r.councilSharedExplore != null) setCouncilSharedExplore(!!r.councilSharedExplore);
      if (r.councilSharedResearch != null) setCouncilSharedResearch(!!r.councilSharedResearch);
      if (r.councilReconcile != null) setCouncilReconcile(r.councilReconcile);
      setVerifyCommand(r.verifyCommand ?? "");
      if (r.preflightDryRun != null) setPreflightDryRun(!!r.preflightDryRun);
      if (r.hunkRag != null) setHunkRag(!!r.hunkRag);
      if (r.dynamicRolePicker != null) setDynamicRolePicker(!!r.dynamicRolePicker);
      if (r.mentionContracts != null) setMentionContracts(!!r.mentionContracts);
      if (r.bestOfNTurn != null) setBestOfNTurn(r.bestOfNTurn);
    };

    applyAll();
    // Second pass after TopologyGrid mount effects (preset.key remount).
    requestAnimationFrame(() => {
      applyAll();
      setTimeout(() => {
        applyAll();
        restoringSnapshotRef.current = false;
      }, 250);
    });
  }, []);

  const removeFromRecent = (r: RecentRun) => {
    const next = removeRecentRun(r.id || r.runId || "");
    setRecentRuns(next);
  };

  // History modal "Load params" — StrictMode-safe full restore.
  useLayoutEffect(() => {
    const pending = consumePendingSetupSnapshot();
    if (!pending) return;
    refillFromRecent(snapshotInputToRecentRun(pending));
  }, [refillFromRecent]);

  const startSwarmDirectlyFromBrain = async (cfg: BrainConfigPatch) => {
    setBusy(true);
    try {
      // Harden the stub: apply config from structured Brain response,
      // then delegate to the real performStart (which has path validation guards).
      if (cfg.preset) setPresetId(cfg.preset);
      if (cfg.model) setModel(cfg.model);
      const cp = (cfg as any).parentPath || (cfg as any).clonePath || (cfg as any).localPath;
      if (cp && typeof cp === "string") setParentPath(cp);
      if ((cfg as any).userDirective) setUserDirective((cfg as any).userDirective);
      if ((cfg as any).agentCount != null) setAgentCount(Number((cfg as any).agentCount));
      if ((cfg as any).rounds != null) setRoundsInput(Number((cfg as any).rounds));
      // Trigger real start flow (validates workspace path etc.)
      await performStart();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const performStart = async () => {
    setBusy(true);

    if (!parentPath || parentPath.trim().length < 3) {
      setError("Please set a real 'Project folder (workspace)' path (the local directory to use/clone into).");
      setBusy(false);
      return;
    }
    // catch common template placeholders
    if (parentPath.includes("you\\projects") || parentPath.includes("you/projects") || parentPath.includes("my-repo")) {
      setError("Please set a real 'Project folder (workspace)' path — replace the placeholder with your actual local directory.");
      setBusy(false);
      return;
    }

    // Global store sync for caps (so bar, review, other panels see live values
    // even before run_started event arrives).
    const { setRunConfig, runConfig: currentRunConfig } = useSwarm.getState();
    setRunConfig({
      ...(currentRunConfig || {}),
      wallClockCapMin: wallClockCapMin || undefined,
      ambitionTiers: ambitionTiers || undefined,
    } as any);

    // the real long logic lives here or can be expanded
    try {
      const directiveTrimmed = userDirective.trim();
      const maturity = (preset as { maturity?: string }).maturity;
      const needsExperimentalAck =
        maturity === "experimental"
        || maturity === "research"
        || writeMode === "multi";

      // Brain RECONFIG deferred after a finished run — fold into start fields.
      // Only clear sessionStorage after a successful start so failed starts can retry.
      let startRounds = roundsInput;
      let startWallMin = wallClockCapMin;
      let startTokenBudget: number | undefined;
      let deferredApplied: string[] = [];
      let deferredSourceRunId: string | undefined;
      const deferred = readDeferredReconfig();
      if (deferred?.patch) {
        const merged = applyDeferredReconfigToStartFields({
          rounds: startRounds,
          wallClockCapMin: startWallMin,
          patch: deferred.patch,
        });
        startRounds = merged.rounds;
        startWallMin = merged.wallClockCapMin;
        startTokenBudget = merged.tokenBudget;
        deferredApplied = merged.applied;
        deferredSourceRunId = deferred.runId;
        if (merged.applied.length > 0) {
          // Reflect in form so the user sees what will be used.
          setRoundsInput(startRounds);
          setWallClockCapMin(startWallMin);
        }
      }

      const payload = {
        repoUrl,
        parentPath,
        preset: preset.id,
        model,
        agentCount,
        rounds: startRounds,
        // Server fail-closed for experimental/research unless acknowledged.
        ...(needsExperimentalAck ? { allowExperimental: true } : {}),
        ...(writeMode && writeMode !== "none" ? { writeMode } : {}),
        ...(writeMode === "multi" ? { conflictPolicy } : {}),
        ...(directiveTrimmed ? { userDirective: directiveTrimmed } : {}),
        webTools,
        ...(autoApprove ? { autoApprove: true } : {}),
        ...(preset.id === "council" || preset.id === "blackboard"
          ? {
              // Always send bool so uncheck (false) opts out of shared explore default.
              councilSharedExplore,
              councilSharedResearch:
                preset.id === "council" && councilSharedResearch ? true : undefined,
            }
          : {}),
        ...(preset.id === "council" && councilReconcile && councilReconcile !== "revise"
          ? { councilReconcile }
          : {}),
        ...(preset.id === "blackboard" && verifyCommand.trim()
          ? { verifyCommand: verifyCommand.trim() }
          : {}),
        ...(preset.id === "blackboard" && preflightDryRun && verifyCommand.trim()
          ? { preflightDryRun: true }
          : {}),
        ...(preset.id === "blackboard" && hunkRag ? { hunkRag: true } : {}),
        ...(preset.id === "round-robin" && dynamicRolePicker
          ? { dynamicRolePicker: true }
          : {}),
        ...((
          [
            "round-robin",
            "role-diff",
            "council",
            "debate-judge",
            "map-reduce",
            "moa",
            "stigmergy",
            "orchestrator-worker",
            "orchestrator-worker-deep",
          ].includes(preset.id) && mentionContracts
        )
          ? { mentionContracts: true }
          : {}),
        ...(preset.id === "council" && bestOfNTurn > 1
          ? { bestOfNTurn: Math.min(5, Math.max(2, Math.floor(bestOfNTurn))) }
          : {}),
        mcpServers,
        // Per-agent provider/model from the Topology grid (including header
        // bulk-apply). Discussion presets spawn via resolveModelForTopologyIndex;
        // blackboard also honors per-row overrides at spawn.
        topology,
        // Explicit per-role overrides (if user set them in Advanced section)
        // take precedence over topology-derived in resolveModels.
        plannerModel: plannerModel || undefined,
        workerModel: workerModel || undefined,
        auditorModel: auditorModel || undefined,
        // Convert UI strings to server-expected units (ms for cap, number for tiers)
        wallClockCapMs: startWallMin && Number(startWallMin) > 0
          ? Number(startWallMin) * 60 * 1000
          : undefined,
        ...(startTokenBudget && startTokenBudget > 0
          ? { tokenBudget: startTokenBudget }
          : {}),
        ambitionTiers: ambitionTiers ? Number(ambitionTiers) : undefined,
      };
      const res = await apiFetch("/api/swarm/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      console.log('[DEBUG-START] /start response', { ok: res.ok, status: res.status, body });
      if (!res.ok) {
        const msg = body?.error || (body?._detail ? JSON.stringify(body._detail) : `HTTP ${res.status}`);
        setError(msg);
        return;
      }
      // Start succeeded — consume deferred RECONFIG and surface a one-shot notice.
      if (deferred?.patch) {
        clearDeferredReconfig();
        setDeferredPending(null);
        if (deferredApplied.length > 0) {
          writeDeferredAppliedNotice({
            applied: deferredApplied,
            at: Date.now(),
            sourceRunId: deferredSourceRunId,
          });
        }
      }
      if (body.runId) {
        console.log('[DEBUG-START] got runId, navigating', body.runId);
        // Full form snapshot so list-row refill restores topology, MCP, flags, etc.
        const saved = saveRecentRun({
          repoUrl,
          parentPath,
          presetId: preset.id,
          directive: directiveTrimmed,
          wallClockCapMin: startWallMin || undefined,
          ambitionTiers: ambitionTiers || undefined,
          runId: body.runId,
          model,
          provider,
          plannerModel: plannerModel || undefined,
          workerModel: workerModel || undefined,
          auditorModel: auditorModel || undefined,
          agentCount,
          rounds: startRounds,
          topology,
          webTools,
          autoApprove,
          mcpServers: mcpServers || undefined,
          writeMode,
          conflictPolicy,
          councilSharedExplore,
          councilSharedResearch,
          councilReconcile,
          verifyCommand: verifyCommand || undefined,
          preflightDryRun,
          hunkRag,
          dynamicRolePicker,
          mentionContracts,
          bestOfNTurn,
        });
        setRecentRuns(saved);
        navigate(`/runs/${encodeURIComponent(body.runId)}`);
      } else {
        console.warn('[DEBUG-START] no runId in response', body);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  // Support ?autoStart=1 from history "Start new swarm on this clone" links.
  // After URL prefill settles, auto-trigger the start (with small delay for preflight).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const sp = new URLSearchParams(window.location.search);
    if (sp.get("autoStart") === "1" && parentPath && parentPath.trim().length >= 3 && !busy) {
      const t = setTimeout(() => {
        performStart();
      }, 250);
      return () => clearTimeout(t);
    }
  }, [parentPath, busy, performStart]);

  const deferredPendingLabel = deferredPending?.patch
    ? formatReconfigLabel(deferredPending.patch)
    : null;

  return {
    repoUrl, setRepoUrl,
    parentPath, setParentPath,
    presetId, setPresetId,
    agentCount, setAgentCount,
    topology, setTopology,
    model, setModel,
    provider, setProvider,
    plannerModel, setPlannerModel,
    workerModel, setWorkerModel,
    auditorModel, setAuditorModel,
    roundsInput, setRoundsInput,
    userDirective, setUserDirective,
    webTools, setWebTools,
    autoApprove, setAutoApprove,
    councilSharedExplore, setCouncilSharedExplore,
    councilSharedResearch, setCouncilSharedResearch,
    councilReconcile, setCouncilReconcile,
    mcpServers, setMcpServers,
    wallClockCapMin, setWallClockCapMin,
    ambitionTiers, setAmbitionTiers,
    writeMode, setWriteMode,
    conflictPolicy, setConflictPolicy,
    verifyCommand, setVerifyCommand,
    preflightDryRun, setPreflightDryRun,
    hunkRag, setHunkRag,
    dynamicRolePicker, setDynamicRolePicker,
    mentionContracts, setMentionContracts,
    bestOfNTurn, setBestOfNTurn,
    busy, setBusy,
    deferredPending,
    deferredPendingLabel,
    dismissDeferredPending,
    preset,
    isActive,
    preflight,
    preflightBlocked,
    topologyOpen, setTopologyOpen,
    recentRuns, setRecentRuns,
    onPresetChange,
    onTopologyChange,
    refillFromRecent,
    removeFromRecent,
    startSwarmDirectlyFromBrain,
    performStart,
  } as any; // surface for the thin component
}
