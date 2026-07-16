// Web Worker to offload buildRunContext / summary work from main thread.
// Receives { transcript, ... } and returns the processed RunBrainContext.

self.onmessage = (e: MessageEvent) => {
  const { runId, storeState, boardState } = e.data;

  const transcript = storeState.transcript || [];
  let recent = transcript.slice(-8).map((entry: any) => {
    // Try to use a lightweight summary; fall back to text slice.
    // (full formatServerSummary may require bundling; keep compact for worker)
    const summaryText = entry.summary ? (JSON.stringify(entry.summary).slice(0, 120) || entry.text?.slice(0, 150) || '') : (entry.text || '').slice(0, 150);
    return {
      role: entry.role,
      text: summaryText,
      summaryKind: entry.summary?.kind,
      summary: entry.summary,
    };
  });

  // Match main buildRunContext capping logic for "full" parity in worker
  let contextStr = JSON.stringify({ recentTranscript: recent, boardCounts: boardState?.counts, recentTodos: boardState?.todos?.slice(0,3) });
  if (contextStr.length > 1500) {
    recent.splice(0, Math.max(0, recent.length - 4));
  }

  const cfg = storeState.runConfig || {};
  const agents = storeState.agents || {};
  const activeCount = Object.values(agents).filter((a: any) => a.status !== 'done').length;

  const deliberation = (storeState.deliberation || [])
    .slice(-12)
    .map((d: any) => ({
      ts: d.ts,
      layer: d.layer,
      verdict: d.verdict,
      subject: d.subject,
      claim: d.claim,
      validationReason: d.validationReason,
      proposer: d.proposer,
      validator: d.validator,
    }));

  const context = {
    runId,
    preset: cfg.preset,
    userDirective: cfg.userDirective,
    phase: storeState.phase,
    clonePath: cfg.clonePath || cfg.localPath,
    plannerModel: cfg.plannerModel,
    workerModel: cfg.workerModel,
    auditorModel: cfg.auditorModel,
    recentTranscript: recent,
    boardCounts: boardState?.counts,
    recentTodos: (boardState?.todos || []).slice(0, 3).map((t: any) => ({
      id: t.id,
      description: t.description,
      status: t.status,
    })),
    agentCount: cfg.agentCount,
    activeAgents: activeCount,
    wallClockMs: storeState.startedAt ? Date.now() - storeState.startedAt : undefined,
    deliberation: deliberation.length ? deliberation : undefined,
  };

  // @ts-ignore
  self.postMessage(context);
};