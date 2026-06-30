import { useState, useMemo } from "react";
import { useSwarm } from "../state/store";
import { PlannerThinkingPanel } from "./PlannerThinkingPanel";

/**
 * Planning tab: surfaces all planning-related events in a structured view.
 * Separates planning decisions (contract, audit, tiers) from work items (Kanban).
 */
export function PlanningTab() {
  const contract = useSwarm((s) => s.contract);
  const todos = useSwarm((s) => s.todos);
  const findings = useSwarm((s) => s.findings);
  const transcript = useSwarm((s) => s.transcript);

  return (
    <div className="h-full overflow-y-auto space-y-3 p-3">
      <PlannerThinkingPanel />
      <CurrentContractPanel contract={contract} />
      <AuditHistorySection transcript={transcript} />
      <TierHistorySection transcript={transcript} />
      <FindingsSection findings={findings} />
    </div>
  );
}

interface ContractCriterion {
  id: string;
  description: string;
  status: "met" | "wont-do" | "unmet";
  rationale?: string;
  expectedFiles: string[];
}

interface Contract {
  missionStatement: string;
  criteria: ContractCriterion[];
}

function CurrentContractPanel({ contract }: { contract: Contract | undefined }) {
  if (!contract) {
    return (
      <div className="rounded border border-ink-700 bg-ink-800 p-3">
        <div className="text-xs text-ink-400 italic">No contract yet — planning in progress...</div>
      </div>
    );
  }

  const met = contract.criteria.filter((c) => c.status === "met").length;
  const unmet = contract.criteria.filter((c) => c.status === "unmet").length;
  const wontDo = contract.criteria.filter((c) => c.status === "wont-do").length;

  return (
    <div className="rounded border border-ink-700 bg-ink-800 p-3">
      <div className="text-xs text-ink-400 mb-2">
        <span className="font-semibold text-ink-200">Mission:</span> {contract.missionStatement}
      </div>
      <div className="flex gap-3 text-[11px] mb-3">
        <span className="text-emerald-400">✓ {met} met</span>
        <span className="text-amber-400">⏳ {unmet} unmet</span>
        <span className="text-ink-500">— {wontDo} wont-do</span>
      </div>
      <div className="space-y-1">
        {contract.criteria.map((c) => (
          <div
            key={c.id}
            className="flex items-start gap-2 text-[11px] py-1 border-t border-ink-700/50 first:border-t-0"
          >
            <span className="shrink-0">
              {c.status === "met" ? "✓" : c.status === "wont-do" ? "—" : "⏳"}
            </span>
            <span className="text-ink-200 flex-1">{c.description}</span>
            {c.rationale && (
              <span className="text-ink-500 text-[10px] max-w-[200px] truncate" title={c.rationale}>
                {c.rationale}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

interface AuditEntry {
  ts: number;
  text: string;
}

function extractAuditEvents(transcript: Array<{ role: string; text: string; ts: number }>): AuditEntry[] {
  return transcript
    .filter((e) => e.role === "system" && /auditor applied|criterion/i.test(e.text))
    .map((e) => ({ ts: e.ts, text: e.text }));
}

function AuditHistorySection({ transcript }: { transcript: Array<{ role: string; text: string; ts: number }> }) {
  const audits = useMemo(() => extractAuditEvents(transcript), [transcript]);

  return (
    <div className="rounded border border-ink-700 bg-ink-800">
      <div className="px-3 py-2 border-b border-ink-700 text-xs uppercase tracking-wide text-sky-300">
        Audit History ({audits.length})
      </div>
      <div className="max-h-60 overflow-y-auto p-2 space-y-1">
        {audits.length === 0 ? (
          <div className="text-xs text-ink-500 italic">No audits yet</div>
        ) : (
          audits.slice(-10).reverse().map((a, i) => (
            <div key={i} className="text-[11px] text-ink-300 py-1 border-b border-ink-700/50 last:border-b-0">
              <span className="text-ink-500">{new Date(a.ts).toLocaleTimeString()}</span>{" "}
              {a.text.slice(0, 200)}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

interface TierEntry {
  ts: number;
  text: string;
  tier: number;
}

function extractTierEvents(transcript: Array<{ role: string; text: string; ts: number }>): TierEntry[] {
  return transcript
    .filter((e) => e.role === "system" && /Contract \(tier \d+\)/i.test(e.text))
    .map((e) => ({
      ts: e.ts,
      text: e.text,
      tier: parseInt(e.text.match(/tier (\d+)/)?.[1] ?? "0"),
    }));
}

function TierHistorySection({ transcript }: { transcript: Array<{ role: string; text: string; ts: number }> }) {
  const tiers = useMemo(() => extractTierEvents(transcript), [transcript]);

  return (
    <div className="rounded border border-ink-700 bg-ink-800">
      <div className="px-3 py-2 border-b border-ink-700 text-xs uppercase tracking-wide text-violet-300">
        Tier History ({tiers.length})
      </div>
      <div className="max-h-60 overflow-y-auto p-2 space-y-1">
        {tiers.length === 0 ? (
          <div className="text-xs text-ink-500 italic">No tiers yet</div>
        ) : (
          tiers.map((t, i) => (
            <div key={i} className="text-[11px] text-ink-300 py-1 border-b border-ink-700/50 last:border-b-0">
              <span className="text-violet-400 font-semibold">Tier {t.tier}</span>{" "}
              <span className="text-ink-500">{new Date(t.ts).toLocaleTimeString()}</span>{" "}
              {t.text.replace(/Contract \(tier \d+\): /, "").slice(0, 150)}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function FindingsSection({ findings }: { findings: Array<{ id: string; agentId: string; text: string; createdAt: number }> }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded border border-ink-700 bg-ink-800">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-3 py-2 text-xs uppercase tracking-wide text-ink-300 hover:bg-ink-700"
      >
        <span>Findings</span>
        <span className="text-ink-400">
          {findings.length} {open ? "▾" : "▸"}
        </span>
      </button>
      {open ? (
        <div className="max-h-56 overflow-y-auto p-2 space-y-2">
          {findings.length === 0 ? (
            <div className="text-xs text-ink-500 italic p-1">No findings yet.</div>
          ) : (
            findings.map((f) => (
              <div key={f.id} className="rounded border border-ink-700 bg-ink-900 px-2 py-1.5 text-xs">
                <div className="flex items-center gap-2 text-[10px] text-ink-500 mb-0.5">
                  <span>{f.agentId}</span>
                  <span>·</span>
                  <span>{new Date(f.createdAt).toLocaleTimeString()}</span>
                </div>
                <div className="whitespace-pre-wrap text-ink-200">{f.text}</div>
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
