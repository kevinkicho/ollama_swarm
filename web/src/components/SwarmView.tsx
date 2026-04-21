import { useState } from "react";
import { useSwarm } from "../state/store";
import { AgentPanel } from "./AgentPanel";
import { BoardView } from "./BoardView";
import { Transcript } from "./Transcript";

type Tab = "transcript" | "board";

export function SwarmView() {
  const agents = useSwarm((s) => s.agents);
  const phase = useSwarm((s) => s.phase);
  const setError = useSwarm((s) => s.setError);
  const [sayText, setSayText] = useState("");
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>("transcript");

  const reset = useSwarm((s) => s.reset);
  const agentList = Object.values(agents).sort((a, b) => a.index - b.index);
  const isTerminal = phase === "completed" || phase === "stopped" || phase === "failed";

  const onStop = async () => {
    if (!confirm("Stop the swarm? All spawned opencode processes will be terminated.")) return;
    setBusy(true);
    try {
      await fetch("/api/swarm/stop", { method: "POST" });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onNewSwarm = () => {
    reset();
  };

  const onSay = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!sayText.trim()) return;
    try {
      await fetch("/api/swarm/say", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: sayText }),
      });
      setSayText("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const canStop = phase !== "stopping" && phase !== "stopped" && phase !== "failed" && phase !== "completed";

  return (
    <div className="h-full grid grid-cols-[260px_1fr]">
      <aside className="border-r border-ink-700 p-3 overflow-y-auto space-y-2 bg-ink-800">
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs uppercase tracking-wide text-ink-400">Agents</div>
          {isTerminal ? (
            <button
              onClick={onNewSwarm}
              className="text-xs px-2 py-1 rounded bg-emerald-600 hover:bg-emerald-500"
            >
              New swarm
            </button>
          ) : (
            <button
              onClick={onStop}
              disabled={busy || !canStop}
              className="text-xs px-2 py-1 rounded bg-red-700 hover:bg-red-600 disabled:bg-ink-600 disabled:cursor-not-allowed"
            >
              Stop
            </button>
          )}
        </div>
        {agentList.map((a) => (
          <AgentPanel key={a.id} agent={a} />
        ))}
        {agentList.length === 0 ? (
          <div className="text-xs text-ink-400">No agents yet.</div>
        ) : null}
      </aside>
      <section className="flex flex-col overflow-hidden">
        <div className="flex border-b border-ink-700 bg-ink-800 text-sm">
          <TabButton active={tab === "transcript"} onClick={() => setTab("transcript")}>
            Transcript
          </TabButton>
          <TabButton active={tab === "board"} onClick={() => setTab("board")}>
            Board
          </TabButton>
        </div>
        <div className="flex-1 overflow-hidden">
          {tab === "transcript" ? <Transcript /> : <BoardView />}
        </div>
        <form onSubmit={onSay} className="border-t border-ink-700 p-3 bg-ink-800 flex gap-2">
          <input
            value={sayText}
            onChange={(e) => setSayText(e.target.value)}
            placeholder="Inject a message into the discussion (as orchestrator)…"
            className="flex-1 bg-ink-900 border border-ink-600 rounded px-3 py-2 text-sm focus:outline-none focus:border-emerald-500"
          />
          <button
            type="submit"
            className="px-4 py-2 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-sm"
          >
            Send
          </button>
        </form>
      </section>
    </div>
  );
}

interface TabButtonProps {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}
function TabButton({ active, onClick, children }: TabButtonProps) {
  return (
    <button
      onClick={onClick}
      className={
        "px-4 py-2 border-b-2 transition-colors " +
        (active
          ? "border-emerald-500 text-emerald-300"
          : "border-transparent text-ink-400 hover:text-ink-200")
      }
    >
      {children}
    </button>
  );
}
