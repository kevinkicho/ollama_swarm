import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { PreflightPreview } from "./PreflightPreview";
import { BrainStartChat, type BrainConfigPatch } from "./BrainStartChat";
import { useSetupForm } from "../hooks/useSetupForm";
import { PRESETS } from "./setup/presets";
import { TopologyGrid } from "./setup/TopologyGrid";
import { PlanningPhaseControl, BlackboardWallClockCap, BlackboardAmbitionTiers } from "./setup/BlackboardSettings";
import { Field } from "./setup/SharedFields";
import { InfoTip } from "./setup/InfoTip";
import { estimateWallClockSeconds, formatDurationSeconds } from "./setup/WallClockEstimate";
import { useSwarm } from "../state/store";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="bg-ink-800 border border-ink-700 rounded-lg px-5 py-4 shadow-xl space-y-3">
      <header>
        <h3 className="text-sm font-semibold text-ink-100 uppercase tracking-wider">{title}</h3>
      </header>
      {children}
    </section>
  );
}

// Thin orchestrator. All state, logic, and long handlers live in the hook.
// JSX delegates to existing sub-components in ./setup/.
// This brings the file from >1600 LOC down to a manageable size (~400-500 LOC).

export function SetupForm() {
  const navigate = useNavigate();
  const form = useSetupForm(navigate);

  // Use global store for filters so Brain chat chips can control it live
  const useCaseFilters = useSwarm((s) => s.useCaseFilters);
  const setUseCaseFilters = useSwarm((s) => s.setUseCaseFilters);

  const USE_CASE_OPTIONS = [
    { tag: "research", label: "Research" },
    { tag: "analysis", label: "Analysis/Debate" },
    { tag: "code-writing", label: "Code Writing" },
    { tag: "literature-scan", label: "Literature Scan" },
    { tag: "synthesis", label: "Synthesis" },
    { tag: "exploration", label: "Exploration" },
    { tag: "hierarchical", label: "Hierarchical" },
    { tag: "multi-stage", label: "Multi-stage" },
  ];

  const filteredPresets = useMemo(() =>
    useCaseFilters.length === 0
      ? PRESETS
      : PRESETS.filter(p => p.useCases?.some(uc => useCaseFilters.includes(uc))),
    [useCaseFilters]
  );

  // Derived for the action bar
  const canStart = !form.busy && !!form.isActive && !form.preflightBlocked;
  const presetId = form.preset?.id || 'round-robin';
  const rounds = form.roundsInput || 0;
  const agentCount = form.agentCount || 3;
  const model = form.model || '';
  const wallClockCapMin = form.wallClockCapMin || '';
  const estSeconds = estimateWallClockSeconds(presetId, agentCount, rounds, model);
  let estimateLabel = '';
  if (estSeconds && estSeconds > 0) {
    estimateLabel = `~${formatDurationSeconds(estSeconds)}`;
  } else if (presetId === 'blackboard') {
    estimateLabel = 'autonomous • blackboard';
  } else if (rounds === 0) {
    estimateLabel = 'autonomous';
  }

  // Color estimate based on cap fit (mirrors WallClockEstimate logic) + live suffix
  const capTrimmed = wallClockCapMin.trim();
  const capMinParsed = Number(capTrimmed);
  const capValid = capTrimmed.length > 0 && Number.isFinite(capMinParsed) && capMinParsed > 0;
  const capSec = capValid ? Math.round(capMinParsed * 60) : null;
  let estimateClass = "text-ink-500";
  let fitSuffix = "";
  if (estSeconds && capSec) {
    const ratio = estSeconds / capSec;
    if (ratio > 1.2) {
      estimateClass = "text-rose-300";
      fitSuffix = " (likely to hit cap)";
    } else if (ratio > 0.8) {
      estimateClass = "text-amber-300";
      fitSuffix = " (close to cap)";
    } else {
      estimateClass = "text-emerald-300";
      fitSuffix = " (fits cap)";
    }
  } else if (estimateLabel && estimateLabel.includes("autonomous")) {
    estimateClass = "text-emerald-400/80";
  }

  const capLabel = capValid ? `${wallClockCapMin}m cap` : '';

  return (
    <>
    <div className="h-full overflow-auto flex justify-center items-start px-4 pt-5 pb-4">
      <form
        id="setup-form"
        onSubmit={(e) => {
          e.preventDefault();
          form.performStart();
        }}
        className="w-full max-w-4xl space-y-4"
      >
        <BrainStartChat
          onApplyConfig={(cfg: BrainConfigPatch) => {
            if (cfg.preset) form.setPresetId(cfg.preset);
            if (cfg.model) form.setModel(cfg.model);
            // Apply workspace path from structured Brain recommendation if provided
            // (CONFIG from /brain/chat often includes "parentPath")
            if ((cfg as any).parentPath && typeof (cfg as any).parentPath === 'string') {
              form.setParentPath((cfg as any).parentPath);
            }
            // other fields are synced inside the hook when possible
          }}
          onStartNow={(cfg: BrainConfigPatch) => form.startSwarmDirectlyFromBrain(cfg)}
        />

        {form.recentRuns.length > 0 && (
          <Section title="Recent runs">
            <div className="flex flex-wrap gap-2">
              {form.recentRuns.map((r: any) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => form.refillFromRecent(r)}
                  className="text-left bg-ink-900 hover:bg-ink-700 border border-ink-700 rounded p-2 max-w-[280px] transition-colors text-xs"
                  title={`${r.presetId || 'preset'} • ${r.parentPath}${r.runId ? ` • run ${r.runId}` : ''}`}
                >
                  {r.repoUrl.split("/").pop()} <span className="text-ink-500">· {r.presetId}</span>
                  {r.runId && (
                    <span
                      onClick={(e) => {
                        e.stopPropagation();
                        navigate(`/runs/${encodeURIComponent(r.runId)}`);
                      }}
                      className="ml-1 text-[9px] px-1 bg-ink-700 hover:bg-ink-600 rounded text-ink-400 cursor-pointer"
                      title={`View run ${r.runId}`}
                    >
                      view
                    </span>
                  )}
                </button>
              ))}
            </div>
          </Section>
        )}

        <Section title="Swarm Mode">
          <div className="text-xs text-ink-400 mb-1">Choose the swarm coordination pattern (topology / preset). This sets roles, parallelism, and deliverables.</div>

          {/* Use-case filter, powered by tables in docs/swarm-patterns.md (Recommended Preset Combinations for Research) and STATUS.md preset matrix */}
          <div className="mb-2">
            <div className="flex items-center gap-1 flex-wrap text-[10px]">
              <span className="text-ink-400">Filter by use-case:</span>
              {USE_CASE_OPTIONS.map(opt => {
                const active = useCaseFilters.includes(opt.tag);
                return (
                  <button
                    key={opt.tag}
                    type="button"
                    onClick={() => {
                      setUseCaseFilters(active
                        ? useCaseFilters.filter(t => t !== opt.tag)
                        : [...useCaseFilters, opt.tag]
                      );
                    }}
                    className={`px-1.5 py-px rounded border transition text-[10px] ${active ? "bg-violet-700 border-violet-500 text-white" : "bg-ink-800 border-ink-600 hover:bg-ink-700 text-ink-300"}`}
                    title={`Show presets for ${opt.label} (from research/use-case tables)`}
                  >
                    {opt.label}
                  </button>
                );
              })}
              {useCaseFilters.length > 0 && (
                <button
                  type="button"
                  onClick={() => setUseCaseFilters([])}
                  className="px-1 text-ink-400 hover:text-ink-200"
                  title="Clear use-case filter"
                >
                  clear
                </button>
              )}
              <span className="text-ink-500 ml-1">({filteredPresets.length} shown)</span>
            </div>
          </div>

          <div className="space-y-1">
            {filteredPresets.map((p) => {
              const isActive = p.status === "active";
              const isSelected = form.preset.id === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  disabled={!isActive}
                  onClick={() => form.setPresetId(p.id)}
                  className={`w-full text-left px-3 py-2 rounded border transition ${isSelected ? "border-emerald-500 bg-emerald-900/30" : "border-ink-700 bg-ink-900 hover:bg-ink-800"} ${!isActive ? "opacity-50 cursor-not-allowed" : ""}`}
                  title={p.summary}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-sm">{p.label}</span>
                    <span className="text-[10px] text-ink-500">{p.min}–{p.max} agents (rec {p.recommended})</span>
                  </div>
                  <div className="text-[10px] text-ink-400 mt-0.5 line-clamp-2">{p.summary}</div>
                  {p.useCases && p.useCases.length > 0 && (
                    <div className="text-[9px] text-violet-400 mt-0.5">use: {p.useCases.join(", ")}</div>
                  )}
                </button>
              );
            })}
            {filteredPresets.length === 0 && (
              <div className="text-[10px] text-ink-400 italic px-2">No presets match the selected use-cases. Clear filter to see all.</div>
            )}
          </div>
          <div className="text-[10px] text-ink-500 mt-1">
            Directive handling: {form.preset.directive}. Changing mode resets agent count + topology to the preset's recommended shape (you can tweak after).
          </div>
          <div className="text-[9px] text-ink-500 mt-0.5">Use-case filters based on tables in <code>docs/swarm-patterns.md</code> (research workflows) and <code>STATUS.md</code>.</div>
        </Section>

        <Section title="User Directive">
          <Field
            label="Directive / Goal"
            labelAccessory={<InfoTip>{form.preset.directive === "honored" ? "This preset will use the directive to shape contracts, turns, synthesis, etc." : "This preset may ignore or use the directive in special ways (see preset description)."}</InfoTip>}
          >
            <textarea
              value={form.userDirective}
              onChange={(e) => form.setUserDirective(e.target.value)}
              className="input"
              rows={5}
              placeholder="e.g. Analyze this repo and add support for governmental economic data panels using public APIs. Focus on FX and credit tabs."
            />
          </Field>
          <div className="text-[10px] text-ink-500 mt-1">
            Max ~4000 chars. Leave empty for preset default behavior.
          </div>
        </Section>

        {/* Sections above; sticky action bar lives at the bottom of the form (see below) */}

        <Section title="Repository">
          <div className="grid lg:grid-cols-2 gap-4">
            <Field label="GitHub URL (optional)" labelAccessory={<InfoTip>Leave empty to work directly on the Parent folder below.</InfoTip>}>
              <input
                value={form.repoUrl}
                onChange={(e) => form.setRepoUrl(e.target.value)}
                className="input"
                placeholder="https://github.com/owner/repo"
              />
            </Field>
            <Field label="Project folder (workspace)" labelAccessory={<InfoTip>When GitHub URL is empty, this folder IS the repo.</InfoTip>}>
              <input
                value={form.parentPath}
                placeholder="C:\\Users\\yourname\\workspace\\my-project"
                onChange={(e) => form.setParentPath(e.target.value)}
                className="input font-mono"
              />
            </Field>
          </div>
          <PreflightPreview state={form.preflight.state} error={form.preflight.error} />
        </Section>

        <Section title="Topology">
          <p className="text-xs text-ink-500 mb-2">Per-agent role + model overrides</p>

          <TopologyGrid
            key={form.preset.id}
            preset={{ id: form.preset.id, min: form.preset.min, max: form.preset.max, recommended: form.preset.recommended }}
            topology={form.topology}
            setTopology={form.onTopologyChange}
            defaultModel={form.model}
            provider={form.provider}
          />

          {form.preset.id === "blackboard" && (
            <PlanningPhaseControl
              useHybridPlanning={form.useHybridPlanning}
              setUseHybridPlanning={form.setUseHybridPlanning}
              planningPreset={form.planningPreset}
              setPlanningPreset={form.setPlanningPreset}
              executionPreset={form.executionPreset}
              setExecutionPreset={form.setExecutionPreset}
              webTools={form.webTools}
              setWebTools={form.setWebTools}
              mcpServers={form.mcpServers}
              setMcpServers={form.setMcpServers}
            />
          )}
          {/* Explicit mcpServers surface for research */}
          {form.preset.id === "blackboard" && (
            <div className="mt-2 text-xs">
              <div className="flex items-center gap-1">
                <label className="text-ink-400">MCP Servers (for additional tools like advanced fetch/search):</label>
                <InfoTip>Spawn/connect MCP servers for more tools (e.g. advanced fetch, github, custom gov data). Format: name=command. Free keyless search examples: search=npx -y open-websearch@latest (multi-engine: DDG/Bing/etc, no key). Other free options: pskill9/web-search (build locally) or heventure-search-mcp (Python: uvx heventure-search-mcp). Tools available when "enable web research tools" or research profile is active. Note: native DuckDuckGo web_search is already included when the checkbox is on — no MCP entry needed.</InfoTip>
              </div>
              <input value={form.mcpServers} onChange={e => form.setMcpServers(e.target.value)} className="input text-xs" placeholder="search=npx -y open-websearch@latest fetch=npx -y @modelcontextprotocol/server-fetch" />
              <button
                type="button"
                onClick={() => {
                  const free = "search=npx -y open-websearch@latest";
                  const cur = (form.mcpServers || "").trim();
                  const next = !cur ? free : cur.includes("open-websearch") ? cur : cur + " " + free;
                  form.setMcpServers(next);
                  // also ensure web research is on
                  // (the form may expose setWebTools via other means, but we can hint)
                }}
                className="mt-1 text-[10px] px-2 py-0.5 rounded bg-emerald-900/30 hover:bg-emerald-900/50 text-emerald-300 border border-emerald-700/50 transition"
              >
                + recommended free keyless search (open-websearch)
              </button>
            </div>
          )}

          {/* Full blackboard advanced panels (cap + ambition tiers with warnings) now in Topology */}
          {form.preset.id === "blackboard" && (
            <div className="mt-3 space-y-3 border-t border-ink-700/50 pt-3">
              <BlackboardWallClockCap
                wallClockCapMin={form.wallClockCapMin}
                setWallClockCapMin={form.setWallClockCapMin}
              />
              <BlackboardAmbitionTiers
                ambitionTiers={form.ambitionTiers}
                setAmbitionTiers={form.setAmbitionTiers}
                wallClockCapMin={form.wallClockCapMin}
              />
            </div>
          )}
        </Section>

        <Section title="Run">
          {/* Core run params. For blackboard, full cap/tiers live in Topology (advanced panels). */}
          <div className="grid sm:grid-cols-2 gap-4">
            <Field
              label="Rounds"
              hint="0 = autonomous (until ratchet satisfied or cap hit)"
            >
              <input
                type="number"
                value={form.roundsInput}
                onChange={(e) => form.setRoundsInput(Number(e.target.value))}
                className="input"
                min={0}
                placeholder="0"
              />
            </Field>

            {/* General wall-clock cap shown for non-blackboard; blackboard uses richer full component in Topology */}
            {form.preset?.id !== "blackboard" && (
              <Field
                label="Wall-clock cap (min)"
                hint="0 or empty = server default (8h). Only counts active runtime. Set e.g. 60 for a 1-hour hard limit."
              >
                <input
                  type="number"
                  value={form.wallClockCapMin}
                  onChange={(e) => form.setWallClockCapMin(e.target.value)}
                  className="input font-mono"
                  min={0}
                  max={480}
                  placeholder="0"
                />
              </Field>
            )}
          </div>
        </Section>

        {/* Advanced settings delegated to Topology (for blackboard: full WallClockCap + AmbitionTiers with warnings) and PlanningPhaseControl */}

        {/* Sticky-within-scroll action bar.
            - Sticks to the bottom of the viewport once scrolled past (part of the form flow).
            - Matches ink-800 cards, borders, emerald accents used across the app.
            - Colored estimate + live cap-fit suffix (e.g. " (fits cap)"), richer preflight (commits + path).
            - Ready dot, left accent, hover lift + scale + ring animations when canStart.
            - Preset-aware defaults (more presets) + full Blackboard* panels now in Topology; caps synced to global store. */}
        <div className="sticky bottom-0 z-10 mt-6">
          {/* gentle fade separator from content above */}
          <div className="h-3 bg-gradient-to-t from-ink-900/70 to-transparent" />

          <div className={`bg-ink-800/95 border border-ink-700 rounded-t-2xl shadow-2xl backdrop-blur supports-[backdrop-filter]:bg-ink-800/90 px-5 py-3.5 relative transition-all duration-200 ease-out ${canStart ? 'hover:shadow-[0_25px_50px_-12px_rgb(0,0,0,0.3)] hover:-translate-y-0.5 hover:scale-[1.005] ring-1 ring-emerald-500/10' : ''}`}>
            {/* Different accent style: left vertical emerald bar when enabled (instead of top thin line) + ready dot in label */}
            {canStart && (
              <div className="absolute left-0 top-2 bottom-2 w-1 bg-emerald-500/70 rounded-r-full transition-all duration-300" />
            )}

            <div className="flex items-center justify-between gap-4">
              {/* Left: label + always-visible estimate (colored by cap fit) + cap value + badges */}
              <div className="min-w-0 flex-1 text-sm text-ink-300 flex items-center gap-2.5">
                <span className="font-semibold text-ink-100 tracking-tight flex items-center gap-1.5">
                  Start a swarm
                  {canStart && (
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" title="Ready to start" />
                  )}
                </span>

                {estimateLabel && (
                  <span className={`text-[11px] font-mono transition-colors duration-300 ${estimateClass}`}>{estimateLabel}{fitSuffix}</span>
                )}

                {capLabel && (
                  <span className="text-[10px] px-1.5 py-px rounded bg-amber-900/40 text-amber-300 border border-amber-800/50 font-mono transition-colors duration-300">{capLabel}</span>
                )}
                {form.ambitionTiers && Number(form.ambitionTiers) > 0 && (
                  <span className="text-[10px] px-1.5 py-px rounded bg-violet-900/40 text-violet-300 border border-violet-800/50 font-mono transition-colors duration-300">{form.ambitionTiers} tiers</span>
                )}

                {!form.isActive && (
                  <span className="text-[10px] text-amber-400/80">preset inactive</span>
                )}

                {/* Richer preflight status in bar (uses commits, path hint, etc.) */}
                {form.preflight?.state && (
                  <span
                    className={`text-[10px] px-1.5 py-px rounded border font-mono ${form.preflight.state.alreadyPresent ? "bg-sky-900/50 text-sky-300 border-sky-800/60" : "bg-emerald-900/40 text-emerald-300 border-emerald-800/50"}`}
                    title={form.preflight.state.destPath || ""}
                  >
                    {form.preflight.state.alreadyPresent
                      ? `resume (${form.preflight.state.priorCommits || 0}c)`
                      : "fresh"}
                    {form.preflight.state.destPath ? ` · ${form.preflight.state.destPath.split(/[/\\]/).pop()}` : ""}
                  </span>
                )}
                {form.preflightBlocked && (
                  <span className="text-[10px] text-rose-400">blocked</span>
                )}
              </div>

              {/* Primary CTA — premium feel, consistent emerald, rocket icon, "press Enter" hint */}
              <div className="flex flex-col items-end gap-0.5">
                <button
                  type="submit"
                  form="setup-form"
                  disabled={!canStart}
                  className="inline-flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 hover:scale-[1.02] disabled:bg-ink-700 disabled:text-ink-400 disabled:cursor-not-allowed text-white font-semibold rounded-lg px-7 py-2.5 text-sm shadow-lg transition-all duration-150 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-ink-900 focus:ring-emerald-400/70 whitespace-nowrap"
                  title={form.preflightBlocked ? "Fix the project folder (not a git repo)" : undefined}
                >
                  <span>{form.busy ? "Starting…" : "Start swarm"}</span>
                  {!form.busy && <span aria-hidden className="text-base leading-none">🚀</span>}
                </button>
                <div className="text-[9px] text-ink-500 font-mono pr-1">or press Enter</div>
              </div>
            </div>
          </div>
        </div>
      </form>
    </div>

    <style>{`
      .input {
        width: 100%;
        background: #0b0d10;
        border: 1px solid #2a2f3a;
        border-radius: 6px;
        padding: 8px 10px;
        color: #e5e7eb;
        font-size: 14px;
      }
      .input:focus { outline: none; border-color: #10b981; }
      .input:disabled { opacity: 0.5; cursor: not-allowed; }
    `}</style>
    </>
  );
}
