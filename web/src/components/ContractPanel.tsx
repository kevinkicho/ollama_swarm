import { useSwarm } from "../state/store";
import type { ExitCriterion, ExitCriterionStatus } from "../types";

// Phase 11b: read-only contract view. The planner emits the contract once at
// the top of the run; Phase 11c will flip criterion status to met/wont-do as
// the auditor works. For now every criterion renders as "unmet" and the panel
// is purely informational — drain-exit still terminates the run.
export function ContractPanel() {
  const contract = useSwarm((s) => s.contract);

  if (!contract) {
    return (
      <div className="h-full overflow-auto p-6 text-sm text-ink-400">
        No exit contract has been emitted for this run yet. The planner will
        produce one at the top of the <span className="text-ink-200">planning</span> phase.
      </div>
    );
  }

  const counts = countByStatus(contract.criteria);

  return (
    <div className="h-full overflow-auto p-6 space-y-4">
      <section>
        <div className="text-xs uppercase tracking-wide text-ink-400 mb-1">Mission</div>
        <p className="text-base text-ink-100 leading-snug">{contract.missionStatement}</p>
      </section>

      <section>
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs uppercase tracking-wide text-ink-400">
            Criteria · {contract.criteria.length}
          </div>
          <div className="text-xs text-ink-400 font-mono">
            <span className="text-emerald-300">{counts.met} met</span>
            <span className="mx-1.5 text-ink-600">·</span>
            <span className="text-ink-300">{counts.unmet} unmet</span>
            <span className="mx-1.5 text-ink-600">·</span>
            <span className="text-ink-500">{counts["wont-do"]} wont-do</span>
          </div>
        </div>
        {contract.criteria.length === 0 ? (
          <div className="text-sm text-ink-400 italic">
            Contract has no criteria — the planner found nothing to commit to.
          </div>
        ) : (
          <ul className="space-y-2">
            {contract.criteria.map((crit) => (
              <CriterionRow key={crit.id} criterion={crit} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function CriterionRow({ criterion }: { criterion: ExitCriterion }) {
  return (
    <li className="border border-ink-700 rounded bg-ink-900/40 p-3 space-y-1.5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="text-xs font-mono text-ink-500 shrink-0">{criterion.id}</span>
          <span className="text-sm text-ink-100 leading-snug">{criterion.description}</span>
        </div>
        <StatusBadge status={criterion.status} />
      </div>
      {criterion.expectedFiles.length > 0 ? (
        <div className="flex flex-wrap gap-1.5 pl-8">
          {criterion.expectedFiles.map((f) => (
            <code
              key={f}
              className="text-[11px] font-mono text-ink-300 bg-ink-800 border border-ink-700 rounded px-1.5 py-0.5"
            >
              {f}
            </code>
          ))}
        </div>
      ) : null}
      {criterion.rationale ? (
        <div className="pl-8 text-xs text-ink-400 italic">{criterion.rationale}</div>
      ) : null}
    </li>
  );
}

function StatusBadge({ status }: { status: ExitCriterionStatus }) {
  const config: Record<ExitCriterionStatus, { label: string; cls: string }> = {
    unmet: { label: "unmet", cls: "border-ink-600 text-ink-300" },
    met: { label: "met", cls: "border-emerald-500/50 text-emerald-300" },
    "wont-do": { label: "wont-do", cls: "border-ink-700 text-ink-500" },
  };
  const { label, cls } = config[status];
  return (
    <span className={`shrink-0 text-[11px] font-mono uppercase border rounded px-1.5 py-0.5 ${cls}`}>
      {label}
    </span>
  );
}

function countByStatus(criteria: ExitCriterion[]): Record<ExitCriterionStatus, number> {
  const out: Record<ExitCriterionStatus, number> = { unmet: 0, met: 0, "wont-do": 0 };
  for (const c of criteria) out[c.status]++;
  return out;
}
