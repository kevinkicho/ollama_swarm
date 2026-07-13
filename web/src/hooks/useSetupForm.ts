import { useState, useEffect, useCallback } from "react";
import type { BrainConfigPatch } from "../components/BrainStartChat";
import { useSwarm } from "../state/store";
import { usePreflight } from "../hooks/usePreflight";
import { PRESETS } from "../components/setup/presets";
import { topologyForPreset } from "../components/setup/TopologyGrid";
import type { Topology } from "../../../shared/src/topology";
import { detectProvider, type Provider } from "../../../shared/src/providers";
import { loadRecentRuns, saveRecentRun, type RecentRun } from "../components/setup/RecentRuns";
import { apiFetch } from "../lib/apiFetch";

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

  // Apply URL-driven prefill for preset (and related) from "start on clone" links in history.
  // Runs once after mount. Uses the initialFromUrl captured at first render.
  useEffect(() => {
    if (initialFromUrl.preset) {
      // setPresetId will trigger topology/agent count reset for that preset
      setPresetId(initialFromUrl.preset);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Clean up the query params we consumed for prefill (so refresh doesn't re-trigger etc.)
  useEffect(() => {
    if (typeof window !== "undefined") {
      const sp = new URLSearchParams(window.location.search);
      if (sp.has("parentPath") || sp.has("preset") || sp.has("autoStart") || sp.has("repoUrl") || sp.has("model")) {
        // remove only the setup-related ones we handled
        ["parentPath", "repoUrl", "preset", "model"].forEach(k => sp.delete(k));
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
  /** Council: shared contract explore (default off — independent explore). */
  const [councilSharedExplore, setCouncilSharedExplore] = useState(false);
  /** Council: collective research standup each cycle (default off). */
  const [councilSharedResearch, setCouncilSharedResearch] = useState(false);
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
        maturity === "experimental" || maturity === "research";
      const payload = {
        repoUrl,
        parentPath,
        preset: preset.id,
        model,
        agentCount,
        rounds: roundsInput,
        // Server fail-closed for experimental/research unless acknowledged.
        ...(needsExperimentalAck ? { allowExperimental: true } : {}),
        ...(directiveTrimmed ? { userDirective: directiveTrimmed } : {}),
        webTools,
        ...(preset.id === "council" || preset.id === "blackboard"
          ? {
              councilSharedExplore: councilSharedExplore || undefined,
              councilSharedResearch:
                preset.id === "council" && councilSharedResearch ? true : undefined,
            }
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
        wallClockCapMs: wallClockCapMin && Number(wallClockCapMin) > 0
          ? Number(wallClockCapMin) * 60 * 1000
          : undefined,
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
      if (body.runId) {
        console.log('[DEBUG-START] got runId, navigating', body.runId);
        // persist including caps/tiers for refill
        const saved = saveRecentRun({
          repoUrl,
          parentPath,
          presetId: preset.id,
          directive: directiveTrimmed,
          wallClockCapMin: wallClockCapMin || undefined,
          ambitionTiers: ambitionTiers || undefined,
          runId: body.runId,
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
    councilSharedExplore, setCouncilSharedExplore,
    councilSharedResearch, setCouncilSharedResearch,
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
