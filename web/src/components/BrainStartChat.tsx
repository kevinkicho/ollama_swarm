import { useState } from "react";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export type BrainConfigPatch = Record<string, unknown> & {
  preset?: string;
  model?: string;
};

export function BrainStartChat({ onApplyConfig, onStartNow }: { onApplyConfig: (cfg: BrainConfigPatch) => void; onStartNow?: (cfg: BrainConfigPatch) => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: "assistant", content: "Hi! I'm Brain, the swarm librarian. Tell me what you want to do (e.g. 'run blackboard on my local kyahoofinance folder with directive to add gov data panels to fx and credit tabs, use 5 agents, rounds 0'). I can give you the exact JSON + a working `ollama-swarm start` command." },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [lastConfig, setLastConfig] = useState<BrainConfigPatch | null>(null);
  const [starting, setStarting] = useState(false);

  const extractConfig = (text: string): BrainConfigPatch | null => {
    const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
    if (!jsonMatch) return null;
    try {
      return JSON.parse(jsonMatch[1]);
    } catch {
      return null;
    }
  };

  const isAffirmative = (text: string): boolean => {
    return /\b(yes|yep|yeah|sure|go|start|launch|do it|please|confirm|ready|ok|okay)\b/i.test(text);
  };

  const send = async () => {
    if (!input.trim() || loading) return;
    const userMsg: ChatMessage = { role: "user", content: input.trim() };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInput("");
    setLoading(true);

    const userWantsToStart = lastConfig && isAffirmative(userMsg.content);

    // Fast path: if user just said "yes/start" and we already have a config, start immediately
    // without an extra roundtrip (the LLM response can still come for UX).
    if (userWantsToStart && onStartNow && lastConfig) {
      setStarting(true);
      onStartNow(lastConfig);
      // Still let the LLM reply in background for the transcript feel
      setTimeout(() => setStarting(false), 4000);
    }

    try {
      const res = await fetch("/api/swarm/brain/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: newMessages }),
      });
      const data = await res.json();
      if (data.reply) {
        const assistantMsg: ChatMessage = { role: "assistant", content: data.reply };
        const updated = [...newMessages, assistantMsg];
        setMessages(updated);

        const cfg = extractConfig(data.reply);
        if (cfg) {
          setLastConfig(cfg);
          onApplyConfig(cfg);
        }

        // If assistant signals launch after we had a config
        const assistantWantsStart = cfg && /launching|starting now|begin|swarm is being launched/i.test(data.reply);
        if ((userWantsToStart || assistantWantsStart) && onStartNow) {
          const toStart = cfg || lastConfig;
          if (toStart) onStartNow(toStart);
        }
      }
    } catch (e) {
      setMessages([...newMessages, { role: "assistant", content: "Sorry, brain chat failed. Check if server is running." }]);
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

      <div className="h-56 overflow-y-auto bg-ink-900 border border-ink-700 rounded p-3 text-sm space-y-2 mb-3 custom-scroll">
        {messages.map((m, i) => (
          <div key={i} className={m.role === "user" ? "text-right" : ""}>
            <div className={`inline-block max-w-[85%] rounded-xl px-3 py-1.5 text-ink-100 ${m.role === "user" ? "bg-emerald-900/40" : "bg-ink-800"}`}>
              <div className="text-xs text-ink-400 mb-0.5">{m.role}</div>
              <div className="whitespace-pre-wrap">{m.content}</div>
            </div>
          </div>
        ))}
        {loading && <div className="text-ink-400 text-xs">Brain is thinking…</div>}
        {starting && <div className="text-emerald-400 text-xs">Starting the swarm via Brain…</div>}
      </div>

      <div className="flex gap-2">
        <textarea
          className="flex-1 bg-ink-900 border border-ink-700 rounded px-3 py-2 text-sm text-ink-100 placeholder:text-ink-500 focus:outline-none focus:border-violet-600 resize-y min-h-[38px] max-h-32"
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
          rows={2}
        />
        <button
          onClick={send}
          disabled={loading || !input.trim()}
          className="px-4 py-2 rounded bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-sm font-medium self-end"
        >
          Send
        </button>
      </div>

      {lastConfig && (
        <div className="mt-2">
          <button
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
