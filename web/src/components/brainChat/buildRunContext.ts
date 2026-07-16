import { formatServerSummary } from "../../../../shared/src/formatServerSummary";
import type { RunBrainContext } from "./types";

// Offloaded to Web Worker via getChatContext / buildRunContextAsync for perf (heavy slicing/summary).
// Fallback sync version for worker-unavailable cases. Full worker path used for during-run Brain context.
export function buildRunContext(runId: string, storeState: any, boardState?: any): RunBrainContext {
  const transcript = storeState.transcript || [];
  const recent = transcript.slice(-8).map((e: any) => {
    const summaryText = e.summary ? formatServerSummary(e.summary) : e.text?.slice(0, 150) || '';
    return {
      role: e.role,
      text: summaryText,
      summaryKind: e.summary?.kind,
      summary: e.summary,
    };
  });

  const cfg = storeState.runConfig || {};
  const agents = storeState.agents || {};
  const activeCount = Object.values(agents).filter((a: any) => a.status !== 'done').length;

  let contextStr = JSON.stringify({ recentTranscript: recent, boardCounts: boardState?.counts, recentTodos: boardState?.todos?.slice(0,3) });
  if (contextStr.length > 1500) {
    recent.splice(0, Math.max(0, recent.length - 4));
    contextStr = JSON.stringify({ recentTranscript: recent, boardCounts: boardState?.counts });
  }

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

  return {
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
    recentTodos: boardState?.todos?.slice(0, 3).map((t: any) => ({
      id: t.id,
      description: t.description,
      status: t.status,
    })),
    agentCount: cfg.agentCount,
    activeAgents: activeCount,
    wallClockMs: storeState.startedAt ? Date.now() - storeState.startedAt : undefined,
    deliberation: deliberation.length ? deliberation : undefined,
  };
}

let contextWorker: Worker | null = null;
function getContextWorker() {
  if (!contextWorker) {
    try {
      contextWorker = new Worker(new URL('../../workers/buildContext.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      contextWorker = null;
    }
  }
  return contextWorker;
}

export async function buildRunContextAsync(runId: string, storeState: any, boardState?: any): Promise<RunBrainContext> {
  const worker = getContextWorker();
  if (!worker) {
    return buildRunContext(runId, storeState, boardState);
  }
  return new Promise((resolve) => {
    const handler = (e: MessageEvent) => {
      worker.removeEventListener('message', handler);
      resolve(e.data);
    };
    worker.addEventListener('message', handler);
    worker.postMessage({ runId, storeState, boardState });
  });
}

// Full worker-powered getChatContext (preferred for heavy context builds in Brain/FAB during live runs).
export const getChatContext = buildRunContextAsync;
