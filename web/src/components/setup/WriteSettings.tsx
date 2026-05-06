import { useState } from "react";

export type WriteMode = "none" | "single" | "multi";
export type ConflictPolicy = "merge" | "sequential" | "vote" | "judge" | "pick";

const WRITE_MODE_OPTIONS: { value: WriteMode; label: string; hint: string }[] = [
  {
    value: "none",
    label: "None (discussion only)",
    hint: "No file modifications. Agents discuss and produce a summary.",
  },
  {
    value: "single",
    label: "Single writer",
    hint: "One synthesizer agent produces all file edits. Simpler, faster for small changes.",
  },
  {
    value: "multi",
    label: "Multi-writer",
    hint: "Multiple agents propose edits. Conflicts resolved via the selected policy.",
  },
];

const CONFLICT_POLICY_OPTIONS: { value: ConflictPolicy; label: string; hint: string }[] = [
  {
    value: "merge",
    label: "Auto-merge",
    hint: "Combine non-overlapping hunks. Fail if conflicts detected. Best for isolated changes.",
  },
  {
    value: "sequential",
    label: "Sequential (CAS)",
    hint: "Apply in order; fail if file changed since read. Orchestrator-worker style.",
  },
  {
    value: "vote",
    label: "Vote",
    hint: "Agents vote on conflicting hunks. Majority wins. Council / round-robin style.",
  },
  {
    value: "judge",
    label: "Judge picks",
    hint: "Judge agent decides between conflicting proposals. Debate-judge style.",
  },
  {
    value: "pick",
    label: "Pick best",
    hint: "Lead agent picks the best proposal. MoA aggregator style.",
  },
];

const DEFAULT_POLICIES: Record<string, ConflictPolicy> = {
  council: "vote",
  "round-robin": "vote",
  "role-diff": "vote",
  "map-reduce": "merge",
  "orchestrator-worker": "sequential",
  "orchestrator-worker-deep": "sequential",
  "debate-judge": "judge",
  moa: "pick",
};

export function getDefaultConflictPolicy(presetId: string): ConflictPolicy {
  return DEFAULT_POLICIES[presetId] ?? "merge";
}

export function WriteModeSelector({
  presetId,
  writeMode,
  setWriteMode,
  conflictPolicy,
  setConflictPolicy,
}: {
  presetId: string;
  writeMode: WriteMode;
  setWriteMode: (m: WriteMode) => void;
  conflictPolicy: ConflictPolicy;
  setConflictPolicy: (p: ConflictPolicy) => void;
}) {
  const showConflictPolicy = writeMode === "multi";
  const defaultPolicy = getDefaultConflictPolicy(presetId);

  return (
    <div className="space-y-2">
      <div className="text-ink-400 text-[11px] uppercase tracking-wider mb-1.5">
        Write mode
      </div>
      <div className="space-y-1.5">
        {WRITE_MODE_OPTIONS.map((opt) => (
          <label
            key={opt.value}
            className={`flex items-start gap-2 p-2 rounded border ${
              writeMode === opt.value
                ? "border-emerald-600 bg-emerald-900/20"
                : "border-ink-700 bg-ink-900/40 hover:border-ink-600"
            } cursor-pointer transition`}
          >
            <input
              type="radio"
              name="writeMode"
              value={opt.value}
              checked={writeMode === opt.value}
              onChange={() => {
                setWriteMode(opt.value);
                if (opt.value === "multi" && conflictPolicy === "merge") {
                  setConflictPolicy(defaultPolicy);
                }
              }}
              className="mt-0.5"
            />
            <div className="flex-1">
              <div className="text-ink-200 font-medium">{opt.label}</div>
              <div className="text-ink-500 text-[11px] mt-0.5">{opt.hint}</div>
            </div>
          </label>
        ))}
      </div>

      {showConflictPolicy ? (
        <div className="mt-3">
          <div className="text-ink-400 text-[11px] uppercase tracking-wider mb-1.5">
            Conflict resolution policy
          </div>
          <div className="space-y-1.5">
            {CONFLICT_POLICY_OPTIONS.map((opt) => (
              <label
                key={opt.value}
                className={`flex items-start gap-2 p-2 rounded border ${
                  conflictPolicy === opt.value
                    ? "border-emerald-600 bg-emerald-900/20"
                    : "border-ink-700 bg-ink-900/40 hover:border-ink-600"
                } cursor-pointer transition`}
              >
                <input
                  type="radio"
                  name="conflictPolicy"
                  value={opt.value}
                  checked={conflictPolicy === opt.value}
                  onChange={() => setConflictPolicy(opt.value)}
                  className="mt-0.5"
                />
                <div className="flex-1">
                  <div className="text-ink-200 font-medium">{opt.label}</div>
                  <div className="text-ink-500 text-[11px] mt-0.5">{opt.hint}</div>
                </div>
              </label>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}