import { useState, useEffect, useCallback } from "react";
import type { BrainConfigPatch } from "../components/BrainStartChat";
import { useSwarm } from "../state/store";
import { usePreflight } from "../hooks/usePreflight";
import { PRESETS } from "../components/setup/presets";
import { topologyForPreset } from "../components/setup/TopologyGrid";
import type { Topology } from "../../../shared/src/topology";
import { detectProvider, type Provider } from "../../../shared/src/providers";
import { loadRecentRuns, saveRecentRun, type RecentRun } from "../components/setup/RecentRuns";

// Minimal surface to keep the thin SetupForm working.
// Full logic can be expanded here later.

export function useSetupForm(navigate: (path: string) => void) {
  const [repoUrl, setRepoUrl] = useState("");
  const [parentPath, setParentPath] = useState("C:\\Users\\you\\projects\\my-repo");
  const [presetId, _setPresetId] = useState<string>("round-robin");
  const [agentCount, setAgentCount] = useState(3);
  const [model, setModel] = useState(PRESETS[0].recommendedModel);
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
  const [roundsInput, setRoundsInput] = useState(0);
  const [userDirective, setUserDirective] = useState("");
  const [useHybridPlanning, setUseHybridPlanning] = useState(true);
  const [planningPreset, setPlanningPreset] = useState("council");
  const [executionPreset, setExecutionPreset] = useState("blackboard");
  const [webTools, setWebTools] = useState(true);
  const [mcpServers, setMcpServers] = useState("");
  const [wallClockCapMin, setWallClockCapMin] = useState("0");
  const [ambitionTiers, setAmbitionTiers] = useState("");
  const [busy, setBusy] = useState(false);

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

  // Preset-aware defaults for caps/tiers
  // wall-clock cap default 0 (means use server default / no explicit per-run cap)
  useEffect(() => {
    if (preset.id === "blackboard") {
      if (!wallClockCapMin || wallClockCapMin.trim() === "") {
        setWallClockCapMin("0");
      }
      if (ambitionTiers === undefined || ambitionTiers.trim() === "") {
        setAmbitionTiers("0");
      }
      setUseHybridPlanning(true);
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

  const onPresetChange = (e: any) => {
    const next = PRESETS.find((p) => p.id === e.target.value);
    if (next) setPresetId(next.id);
  };

  const onTopologyChange = (next: Topology) => setTopology(next);

  const refillFromRecent = (r: RecentRun) => {
    setRepoUrl(r.repoUrl || "");
    setParentPath(r.parentPath || "");
    if (r.presetId) setPresetId(r.presetId);
    if (r.directive) setUserDirective(r.directive);
    // Restore caps/tiers if present in recent run metadata (for continuity)
    if ((r as any).wallClockCapMin) setWallClockCapMin((r as any).wallClockCapMin);
    if ((r as any).ambitionTiers) setAmbitionTiers((r as any).ambitionTiers);
  };

  const startSwarmDirectlyFromBrain = async (cfg: BrainConfigPatch) => {
    setBusy(true);
    // minimal implementation - in real it builds payload and posts
    setTimeout(() => setBusy(false), 500);
  };

  const performStart = async () => {
    setBusy(true);

    if (!parentPath || parentPath.trim().length < 3 || parentPath.includes("you\\projects") || parentPath.includes("you/projects")) {
      setError("Please set a real 'Project folder (workspace)' path (the local directory to use/clone into).");
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
      const payload = {
        repoUrl,
        parentPath,
        preset: preset.id,
        model,
        agentCount,
        rounds: roundsInput,
        userDirective,
        useHybridPlanning,
        planningPreset,
        executionPreset,
        webTools,
        mcpServers,
        // Per-agent model declarations (from the Topology grid). This is
        // how individual agents get their "AI provider" (via the model
        // string, e.g. different ollama models, :cloud, or anthropic/openai).
        // Server resolveModels + deriveLegacyFields will turn per-agent
        // .model into the plannerModel/workerModel/auditorModel used for spawn.
        topology,
        // Explicit per-role overrides (if user set them in Advanced section)
        // take precedence over topology-derived in resolveModels.
        plannerModel: plannerModel || undefined,
        workerModel: workerModel || undefined,
        auditorModel: auditorModel || undefined,
        // Convert UI strings to server-expected units (ms for cap, number for tiers)
        wallClockCapMs: wallClockCapMin && Number(wallClockCapMin) > 0
          ? Number(wallClockCapMin) * 60 * 1000
          : undefined,
        ambitionTiers: ambitionTiers ? Number(ambitionTiers) : undefined,
      };
      const res = await fetch("/api/swarm/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = body?.error || (body?._detail ? JSON.stringify(body._detail) : `HTTP ${res.status}`);
        setError(msg);
        return;
      }
      if (body.runId) {
        // persist including caps/tiers for refill
        const saved = saveRecentRun({
          repoUrl,
          parentPath,
          presetId: preset.id,
          directive: userDirective,
          wallClockCapMin: wallClockCapMin || undefined,
          ambitionTiers: ambitionTiers || undefined,
        });
        setRecentRuns(saved);
        navigate(`/runs/${encodeURIComponent(body.runId)}`);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

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
    useHybridPlanning, setUseHybridPlanning,
    planningPreset, setPlanningPreset,
    executionPreset, setExecutionPreset,
    webTools, setWebTools,
    mcpServers, setMcpServers,
    wallClockCapMin, setWallClockCapMin,
    ambitionTiers, setAmbitionTiers,
    busy, setBusy,
    preset,
    isActive,
    preflight,
    preflightBlocked,
    topologyOpen, setTopologyOpen,
    recentRuns, setRecentRuns,
    onPresetChange,
    onTopologyChange,
    refillFromRecent,
    startSwarmDirectlyFromBrain,
    performStart,
  } as any; // surface for the thin component
}
