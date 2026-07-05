import { useState, useEffect, useRef } from "react";
import { useSwarm } from "../state/store";
import { formatServerSummary } from "../../../shared/src/formatServerSummary";
import { PRESETS_GUIDE } from "../../../shared/src/presetGuide";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export type BrainConfigPatch = Record<string, unknown> & {
  preset?: string;
  model?: string;
};

// Context shape for during-run Brain assistance.
// Kept compact to avoid token bloat; use summaries.
export interface RunBrainContext {
  runId: string;
  preset?: string;
  userDirective?: string;
  phase?: string;
  // Summarized recent transcript (use formatServerSummary or similar)
  recentTranscript?: Array<{
    role: string;
    text: string;
    summaryKind?: string;
    summary?: any;
  }>;
  // For blackboard: key board info
  boardCounts?: any;
  recentTodos?: Array<{ id: string; description: string; status: string }>;
  agentCount?: number;
  // Additional metadata
  activeAgents?: number;
  wallClockMs?: number;
}

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

  return {
    runId,
    preset: cfg.preset,
    userDirective: cfg.userDirective,
    phase: storeState.phase,
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
  };
}

let contextWorker: Worker | null = null;
function getContextWorker() {
  if (!contextWorker) {
    try {
      contextWorker = new Worker(new URL('../workers/buildContext.worker.ts', import.meta.url), { type: 'module' });
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

export function BrainStartChat({ 
  onApplyConfig, 
  onStartNow,
  runContext,
}: { 
  onApplyConfig: (cfg: BrainConfigPatch) => void; 
  onStartNow?: (cfg: BrainConfigPatch) => void;
  runContext?: RunBrainContext;
}) {
  const isDuringRun = !!runContext;
  const initialMsg = isDuringRun 
    ? `Hi! I'm Brain assisting your active run ${runContext.runId?.slice(0,8)}. Current phase: ${runContext.phase || 'unknown'}. Ask me about progress, suggest amendments, analyze state, or help with research findings.`
    : "Hi! I'm Brain, the swarm librarian. Describe your goal or use-case (you don't need to know the 'swarm mode'). Example: 'I want to analyze lots of research papers on superconductors and synthesize the common properties' or 'I need to safely add new data panels to my finance app using public gov endpoints'. I'll analyze it, recommend the best preset + explain why with supporting reasons, and give you the exact config + start command.";

  // Persist history per-run using the per-run store (falls back to local state)
  const storeHistory = useSwarm((s: any) => (runContext ? s.brainChatHistory : undefined));
  const setStoreHistory = useSwarm((s: any) => (runContext ? s.setBrainChatHistory : undefined));
  const setUseCaseFilters = useSwarm((s: any) => s.setUseCaseFilters);

  const [localMessages, setLocalMessages] = useState<ChatMessage[]>([
    { role: "assistant", content: initialMsg },
  ]);

  // Dedicated structured toggle for agents/UI power users
  const [useStructured, setUseStructured] = useState(true);

  // Suggested filters from interactive table (for chips)
  const [suggestedFilters, setSuggestedFilters] = useState<string[]>([]);

  const rawMessages = runContext && storeHistory && storeHistory.length > 0 ? storeHistory : localMessages;
  // Light dedupe of consecutive identical messages (defensive for old persisted history or edge re-sends)
  const messages = rawMessages.reduce((acc: ChatMessage[], m: ChatMessage, idx: number) => {
    const prev = acc[acc.length - 1];
    if (!prev || prev.role !== m.role || prev.content !== m.content) acc.push(m);
    return acc;
  }, [] as ChatMessage[]);
  const setMessages = (newMsgs: ChatMessage[]) => {
    if (runContext && setStoreHistory) {
      setStoreHistory(newMsgs);
      // Persist to server for disk snapshot
      if (runContext.runId) {
        fetch('/api/swarm/brain/chat-history', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ runId: runContext.runId, history: newMsgs }),
        }).catch(() => {});
      }
    } else {
      setLocalMessages(newMsgs);
    }
  };

  // On mount for run, seed with initial if no history (use setMessages to avoid dup append paths)
  useEffect(() => {
    if (runContext && (!storeHistory || storeHistory.length === 0)) {
      setMessages([{ role: "assistant", content: initialMsg }]);
    }
  }, [runContext]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [lastConfig, setLastConfig] = useState<BrainConfigPatch | null>(null);
  const [starting, setStarting] = useState(false);
  const [suggestedAmend, setSuggestedAmend] = useState<string | null>(null);

  // Sticky bottom scroll for chat
  const chatScrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = chatScrollRef.current;
    if (el) {
      // instant to bottom on new messages (prevents fighting user scroll)
      el.scrollTop = el.scrollHeight;
    }
  }, [messages.length, loading]);

  const extractConfig = (text: string): BrainConfigPatch | null => {
    // Prefer fenced json, then first balanced object (mirrors shared extractor).
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    let candidate = fence ? fence[1] : text;
    // find first balanced
    let depth = 0, start = -1;
    for (let i = 0; i < candidate.length; i++) {
      const c = candidate[i];
      if (c === '{') { if (depth === 0) start = i; depth++; }
      else if (c === '}') { depth--; if (depth === 0 && start !== -1) { candidate = candidate.slice(start, i+1); break; } }
    }
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && (parsed.preset || parsed.parentPath)) return parsed;
    } catch {}
    return null;
  };

  const isAffirmative = (text: string): boolean => {
    return /\b(yes|yep|yeah|sure|go|start|launch|do it|please|confirm|ready|ok|okay)\b/i.test(text);
  };

  const send = async () => {
    if (!input.trim() || loading) return;
    const userMsg: ChatMessage = { role: "user", content: input.trim() };
    // Build list from current messages (avoids relying on selector during updates)
    const baseForSend = [...messages, userMsg];
    setMessages(baseForSend);
    setInput("");
    setLoading(true);

    const userWantsToStart = lastConfig && isAffirmative(userMsg.content);

    // Fast path: if user just said "yes/start" and we already have a config, start immediately
    // without an extra roundtrip (the LLM response can still come for UX).
    if (userWantsToStart && onStartNow && lastConfig) {
      setStarting(true);
      onStartNow(lastConfig);
      setTimeout(() => setStarting(false), 4000);
    }

    try {
      const body: any = { messages: baseForSend };
      if (runContext) body.runContext = runContext;
      // Pass clonePath when available so Brain can ground recommendations in actual outcome history
      const currentClone = (window as any).__currentClonePath || null;
      if (currentClone) body.clonePath = currentClone;

      // Use the toggle for structured (clean rec + config)
      body.structured = useStructured || !runContext; // default on for setup

      const userMsgText = input.trim().toLowerCase();
      const userWantsOptionsTable = /explain (all )?options|show (me )?(all )?options|compare (all )?(presets|options)|which preset|what mode|best preset|preset options|table of presets|all presets for|recommend.*preset|options for my goal/i.test(userMsgText);

      const res = await fetch("/api/swarm/brain/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();

      // Start with user + (possible) assistant reply. Build final list here to avoid stale closures + duplicate appends.
      let finalList = [...baseForSend];
      if (data.reply) {
        const assistantMsg: ChatMessage = { role: "assistant", content: data.reply };
        finalList = [...finalList, assistantMsg];

        // Prefer structured data when available (much cleaner for agents + UI).
        let cfg = data.structured?.config || extractConfig(data.reply);
        if (cfg) {
          setLastConfig(cfg);
          onApplyConfig(cfg);
        }

        // Surface recommendation from structured or text (append directly to finalList, set once).
        const rec = data.structured?.recommendation;
        if (rec && !isDuringRun) {
          const rationaleMsg: ChatMessage = {
            role: "assistant",
            content: `🧠 **Brain recommends: ${rec.preset}** (confidence ${(rec.confidence * 100).toFixed(0)}%)\n\n${rec.rationale || 'See details above.'}`
          };
          finalList = [...finalList, rationaleMsg];
        } else if (!rec) {
          // Fallback text-based surface for users who don't know which swarm mode to pick.
          const recMatch = data.reply.match(/(?:Recommended Preset|Best preset|I recommend|recommend .*preset)\s*[:\-]?\s*([a-zA-Z0-9\-_]+)/i);
          if (recMatch && !isDuringRun) {
            const whyPart = data.reply.match(/(?:because|Why|rationale|supporting|analysis)[:\-]?\s*([^\n]{20,200})/i);
            const analysis = whyPart ? whyPart[1].trim() : "See the full reply for the detailed supporting analysis based on your described use-case.";
            const rationaleMsg: ChatMessage = {
              role: "assistant",
              content: `🧠 **Preset recommendation: ${recMatch[1]}**\n\nWhy this fits your use-case: ${analysis}`
            };
            finalList = [...finalList, rationaleMsg];
          }
        }

        // Parse for amend action e.g. "amend: fix the foo bar by..."
        const amendMatch = data.reply.match(/amend:\s*(.+?)(?:\n|$)/i);
        if (amendMatch) {
          setSuggestedAmend(amendMatch[1].trim());
        }

        // Always surface a small table when user asked to "explain options"
        const shouldShowTable = (userWantsOptionsTable || /explain (all )?options|options table|compare presets|which preset|preset options/i.test(data.reply)) && !isDuringRun;
        if (shouldShowTable) {
          // Auto-apply relevant filters to the Swarm Mode card (live update via shared store)
          const goalText = (input || data.reply || '').toLowerCase();
          const autoTags: string[] = [];
          if (goalText.includes('research') || goalText.includes('paper') || goalText.includes('literature') || goalText.includes('scan')) autoTags.push('research', 'literature-scan');
          if (goalText.includes('analysis') || goalText.includes('debate') || goalText.includes('hypothesis')) autoTags.push('analysis');
          if (goalText.includes('code') || goalText.includes('edit') || goalText.includes('write') || goalText.includes('implement')) autoTags.push('code-writing');
          if (goalText.includes('synthesis') || goalText.includes('synthesize') || goalText.includes('aggregate')) autoTags.push('synthesis');
          if (goalText.includes('explore') || goalText.includes('discovery')) autoTags.push('exploration');
          if (goalText.includes('hierarch') || goalText.includes('decompos')) autoTags.push('hierarchical');
          if (goalText.includes('multi') || goalText.includes('pipeline') || goalText.includes('stage')) autoTags.push('multi-stage');
          if (autoTags.length > 0) {
            setUseCaseFilters([...new Set(autoTags)]);
            setSuggestedFilters([...new Set(autoTags)]);
          }

          const tableRows = Object.values(PRESETS_GUIDE)
            .map(p => `• ${p.label}: ${p.strengths.substring(0, 70)}... (best for: ${p.bestFor.join(', ')})`)
            .join('\n');
          const tableMsg: ChatMessage = {
            role: "assistant",
            content: `📋 **Preset Options Table for your goal**:\n${tableRows}\n\n(Strongest matches based on bestFor tags. The Swarm Mode card filters have been updated live above/below.)`
          };
          finalList = [...finalList, tableMsg];
        }

        // If assistant signals launch after we had a config
        const assistantWantsStart = cfg && /launching|starting now|begin|swarm is being launched/i.test(data.reply);
        if ((userWantsToStart || assistantWantsStart) && onStartNow) {
          const toStart = cfg || lastConfig;
          if (toStart) onStartNow(toStart);
        }
      }

      // Single set for the whole response batch. For during-run this replaces via setStoreHistory (no extra appends).
      setMessages(finalList);
    } catch (e) {
      const errList = [...baseForSend, { role: "assistant" as const, content: "Sorry, brain chat failed. Check if server is running." }];
      setMessages(errList);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-ink-800 border border-violet-700/60 rounded-xl p-4 shadow-2xl mb-4">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-violet-400 text-lg">🧠</span>
          <span className="font-semibold text-lg">Talk to Brain</span>
          <span className="text-xs text-ink-500">(natural language → swarm start)</span>
        </div>
        <span className="text-[10px] text-violet-400">JSON configs are auto-applied to the form below</span>
      </div>

      <div ref={chatScrollRef} className="h-72 overflow-y-auto bg-ink-900 border border-ink-700 rounded p-3 text-sm space-y-2 mb-3 custom-scroll">
        {messages.map((m: ChatMessage, i: number) => (
          <div key={i} className={m.role === "user" ? "text-right" : ""}>
            <div className={`inline-block max-w-[85%] rounded-xl px-3 py-1.5 text-ink-100 ${m.role === "user" ? "bg-emerald-900/40" : "bg-ink-800"}`}>
              <div className="text-xs text-ink-400 mb-0.5">{m.role}</div>
              <div className="whitespace-pre-wrap">{m.content}</div>
            </div>
          </div>
        ))}
        {loading && <div className="text-ink-400 text-xs">Brain is thinking…</div>}
        {starting && <div className="text-emerald-400 text-xs">Starting the swarm via Brain…</div>}
        {suggestedAmend && (
          <div className="mt-2 p-2 bg-amber-900/30 border border-amber-700 rounded text-xs">
            Suggested amend: <span className="font-mono">{suggestedAmend}</span>
            <button
              type="button"
              onClick={async () => {
                // Call /amend for current run (assume runId from context or prop)
                if (runContext?.runId) {
                  try {
                    await fetch(`/api/swarm/amend`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ runId: runContext.runId, text: suggestedAmend }),
                    });
                    alert('Amend sent!');
                    setSuggestedAmend(null);
                  } catch (e) {
                    alert('Amend failed: ' + (e as Error).message);
                  }
                }
              }}
              className="ml-2 px-2 py-0.5 bg-amber-600 rounded text-[10px]"
            >
              Apply Amend
            </button>
            <button type="button" onClick={() => setSuggestedAmend(null)} className="ml-1 text-ink-400">dismiss</button>
          </div>
        )}
      </div>

      {/* Interactive chips from Brain table - click to filter Swarm Mode live */}
      {suggestedFilters.length > 0 && (
        <div className="mt-1 mb-1 text-[10px] flex items-center gap-1 flex-wrap">
          <span className="text-ink-400">Filter Swarm Mode live:</span>
          {suggestedFilters.map(tag => (
            <button
              type="button"
              key={tag}
              onClick={() => {
                const current = useSwarm.getState().useCaseFilters || [];
                const next = current.includes(tag) ? current.filter(t => t !== tag) : [...current, tag];
                setUseCaseFilters(next);
              }}
              className="px-1.5 py-0.5 bg-violet-700 hover:bg-violet-600 rounded text-white text-[10px] border border-violet-500"
            >
              {tag}
            </button>
          ))}
          <button type="button" onClick={() => { setUseCaseFilters([]); setSuggestedFilters([]); }} className="text-ink-400 hover:text-white text-[10px]">clear</button>
        </div>
      )}

      <div className="flex gap-2">
        <textarea
          className="flex-1 bg-ink-900 border border-ink-700 rounded px-3 py-2.5 text-sm text-ink-100 placeholder:text-ink-500 focus:outline-none focus:border-violet-600 resize-y min-h-[60px] max-h-40"
          placeholder="e.g. blackboard on C:\\Users\\...\\kyahoofinance , directive: add panels using gov + existing endpoints..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          disabled={loading}
          rows={3}
        />
        <button
          type="button"
          onClick={send}
          disabled={loading || !input.trim()}
          className="px-4 py-2 rounded bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-sm font-medium self-end"
        >
          Send
        </button>

        {/* Even more discreet structured toggle: tiny icon-only badge, right-aligned, very low visual weight */}
        <button
          type="button"
          onClick={() => setUseStructured(!useStructured)}
          className="px-1 py-px text-[8px] leading-none rounded border self-end opacity-50 hover:opacity-90 transition font-mono tabular-nums shrink-0"
          style={{ borderColor: 'var(--ink-700, #333)', color: useStructured ? '#4ade80' : '#64748b' }}
          title="Toggle structured JSON (clean rec + config objects). Click for discreet power-user mode."
        >
          {useStructured ? 'S' : 's'}
        </button>

        {runContext && (
          /* More discreet "Brain Suggest" — small icon, low visual weight, not competing with Send */
          <button
            type="button"
            onClick={async () => {
              const title = 'Proactive suggestion from chat';
              const text = 'Consider checking current todos for issues or amending the directive based on recent activity.';
              try {
                await fetch('/api/swarm/brain/suggest', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ runId: runContext.runId, title, text, category: 'recommendation' }),
                });
                const suggestion: ChatMessage = { role: 'assistant', content: `[🧠 Brain Suggestion] ${title}\n${text}` };
                const updated = [...messages, suggestion];
                setMessages(updated);
              } catch (e) {
                const suggestion: ChatMessage = { role: 'assistant', content: `[🧠 Brain Suggestion] ${title}\n${text}` };
                const updated = [...messages, suggestion];
                setMessages(updated);
              }
            }}
            className="px-1.5 py-1 text-base rounded bg-amber-900/40 hover:bg-amber-800/60 text-amber-300 self-end border border-amber-800/50 opacity-60 hover:opacity-100 transition"
            title="Brain suggest: ask for proactive focus/amend (discreet)"
            disabled={loading}
          >
            💡
          </button>
        )}
      </div>

      {lastConfig && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => {
              if (onStartNow) {
                setStarting(true);
                onStartNow(lastConfig);
                setTimeout(() => setStarting(false), 4000);
              }
            }}
            disabled={loading || starting}
            className="w-full py-2 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-sm font-semibold flex items-center justify-center gap-2"
          >
            {starting ? "🚀 Launching swarm..." : "🚀 Yes — Start this swarm now"}
          </button>
          <div className="text-[10px] text-center text-ink-500 mt-1">Or just type "yes", "start", "go" and hit Send</div>
        </div>
      )}

      <div className="text-[10px] text-ink-500 mt-1">Brain will help you craft the perfect start config. When a config is ready, use the green button or say "yes".</div>
    </div>
  );
}
