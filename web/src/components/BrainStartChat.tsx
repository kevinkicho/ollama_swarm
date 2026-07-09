import { useState, useEffect, useRef } from "react";
import { useSwarm } from "../state/store";
import { formatServerSummary } from "../../../shared/src/formatServerSummary";
import { PRESETS_GUIDE } from "../../../shared/src/presetGuide";
import { renderBrainChatMarkdown } from "../lib/brainChatMarkdown";
import { InfoTip } from "./setup/InfoTip";
import { FormattedTipContent } from "./setup/FormattedTipContent";
import { useSystemLayerModel } from "../hooks/useSystemLayerModel";

const BRAIN_TIP_MAX_WIDTH = 520;
const BRAIN_TIP_SHOW_DELAY_MS = 400;

const SETUP_AUTO_APPLY_TIP = {
  title: "Configs auto-apply below",
  items: [
    "Brain recommends a preset and explains why it fits your goal.",
    "Workspace path, directive, model, and agent count fill into the setup form.",
    "Edit any field before starting — nothing launches until you confirm.",
    'Say "yes", "start", or "go", or use Start this swarm when ready.',
  ],
};

const SETUP_CHAT_TIP = {
  title: "Chat history",
  items: [
    "Conversation with Brain, your swarm librarian for starting runs.",
    "Describe your goal in plain English — no need to know preset names.",
    "Brain can compare presets, explain options, and answer follow-ups.",
    "Your messages and Brain's replies stay in this thread.",
  ],
};

const SETUP_INPUT_TIP = {
  title: "Message box",
  items: [
    "Include your project folder path and what you want the swarm to do.",
    "Example: blackboard on C:\\…\\myapp — directive: add panels from gov APIs.",
    'Try "compare presets" or "explain options" for a recommendation table.',
    "Enter sends · Shift+Enter adds a new line.",
  ],
};

const SETUP_SEND_TIP = {
  title: "Send",
  items: [
    "Sends your message to Brain and waits for a reply.",
    "Brain may update the setup form below when it has a concrete recommendation.",
    "Disabled while Brain is thinking or if the message is empty.",
  ],
};

const RUN_CHAT_TIP = {
  title: "Run chat",
  items: [
    "Ask about live progress, todos, agents, or recent transcript activity.",
    "Brain has a snapshot of this run (phase, board, recent events).",
    "Replies use Markdown; history is saved for this run.",
  ],
};

const RUN_INPUT_TIP = {
  title: "Message box",
  items: [
    "Ask status questions or suggest changes to the run.",
    'Examples: "what failed?", "extend wall-clock cap 15 min", "amend directive to …"',
    "Enter sends · Shift+Enter adds a new line.",
  ],
};

type RunReconfigPatch = {
  rounds?: number;
  wallClockCapMs?: number;
  wallClockCapMin?: number;
  tokenBudget?: number;
  extendRounds?: number;
  extendWallClockCapMin?: number;
  extendTokenBudget?: number;
  thinkGuardRefereeEnabled?: boolean;
  thinkGuardRefereeMaxCallsPerRun?: number;
  thinkGuardRefereeMinThinkChars?: number;
  thinkGuardRefereeThinkTailMinChars?: number;
  thinkGuardRefereeThinkTailMaxChars?: number;
  thinkGuardRefereeMaxOutputTokens?: number;
};

const RUN_SEND_TIP = {
  title: "Send",
  items: [
    "Sends your message to Brain for this run.",
    "Disabled while Brain is thinking or if the message is empty.",
  ],
};

const RUN_SUGGEST_TIP = {
  title: "Suggest",
  items: [
    "Asks Brain for a proactive recommendation based on live run context.",
    "Brain replies in this chat thread with concrete next steps or amendments.",
    "Also injects a summary into the live transcript for agents to consider.",
  ],
};

