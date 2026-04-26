// Task #46: rich horizontal-rule block rendered in place of the
// plain "— new run started —" system entry. Parses the sentinel
// pipe-encoded text emitted by store.resetForNewRun when it has run
// metadata. Falls back to a minimal divider if parsing fails.
export function RunStartDivider({ text, ts }: { text: string; ts: number }) {
  const parsed = parseRunStartDividerText(text);
  const dateStr = new Date(ts).toLocaleString();
  const runIdShort = parsed.runId ? parsed.runId.slice(0, 8) : null;
  return (
    <div className="my-3" role="separator">
      <div className="flex items-center gap-2">
        <div className="flex-1 h-px bg-ink-700" />
        <div className="text-[10px] uppercase tracking-wider text-ink-500 font-semibold shrink-0">
          New run
        </div>
        <div className="flex-1 h-px bg-ink-700" />
      </div>
      <div className="mt-2 text-xs text-ink-300 font-mono text-center">
        <div>
          {runIdShort ? (
            <span className="text-ink-100 font-semibold">{runIdShort}</span>
          ) : null}
          {runIdShort ? <span className="text-ink-600 mx-2">·</span> : null}
          <span className="text-ink-400">{dateStr}</span>
        </div>
        {parsed.preset || parsed.plannerModel || parsed.workerModel || parsed.agentCount ? (
          <div className="mt-0.5 text-ink-400">
            {parsed.preset ? <span>{parsed.preset}</span> : null}
            {parsed.preset && (parsed.plannerModel || parsed.workerModel) ? (
              <span className="text-ink-600 mx-2">·</span>
            ) : null}
            {parsed.plannerModel === parsed.workerModel && parsed.plannerModel ? (
              <span>{parsed.plannerModel}</span>
            ) : (
              <>
                {parsed.plannerModel ? <span>planner {parsed.plannerModel}</span> : null}
                {parsed.plannerModel && parsed.workerModel ? (
                  <span className="text-ink-600 mx-2">·</span>
                ) : null}
                {parsed.workerModel ? <span>worker {parsed.workerModel}</span> : null}
              </>
            )}
            {parsed.agentCount ? (
              <>
                <span className="text-ink-600 mx-2">·</span>
                <span>{parsed.agentCount} agents</span>
              </>
            ) : null}
          </div>
        ) : null}
        {parsed.repoUrl ? (
          <div className="mt-0.5 text-ink-500 truncate">{parsed.repoUrl}</div>
        ) : null}
      </div>
    </div>
  );
}

function parseRunStartDividerText(text: string): {
  runId?: string;
  preset?: string;
  plannerModel?: string;
  workerModel?: string;
  agentCount?: number;
  repoUrl?: string;
} {
  // Format: "▸▸RUN-START▸▸|runId=<uuid>|preset=<preset>|plannerModel=...|..."
  if (!text.startsWith("▸▸RUN-START▸▸")) return {};
  const segments = text.split("|").slice(1);
  const out: Record<string, string> = {};
  for (const seg of segments) {
    const eq = seg.indexOf("=");
    if (eq < 0) continue;
    out[seg.slice(0, eq)] = seg.slice(eq + 1);
  }
  const agentCountNum = out.agentCount ? Number(out.agentCount) : undefined;
  return {
    runId: out.runId || undefined,
    preset: out.preset || undefined,
    plannerModel: out.plannerModel || undefined,
    workerModel: out.workerModel || undefined,
    agentCount: agentCountNum && Number.isFinite(agentCountNum) ? agentCountNum : undefined,
    repoUrl: out.repoUrl || undefined,
  };
}
