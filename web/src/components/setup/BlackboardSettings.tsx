import { useState } from "react";
import { Field, ToggleField } from "./SharedFields";
import { ModelInput } from "./ModelInput";

// Tri-state for the blackboard council-contract knob.
// "" = inherit server default (COUNCIL_CONTRACT_ENABLED env var).
// "on" = force on for this run. "off" = force off for this run.
export type CouncilContractPref = "" | "on" | "off";

// Blackboard role defaults. Maps each role to its tier from the
// MODEL_REASONING / MODEL_CODING / MODEL_VERIFIER framework above.
// Pre-populated as initial state for the matching SetupForm inputs;
// users can clear to fall through to the main Model field.
export const BLACKBOARD_DEFAULT_PLANNER_MODEL = "nemotron-3-super:cloud";
export const BLACKBOARD_DEFAULT_WORKER_MODEL = "gemma4:31b-cloud";
export const BLACKBOARD_DEFAULT_AUDITOR_MODEL = "nemotron-3-super:cloud";

export function BlackboardHelp() {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded border border-ink-700 bg-ink-900/60 text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2 text-ink-300 hover:text-ink-100"
      >
        <span>How the blackboard preset coordinates work</span>
        <span className="text-ink-500">{open ? "▾" : "▸"}</span>
      </button>
      {open ? (
        <div className="px-3 pb-3 space-y-1.5 text-ink-400 leading-snug">
          <p>
            <span className="text-ink-200">One planner, N−1 workers.</span> The planner posts atomic
            todos (≤2 files each) with <code className="font-mono text-ink-300">expectedFiles</code>.
            Workers claim a todo, record SHA hashes of the files they plan to touch, then return a
            full-file diff.
          </p>
          <p>
            <span className="text-ink-200">Optimistic CAS at commit.</span> Before the runner writes
            the diff, it re-hashes every claimed file. If any hash changed under the worker (another
            worker committed first), the commit is rejected and the todo is marked{" "}
            <span className="text-rose-300">stale</span>.
          </p>
          <p>
            <span className="text-ink-200">Stale → replan.</span> The planner re-reads the current
            code and rewrites the stale todo; the <span className="text-amber-300">R1/R2…</span>{" "}
            badge on a card counts how many times it's been replanned before another worker can
            reclaim it.
          </p>
          <p>
            <span className="text-ink-200">Hard caps bound every run.</span> 8 hours wall-clock,
            200 commits, or 300 total todos — whichever fires first stops the loop and writes{" "}
            <code className="font-mono text-ink-300">summary.json</code> at the clone root. Unit 27
            compensates for laptop-sleep so a multi-hour suspension doesn't silently burn the cap.
          </p>
        </div>
      ) : null}
    </div>
  );
}

export function BlackboardModelOverrides({
  plannerModel,
  setPlannerModel,
  workerModel,
  setWorkerModel,
  fallbackModel,
}: {
  plannerModel: string;
  setPlannerModel: (m: string) => void;
  workerModel: string;
  setWorkerModel: (m: string) => void;
  fallbackModel: string;
}) {
  return (
    <div className="space-y-2">
      <Field
        label="Planner model override (Unit 42)"
        hint={
          plannerModel.trim().length === 0
            ? `Empty → uses the main Model field (${fallbackModel}). Planner-hosted critic / replanner / auditor sessions inherit this too. Recommended for blackboard: ${BLACKBOARD_DEFAULT_PLANNER_MODEL}.`
            : `Planner + critic + replanner + auditor will run on ${plannerModel.trim()}.`
        }
      >
        <ModelInput
          value={plannerModel}
          onChange={(v) => setPlannerModel(v.slice(0, 200))}
          placeholder={`(blackboard recommended: ${BLACKBOARD_DEFAULT_PLANNER_MODEL})`}
          ariaLabel="Planner model override"
        />
      </Field>
      <Field
        label="Worker model override (Unit 42)"
        hint={
          workerModel.trim().length === 0
            ? `Empty → uses the main Model field (${fallbackModel}). All worker agents (indices 2..N) share this model. Recommended for blackboard: ${BLACKBOARD_DEFAULT_WORKER_MODEL} (fast, code-shaped).`
            : `All worker agents will run on ${workerModel.trim()}.`
        }
      >
        <ModelInput
          value={workerModel}
          onChange={(v) => setWorkerModel(v.slice(0, 200))}
          placeholder={`(blackboard recommended: ${BLACKBOARD_DEFAULT_WORKER_MODEL})`}
          ariaLabel="Worker model override"
        />
      </Field>
    </div>
  );
}

