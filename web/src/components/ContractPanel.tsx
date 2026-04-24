import { useEffect, useState } from "react";
import { useSwarm } from "../state/store";
import type { ExitCriterion, ExitCriterionStatus } from "../types";

// Unit 53: filter values include `all` plus the three real statuses.
// Default is `unmet` — once the auditor has resolved several criteria,
// `met` rows become noise the user no longer needs to scan.
type StatusFilter = "all" | ExitCriterionStatus;
const DEFAULT_FILTER: StatusFilter = "unmet";
// localStorage key — chosen to be globally namespaced so two browser
// tabs against different repos don't collide. Per-run scoping (per
// Unit 53 spec idea) would also work but is overkill for a UI
// preference; `unmet` as the default already does the heavy lifting.
const FILTER_STORAGE_KEY = "ollama-swarm.contract-filter";

function loadStoredFilter(): StatusFilter {
  if (typeof window === "undefined") return DEFAULT_FILTER;
  try {
    const raw = window.localStorage.getItem(FILTER_STORAGE_KEY);
    if (raw === "all" || raw === "met" || raw === "unmet" || raw === "wont-do") return raw;
  } catch {
    // localStorage might be unavailable (private mode etc.) — fall through.
  }
  return DEFAULT_FILTER;
}

function persistFilter(value: StatusFilter): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(FILTER_STORAGE_KEY, value);
  } catch {
    // best-effort; not worth surfacing in the UI
  }
}

// Phase 11b: read-only contract view. The planner emits the contract once at
// the top of the run; Phase 11c will flip criterion status to met/wont-do as
// the auditor works. Unit 53 adds an All/Unmet/Met/Wont-do filter row so
// resolved criteria don't dominate the view mid-run.
export function ContractPanel() {
  const contract = useSwarm((s) => s.contract);
  const [filter, setFilterState] = useState<StatusFilter>(() => loadStoredFilter());
  // Persist on change. Effect (not inline in setFilter) keeps the
  // setter pure and matches React's expected ordering.
  useEffect(() => {
    persistFilter(filter);
  }, [filter]);
  const setFilter = (next: StatusFilter) => setFilterState(next);

  if (!contract) {
    return (
      <div className="h-full overflow-auto p-6 text-sm text-ink-400">
        No exit contract has been emitted for this run yet. The planner will
        produce one at the top of the <span className="text-ink-200">planning</span> phase.
      </div>
    );
  }

  const counts = countByStatus(contract.criteria);
  const filtered =
    filter === "all"
      ? contract.criteria
      : contract.criteria.filter((c) => c.status === filter);

  return (
    <div className="h-full overflow-auto p-6 space-y-4">
      <section>
        <div className="text-xs uppercase tracking-wide text-ink-400 mb-1">Mission</div>
        <p className="text-base text-ink-100 leading-snug">{contract.missionStatement}</p>
      </section>

      <section>
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs uppercase tracking-wide text-ink-400">
            Criteria · {filtered.length}
            {filter !== "all" && contract.criteria.length !== filtered.length ? (
              <span className="text-ink-500"> of {contract.criteria.length}</span>
            ) : null}
          </div>
          {/* Unit 56b: dropped the labels-only "X met · Y unmet · Z wont-do"
              row that used to live here — the FilterTabs below already shows
              each count on its button AND provides the filter affordance. */}
        </div>

        <FilterTabs filter={filter} setFilter={setFilter} counts={counts} total={contract.criteria.length} />

        {contract.criteria.length === 0 ? (
          <div className="text-sm text-ink-400 italic">
            Contract has no criteria — the planner found nothing to commit to.
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-sm text-ink-400 italic">
            No criteria match the “{filterLabel(filter)}” filter. Try{" "}
            <button
              onClick={() => setFilter("all")}
              className="text-emerald-300 underline hover:text-emerald-200"
            >
              All
            </button>
            .
          </div>
        ) : (
          <ul className="space-y-2">
            {filtered.map((crit) => (
              <CriterionRow key={crit.id} criterion={crit} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function filterLabel(f: StatusFilter): string {
  return f === "all" ? "All" : f === "wont-do" ? "Wont-do" : f.charAt(0).toUpperCase() + f.slice(1);
}

interface FilterTabsProps {
  filter: StatusFilter;
  setFilter: (f: StatusFilter) => void;
  counts: Record<ExitCriterionStatus, number>;
  total: number;
}
function FilterTabs({ filter, setFilter, counts, total }: FilterTabsProps) {
  // Order: All first, then most-actionable (unmet) → resolved (met) → surrendered (wont-do).
  const tabs: Array<{ key: StatusFilter; label: string; count: number }> = [
    { key: "all", label: "All", count: total },
    { key: "unmet", label: "Unmet", count: counts.unmet },
    { key: "met", label: "Met", count: counts.met },
    { key: "wont-do", label: "Wont-do", count: counts["wont-do"] },
  ];
  return (
    <div className="flex gap-1 mb-3">
      {tabs.map((t) => {
        const active = filter === t.key;
        return (
          <button
            key={t.key}
            onClick={() => setFilter(t.key)}
            className={
              "text-xs font-mono px-2.5 py-1 rounded border transition " +
              (active
                ? "border-emerald-500 bg-emerald-500/10 text-emerald-200"
                : "border-ink-700 text-ink-400 hover:border-ink-600 hover:text-ink-200")
            }
          >
            {t.label} <span className="text-ink-500">{t.count}</span>
          </button>
        );
      })}
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