const PROACTIVE_SUGGEST_PROMPT =
  "Give me a proactive suggestion for this run based on the current phase, todos, and recent transcript. What should I focus on or amend next?";

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
  clonePath?: string;
  plannerModel?: string;
  workerModel?: string;
  auditorModel?: string;
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
  const { model: systemLayerModel } = useSystemLayerModel();
  const isDuringRun = !!runContext;
  const initialMsg = isDuringRun
    ? `**Run ${runContext.runId?.slice(0, 8)}** · ${runContext.preset ?? "swarm"} · phase **${runContext.phase || "unknown"}**\n\nI have the live run snapshot (transcript, agents, board). Ask about progress, todos, or what agents are doing — I can also explore the workspace read-only when tools are available.`
    : "Hi! I'm Brain, the swarm librarian. Describe your goal or use-case (you don't need to know the 'swarm mode'). Example: 'I want to analyze lots of research papers on superconductors and synthesize the common properties' or 'I need to add OAuth login and session handling to my Node API'. I'll analyze it, recommend the best preset + explain why with supporting reasons, and give you the exact config + start command.";

  // Persist history per-run using the per-run store (falls back to local state)
  const storeHistory = useSwarm((s: any) => (runContext ? s.brainChatHistory : undefined));
  const setStoreHistory = useSwarm((s: any) => (runContext ? s.setBrainChatHistory : undefined));
  const setUseCaseFilters = useSwarm((s: any) => s.setUseCaseFilters);

  const [localMessages, setLocalMessages] = useState<ChatMessage[]>([
    { role: "assistant", content: initialMsg },
  ]);

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
  const [suggesting, setSuggesting] = useState(false);
  const [lastConfig, setLastConfig] = useState<BrainConfigPatch | null>(null);
  const [starting, setStarting] = useState(false);
  const [suggestedAmend, setSuggestedAmend] = useState<string | null>(null);
  const [suggestedReconfig, setSuggestedReconfig] = useState<RunReconfigPatch | null>(null);

  // Sticky bottom scroll for chat
  const chatScrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = chatScrollRef.current;
    if (el) {
      // instant to bottom on new messages (prevents fighting user scroll)
      el.scrollTop = el.scrollHeight;
    }
  }, [messages.length, loading]);

  const extractLabeledJson = (text: string, label: string): unknown => {
    const re = new RegExp(`${label}:\\s*({[\\s\\S]*?})(?=\\n[A-Z_]+:|$)`, "i");
    const m = text.match(re);
    if (!m) return null;
    try {
      return JSON.parse(m[1]);
    } catch {
      return null;
    }
  };

  const extractReconfig = (text: string): RunReconfigPatch | null => {
    const parsed = extractLabeledJson(text, "RECONFIG") as RunReconfigPatch | null;
    if (parsed && typeof parsed === "object") return parsed;
    return null;
  };

  const formatReconfigLabel = (patch: RunReconfigPatch): string => {
    const parts: string[] = [];
    if (patch.extendWallClockCapMin != null) parts.push(`+${patch.extendWallClockCapMin}m cap`);
    if (patch.extendRounds != null) parts.push(`+${patch.extendRounds} rounds`);
    if (patch.extendTokenBudget != null) parts.push(`+${patch.extendTokenBudget.toLocaleString()} tokens`);
    if (patch.wallClockCapMin != null) parts.push(`cap → ${patch.wallClockCapMin}m`);
    if (patch.rounds != null) parts.push(`rounds → ${patch.rounds}`);
    if (patch.tokenBudget != null) parts.push(`budget → ${patch.tokenBudget.toLocaleString()}`);
    if (patch.thinkGuardRefereeEnabled != null) {
      parts.push(`referee ${patch.thinkGuardRefereeEnabled ? "on" : "off"}`);
    }
    if (patch.thinkGuardRefereeMaxCallsPerRun != null) {
      parts.push(`referee calls → ${patch.thinkGuardRefereeMaxCallsPerRun}`);
    }
    if (patch.thinkGuardRefereeMinThinkChars != null) {
      parts.push(`referee min think → ${patch.thinkGuardRefereeMinThinkChars.toLocaleString()}`);
    }
    if (patch.thinkGuardRefereeThinkTailMinChars != null || patch.thinkGuardRefereeThinkTailMaxChars != null) {
      const min = patch.thinkGuardRefereeThinkTailMinChars;
      const max = patch.thinkGuardRefereeThinkTailMaxChars;
      if (min != null && max != null) parts.push(`referee tail ${min.toLocaleString()}–${max.toLocaleString()}`);
      else if (min != null) parts.push(`referee tail min → ${min.toLocaleString()}`);
      else if (max != null) parts.push(`referee tail max → ${max!.toLocaleString()}`);
    }
    if (patch.thinkGuardRefereeMaxOutputTokens != null) {
      parts.push(`referee max out → ${patch.thinkGuardRefereeMaxOutputTokens} tok`);
    }
    return parts.join(", ") || "limits";
  };

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

  const sendMessage = async (rawText: string) => {
    const trimmed = rawText.trim();
    if (!trimmed || loading) return;
    const userMsg: ChatMessage = { role: "user", content: trimmed };
    // Read latest history from store when during-run to avoid stale closure on Suggest etc.
    const currentMessages =
      runContext && setStoreHistory && useSwarm.getState().brainChatHistory.length > 0
        ? useSwarm.getState().brainChatHistory
        : runContext && storeHistory && storeHistory.length > 0
          ? storeHistory
          : messages;
    const baseForSend = [...currentMessages, userMsg];
    setMessages(baseForSend);
    if (trimmed === input.trim()) setInput("");
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
      const body: any = { messages: baseForSend, model: systemLayerModel };
      if (runContext) {
        body.runContext = {
          ...runContext,
          clonePath: runContext.clonePath || (window as any).__currentClonePath || undefined,
        };
      }
      const currentClone =
        runContext?.clonePath || (window as any).__currentClonePath || null;
      if (currentClone) body.clonePath = currentClone;

      const userMsgText = trimmed.toLowerCase();
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

        if (isDuringRun) {
          const reconfig = (data.structured?.reconfig as RunReconfigPatch | null) || extractReconfig(data.reply);
          if (reconfig && Object.keys(reconfig).length > 0) {
            setSuggestedReconfig(reconfig);
          }
        }

        // Always surface a small table when user asked to "explain options"
        const shouldShowTable = (userWantsOptionsTable || /explain (all )?options|options table|compare presets|which preset|preset options/i.test(data.reply)) && !isDuringRun;
        if (shouldShowTable) {
          // Auto-apply relevant filters to the Swarm Mode card (live update via shared store)
          const goalText = (trimmed || data.reply || '').toLowerCase();
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

  const send = () => sendMessage(input);

  const requestProactiveSuggestion = async () => {
    if (!runContext || loading || suggesting) return;
    setSuggesting(true);
    try {
      await sendMessage(PROACTIVE_SUGGEST_PROMPT);
      // Mirror transcript-header suggest: inject a system entry agents can see.
      if (runContext.runId) {
        const res = await fetch("/api/swarm/brain/suggest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            runId: runContext.runId,
            title: "Proactive suggestion from Brain chat",
            text: "Brain was asked for a proactive recommendation — see the Brain chat thread and consider any concrete amend or focus area.",
            category: "recommendation",
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          const errMsg: ChatMessage = {
            role: "assistant",
            content: `Could not inject transcript suggestion (${(err as { error?: string }).error ?? res.status}). The Brain reply above is still available in this chat.`,
          };
          const latest = runContext && setStoreHistory
            ? useSwarm.getState().brainChatHistory
            : localMessages;
          setMessages([...latest, errMsg]);
        }
      }
    } catch {
      const errMsg: ChatMessage = {
        role: "assistant",
        content: "Sorry, the proactive suggestion request failed. Check that the server is running.",
      };
      const latest = runContext && setStoreHistory
        ? useSwarm.getState().brainChatHistory
        : localMessages;
      setMessages([...latest, errMsg]);
    } finally {
      setSuggesting(false);
    }
  };

  const chipBtn =
    "text-[10px] px-1.5 py-0.5 rounded border border-ink-600 text-ink-300 hover:text-ink-100 hover:border-ink-500 disabled:opacity-40 shrink-0";

  return (
    <div
      className={
        isDuringRun
          ? "flex flex-col h-full min-h-0 overflow-hidden gap-2"
          : "bg-ink-800 border border-violet-700/60 rounded-xl p-4 shadow-2xl mb-4"
      }
    >
      {!isDuringRun && (
        <div className="flex items-center justify-between gap-2 mb-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-violet-400 text-lg">🧠</span>
            <span className="font-semibold text-lg text-ink-100">Talk to Brain</span>
            <span className="text-xs text-ink-500 truncate">(natural language → swarm start)</span>
          </div>
          <InfoTip
            maxWidth={BRAIN_TIP_MAX_WIDTH}
            preferNoWrap
            showDelayMs={BRAIN_TIP_SHOW_DELAY_MS}
            trigger={
              <span className="text-[10px] text-violet-400 shrink-0 cursor-help">
                configs auto-apply below
              </span>
            }
          >
            <FormattedTipContent
              title={SETUP_AUTO_APPLY_TIP.title}
              items={SETUP_AUTO_APPLY_TIP.items}
              noWrapItems
            />
          </InfoTip>
        </div>
      )}
      <div
        className={`text-[10px] text-ink-500 font-mono truncate min-w-0 ${isDuringRun ? "shrink-0" : "mb-2"}`}
        title={`System model: ${systemLayerModel} — change in sidebar System Status`}
      >
        Model: {systemLayerModel}
      </div>

      <InfoTip
        maxWidth={BRAIN_TIP_MAX_WIDTH}
        preferNoWrap
        showDelayMs={BRAIN_TIP_SHOW_DELAY_MS}
        wrapperClassName={isDuringRun ? "flex flex-1 min-h-0 flex-col" : "block mb-3"}
        trigger={
          <div
            ref={chatScrollRef}
            className={
              isDuringRun
                ? "flex-1 min-h-0 overflow-y-auto space-y-1.5 text-xs custom-scroll cursor-help"
                : "h-72 overflow-y-auto bg-ink-900 border border-ink-700 rounded p-3 text-sm space-y-2 custom-scroll cursor-help"
            }
          >
        {messages.map((m: ChatMessage, i: number) => (
          <div
            key={i}
            className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={
                isDuringRun
                  ? `max-w-[92%] rounded px-2 py-1 whitespace-pre-wrap ${
                      m.role === "user"
                        ? "bg-ink-700/80 text-ink-100"
                        : "text-ink-300"
                    }`
                  : `inline-block max-w-[85%] rounded-lg px-3 py-1.5 text-ink-100 ${
                      m.role === "user" ? "bg-emerald-900/40" : "bg-ink-800"
                    }`
              }
            >
              {!isDuringRun && (
                <div className="text-[10px] text-ink-400 mb-0.5">{m.role}</div>
              )}
              <div className={isDuringRun && m.role === "assistant" ? "" : "whitespace-pre-wrap"}>
                {isDuringRun && m.role === "assistant"
                  ? renderBrainChatMarkdown(m.content)
                  : m.content}
              </div>
            </div>
          </div>
        ))}
        {loading && (
          <div className="text-[10px] text-ink-500">
            {isDuringRun ? "Thinking…" : "Brain is thinking…"}
          </div>
        )}
        {!isDuringRun && starting && (
          <div className="text-emerald-400 text-xs">Starting the swarm via Brain…</div>
        )}
        {suggestedAmend && (
          <div
            className={
              isDuringRun
                ? "text-[10px] px-2 py-1 bg-amber-900/20 border border-amber-800/40 rounded flex items-center gap-1 flex-wrap"
                : "mt-2 p-2 bg-amber-900/30 border border-amber-700 rounded text-xs"
            }
          >
            <span className="text-ink-400">Amend:</span>
            <span className="font-mono text-ink-200">{suggestedAmend}</span>
            <button
              type="button"
              onClick={async () => {
                if (runContext?.runId) {
                  try {
                    await fetch(`/api/swarm/amend`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ runId: runContext.runId, text: suggestedAmend }),
                    });
                    alert("Amend sent!");
                    setSuggestedAmend(null);
                  } catch (e) {
                    alert("Amend failed: " + (e as Error).message);
                  }
                }
              }}
              className={chipBtn}
            >
              Apply
            </button>
            <button
              type="button"
              onClick={() => setSuggestedAmend(null)}
              className="text-[10px] text-ink-500 hover:text-ink-300"
            >
              dismiss
            </button>
          </div>
        )}
        {suggestedReconfig && isDuringRun && (
          <div className="text-[10px] px-2 py-1 bg-sky-900/20 border border-sky-800/40 rounded flex items-center gap-1 flex-wrap">
            <span className="text-ink-400">Limits:</span>
            <span className="font-mono text-ink-200">{formatReconfigLabel(suggestedReconfig)}</span>
            <button
              type="button"
              onClick={async () => {
                if (!runContext?.runId) return;
                try {
                  const res = await fetch(`/api/swarm/reconfig`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ runId: runContext.runId, ...suggestedReconfig }),
                  });
                  const body = await res.json().catch(() => ({}));
                  if (!res.ok) throw new Error(body.error ?? res.statusText);
                  alert(body.message ?? "Limits updated");
                  setSuggestedReconfig(null);
                } catch (e) {
                  alert("Reconfig failed: " + (e as Error).message);
                }
              }}
              className={chipBtn}
            >
              Apply
            </button>
            <button
              type="button"
              onClick={() => setSuggestedReconfig(null)}
              className="text-[10px] text-ink-500 hover:text-ink-300"
            >
              dismiss
            </button>
          </div>
        )}
          </div>
        }
      >
        <FormattedTipContent
          title={isDuringRun ? RUN_CHAT_TIP.title : SETUP_CHAT_TIP.title}
          items={isDuringRun ? RUN_CHAT_TIP.items : SETUP_CHAT_TIP.items}
          noWrapItems
        />
      </InfoTip>

      {!isDuringRun && suggestedFilters.length > 0 && (
        <div className="mb-2 text-[10px] flex items-center gap-1 flex-wrap">
          <span className="text-ink-400">Filter Swarm Mode:</span>
          {suggestedFilters.map((tag) => (
            <button
              type="button"
              key={tag}
              onClick={() => {
                const current = useSwarm.getState().useCaseFilters || [];
                const next = current.includes(tag)
                  ? current.filter((t) => t !== tag)
                  : [...current, tag];
                setUseCaseFilters(next);
              }}
              className={
                isDuringRun
                  ? "px-1.5 py-0.5 rounded border border-ink-600 text-ink-300 hover:text-ink-100 text-[10px]"
                  : "px-1.5 py-0.5 bg-violet-700 hover:bg-violet-600 rounded text-white text-[10px] border border-violet-500"
              }
            >
              {tag}
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              setUseCaseFilters([]);
              setSuggestedFilters([]);
            }}
            className={
              isDuringRun
                ? "text-ink-500 hover:text-ink-300 text-[10px]"
                : "text-ink-400 hover:text-white text-[10px]"
            }
          >
            clear
          </button>
        </div>
      )}

      <div className={`flex items-stretch gap-1.5 shrink-0 ${isDuringRun ? "" : "gap-2"}`}>
          <InfoTip
            maxWidth={BRAIN_TIP_MAX_WIDTH}
            preferNoWrap
            showDelayMs={BRAIN_TIP_SHOW_DELAY_MS}
            wrapperClassName="flex-1 min-w-0 flex"
            trigger={
              <textarea
                className={
                  isDuringRun
                    ? "w-full bg-ink-900/50 border border-ink-700 rounded px-2 py-1.5 text-xs text-ink-100 placeholder:text-ink-500 focus:outline-none focus:border-ink-500 resize-none min-h-[40px] max-h-24 cursor-help"
                    : "w-full bg-ink-900 border border-ink-700 rounded px-3 py-2.5 text-sm text-ink-100 placeholder:text-ink-500 focus:outline-none focus:border-violet-600 resize-y min-h-[60px] max-h-40 cursor-help"
                }
                placeholder={
                  isDuringRun
                    ? "Ask about progress, suggest changes, or request analysis…"
                    : "e.g. blackboard on C:\\Users\\...\\my-project , directive: add retry logic to the API client and update README..."
                }
                aria-label={isDuringRun ? "Message Brain about this run" : "Message Brain to configure a swarm"}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                disabled={loading}
                rows={isDuringRun ? 2 : 3}
              />
            }
          >
            <FormattedTipContent
              title={isDuringRun ? RUN_INPUT_TIP.title : SETUP_INPUT_TIP.title}
              items={isDuringRun ? RUN_INPUT_TIP.items : SETUP_INPUT_TIP.items}
              noWrapItems
            />
          </InfoTip>
          <InfoTip
            maxWidth={BRAIN_TIP_MAX_WIDTH}
            preferNoWrap
            showDelayMs={BRAIN_TIP_SHOW_DELAY_MS}
            trigger={
              <button
                type="button"
                onClick={send}
                disabled={loading || !input.trim()}
                className={
                  isDuringRun
                    ? `${chipBtn} h-full flex items-center justify-center`
                    : "h-full px-4 rounded bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-sm font-medium flex items-center justify-center"
                }
              >
                Send
              </button>
            }
          >
            <FormattedTipContent
              title={isDuringRun ? RUN_SEND_TIP.title : SETUP_SEND_TIP.title}
              items={isDuringRun ? RUN_SEND_TIP.items : SETUP_SEND_TIP.items}
              noWrapItems
            />
          </InfoTip>
        {runContext && (
          <InfoTip
            maxWidth={BRAIN_TIP_MAX_WIDTH}
            preferNoWrap
            showDelayMs={BRAIN_TIP_SHOW_DELAY_MS}
            trigger={
              <button
                type="button"
                onClick={requestProactiveSuggestion}
                className={`${chipBtn} h-full flex items-center justify-center`}
                disabled={loading || suggesting}
              >
                {suggesting ? "…" : "Suggest"}
              </button>
            }
          >
            <FormattedTipContent
              title={RUN_SUGGEST_TIP.title}
              items={RUN_SUGGEST_TIP.items}
              noWrapItems
            />
          </InfoTip>
        )}
      </div>

      {!isDuringRun && lastConfig && (
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
            className="w-full py-2 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-sm font-semibold text-white"
          >
            {starting ? "Launching…" : "Start this swarm"}
          </button>
          <div className="text-[10px] text-center text-ink-500 mt-1">
            Or type &quot;yes&quot;, &quot;start&quot;, or &quot;go&quot;
          </div>
        </div>
      )}

      {!isDuringRun && (
        <div className="text-[10px] text-ink-500 mt-1">
          Brain helps craft the start config. Say &quot;yes&quot; when ready.
        </div>
      )}
    </div>
  );
}