export function BlackboardWallClockCap({
  wallClockCapMin,
  setWallClockCapMin,
}: {
  wallClockCapMin: string;
  setWallClockCapMin: (s: string) => void;
}) {
  const trimmed = wallClockCapMin.trim();
  const parsed = Number(trimmed);
  const isValid = trimmed.length === 0 || (Number.isFinite(parsed) && parsed >= 1 && parsed <= 480);
  return (
    <Field
      label="Wall-clock cap minutes (Unit 43)"
      hint={
        trimmed.length === 0
          ? "Empty → uses the 8-hour baked-in default. Enter a number 1–480 to cap THIS run only."
          : isValid
            ? `Run will stop after ~${parsed} min of active wall-clock time (host-sleep is still clamped per Unit 27).`
            : "Out of range — enter a number between 1 and 480, or leave empty for the 8 h default."
      }
    >
      <input
        value={wallClockCapMin}
        onChange={(e) => setWallClockCapMin(e.target.value)}
        placeholder="(default: 480)"
        className={`input font-mono ${!isValid ? "border-rose-500" : ""}`}
        inputMode="numeric"
      />
    </Field>
  );
}

// Unit 63a: ambition-tier cap input. Empty = inherit env default
// (today: off). The soft warning fires when tiers > 0 AND the
// wall-clock cap is short enough that a second tier almost
// certainly won't have time to make meaningful progress.
export function BlackboardAmbitionTiers({
  ambitionTiers,
  setAmbitionTiers,
  wallClockCapMin,
}: {
  ambitionTiers: string;
  setAmbitionTiers: (s: string) => void;
  wallClockCapMin: string;
}) {
  const trimmed = ambitionTiers.trim();
  const parsed = Number(trimmed);
  const isValid =
    trimmed.length === 0 ||
    (Number.isInteger(parsed) && parsed >= 0 && parsed <= 20);
  const capTrimmed = wallClockCapMin.trim();
  const capParsed = Number(capTrimmed);
  const capIsShort =
    capTrimmed.length > 0 &&
    Number.isFinite(capParsed) &&
    capParsed < 60;
  const showShortCapWarning =
    isValid && trimmed.length > 0 && parsed > 0 && capIsShort;
  return (
    <Field
      label="Ambition tier cap (Unit 34)"
      hint={
        trimmed.length === 0
          ? "Empty → inherits AMBITION_RATCHET_ENABLED env (today's default off). 0 = stop on first 'all met'. 1–20 = climb that many tiers; each tier asks the planner for a more ambitious next contract once the current one is satisfied."
          : isValid
            ? parsed === 0
              ? "Disabled — runner stops on first 'all met'."
              : `Will climb up to ${parsed} tier${parsed === 1 ? "" : "s"} (re-asks the planner for a harder next contract on each all-met).`
            : "Out of range — enter an integer between 0 and 20, or leave empty to inherit the env default."
      }
    >
      <input
        value={ambitionTiers}
        onChange={(e) => setAmbitionTiers(e.target.value)}
        placeholder="(default: env)"
        className={`input font-mono ${!isValid ? "border-rose-500" : ""}`}
        inputMode="numeric"
      />
      {showShortCapWarning ? (
        <div className="text-xs text-amber-300 mt-1">
          Tier-climb usually needs &gt;1 hr to make a meaningful second
          tier — your wall-clock cap of {capParsed} min may stop the run
          before the climb fires.
        </div>
      ) : null}
    </Field>
  );
}

// Unit 63 follow-on: Units 58 (dedicated auditor + auditor model),
// 59 (specialized workers), and 60 (critic ensemble) all shipped
// server-side but had no UI exposure. Grouped here as "agent
// topology" because each one changes how many specialized roles
// the run spawns or how many lanes a critic verdict takes.
export function BlackboardAgentTopology({
  dedicatedAuditor,
  setDedicatedAuditor,
  auditorModel,
  setAuditorModel,
  specializedWorkers,
  setSpecializedWorkers,
  criticEnsemble,
  setCriticEnsemble,
  fallbackModel,
}: {
  dedicatedAuditor: boolean;
  setDedicatedAuditor: (v: boolean) => void;
  auditorModel: string;
  setAuditorModel: (s: string) => void;
  specializedWorkers: boolean;
  setSpecializedWorkers: (v: boolean) => void;
  criticEnsemble: boolean;
  setCriticEnsemble: (v: boolean) => void;
  fallbackModel: string;
}) {
  return (
    <div className="space-y-2">
      <ToggleField
        label="Dedicated auditor agent (Unit 58)"
        checked={dedicatedAuditor}
        onChange={setDedicatedAuditor}
        hint="Off: planner doubles as auditor (1 less process). On: spawn a separate agent at index N+1 that ONLY runs audit prompts. Frees the planner to focus on todo authorship; useful for multi-hour runs where audit + planning compete for the same session context."
      />
      <Field
        label="Auditor model override (Unit 58)"
        hint={
          !dedicatedAuditor
            ? `Only used when 'Dedicated auditor agent' is enabled above. Recommended for blackboard: ${BLACKBOARD_DEFAULT_AUDITOR_MODEL} (heavier verifier-style model).`
            : auditorModel.trim().length === 0
              ? `Empty → falls back to the planner model (or main Model: ${fallbackModel}). Recommended for blackboard: ${BLACKBOARD_DEFAULT_AUDITOR_MODEL}.`
              : `Auditor agent will run on ${auditorModel.trim()}.`
        }
      >
        <ModelInput
          value={auditorModel}
          onChange={(v) => setAuditorModel(v.slice(0, 200))}
          placeholder={`(blackboard recommended: ${BLACKBOARD_DEFAULT_AUDITOR_MODEL})`}
          ariaLabel="Auditor model override"
          className={`input font-mono ${!dedicatedAuditor ? "opacity-50 pointer-events-none" : ""}`}
        />
      </Field>
      <ToggleField
        label="Specialized workers (Unit 59)"
        checked={specializedWorkers}
        onChange={setSpecializedWorkers}
        hint="Off: all workers share one prompt. On: assign each worker a role (correctness / simplicity / consistency) so identical model weights produce distinct priors when claiming the same todo class. Keeps blackboard topology, no extra processes."
      />
      <ToggleField
        label="Critic ensemble (Unit 60)"
        checked={criticEnsemble}
        onChange={setCriticEnsemble}
        hint="Off: one critic verdict per commit (substance lane only). On: three parallel verdicts (substance / regression / consistency); reject if ANY lane rejects. Catches more busywork at the cost of 3× critic prompts per commit."
      />
    </div>
  );
}

// Unit 63 follow-on: Unit 36's outside-world UI URL. Server-side
// MCP_PLAYWRIGHT_ENABLED=true is also required for the swarm-ui
// agent to actually capture; the hint surfaces this so users don't
// silently get file-only audits when they expected a snapshot.
export function BlackboardUiUrl({
  uiUrl,
  setUiUrl,
}: {
  uiUrl: string;
  setUiUrl: (s: string) => void;
}) {
  const trimmed = uiUrl.trim();
  let isValid = trimmed.length === 0;
  if (!isValid) {
    try {
      // eslint-disable-next-line no-new
      new URL(trimmed);
      isValid = true;
    } catch {
      isValid = false;
    }
  }
  return (
    <Field
      label="Live app URL for outside-world auditor (Unit 36)"
      hint={
        trimmed.length === 0
          ? "Optional. When set, the auditor's swarm-ui agent navigates here and captures the live page accessibility tree as primary evidence for user-visible criteria. Requires MCP_PLAYWRIGHT_ENABLED=true server-side AND `npm install -g @playwright/mcp` on the box. Without those the audit silently falls back to file-only evaluation."
          : isValid
            ? `Auditor will browser_navigate to ${trimmed} on each audit invocation.`
            : "Not a valid URL — must include scheme (e.g. http://localhost:3000)."
      }
    >
      <input
        value={uiUrl}
        onChange={(e) => setUiUrl(e.target.value.slice(0, 2000))}
        placeholder="http://localhost:3000"
        className={`input font-mono ${!isValid ? "border-rose-500" : ""}`}
        inputMode="url"
      />
    </Field>
  );
}

export function BlackboardAdvanced({
  pref,
  setPref,
}: {
  pref: CouncilContractPref;
  setPref: (p: CouncilContractPref) => void;
}) {
  return (
    <Field
      label="Council-style contract draft (Unit 30)"
      hint="Blackboard only. When enabled, all N agents independently draft a first-pass contract at turn 0, then the planner merges them into one. Inherit = use the COUNCIL_CONTRACT_ENABLED env var."
    >
      <select
        value={pref}
        onChange={(e) => setPref(e.target.value as CouncilContractPref)}
        className="input"
      >
        <option value="">Inherit from server default (env flag)</option>
        <option value="on">Enable for this run</option>
        <option value="off">Disable for this run</option>
      </select>
    </Field>
  );
}
