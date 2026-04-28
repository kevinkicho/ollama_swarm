// Task #152: surface .swarm-memory.jsonl entries in the UI.
//
// Today the lessons-learned log written by #130's runMemoryDistillationPass
// is only visible on disk. They're the highest-signal output of any
// run — see the smoke-tour digest for examples — and a future blackboard
// run on the same clone reads them automatically. But there's been no
// way to see what's accumulated without grepping the file.
//
// Polls /api/swarm/memory?clonePath=... when the active clone changes.
// Renders newest-first, with each entry showing date · runId · tier ·
// commits as a header and the lessons as bullets.

import { useEffect, useState } from "react";

interface MemoryEntry {
  ts: number;
  runId: string;
  tier: number;
  commits: number;
  lessons: string[];
}

interface MemoryResponse {
  entries: MemoryEntry[];
}

export function MemoryLogPanel({ clonePath }: { clonePath: string | undefined }) {
  const [entries, setEntries] = useState<MemoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!clonePath) {
      setEntries(null);
      setError(null);
      return;
    }
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        // #240 (2026-04-28): includeOtherParents=true aggregates memory
        // entries from clones with the same name under EVERY known
        // parent path. Lets the panel show prior-clone lessons even
        // when the active parent is fresh.
        const r = await fetch(`/api/swarm/memory?clonePath=${encodeURIComponent(clonePath as string)}&includeOtherParents=true`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const body = (await r.json()) as MemoryResponse;
        if (cancelled) return;
        setEntries(body.entries);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setEntries(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    // Poll occasionally so a freshly-completed run's lesson appears
    // without a manual refresh. 15s is rare enough to be cheap.
    const t = setInterval(load, 15_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [clonePath]);

  if (!clonePath) {
    return (
      <div className="text-xs text-ink-500 p-3">
        No active clone — memory log is per-clone, populates after the first blackboard run.
      </div>
    );
  }
  if (loading && entries === null) {
    return <div className="text-xs text-ink-400 p-3">Loading memory log…</div>;
  }
  if (error) {
    return <div className="text-xs text-rose-300 p-3">Failed to load: {error}</div>;
  }
  if (!entries || entries.length === 0) {
    return (
      <div className="text-xs text-ink-500 p-3 space-y-1">
        <div>No memory entries yet on this clone.</div>
        <div className="text-ink-600">
          Blackboard's <code className="font-mono">runMemoryDistillationPass</code> appends a 2-4 bullet lesson set after each successful run.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3 p-3">
      <div className="text-xs text-ink-400 flex items-center justify-between">
        <span>
          {entries.length} memory {entries.length === 1 ? "entry" : "entries"} · newest first
        </span>
        <span className="text-ink-600 font-mono text-[10px]">.swarm-memory.jsonl</span>
      </div>
      {entries.map((e) => (
        <MemoryEntryCard key={`${e.runId}-${e.ts}`} entry={e} />
      ))}
    </div>
  );
}

function MemoryEntryCard({ entry }: { entry: MemoryEntry }) {
  const dateStr = new Date(entry.ts).toLocaleString();
  return (
    <div className="rounded border border-violet-700/40 bg-violet-950/15 px-3 py-2 text-xs space-y-1.5">
      <div className="flex items-center gap-2 text-ink-400">
        <span className="text-violet-300 font-mono uppercase tracking-wider text-[10px]">
          ✦ memory
        </span>
        <span>{dateStr}</span>
        <span className="text-ink-600">·</span>
        <span className="text-ink-500 font-mono">{entry.runId.slice(0, 8)}</span>
        <span className="text-ink-600">·</span>
        <span className="text-ink-500">tier {entry.tier}</span>
        <span className="text-ink-600">·</span>
        <span className="text-ink-500">{entry.commits} commits</span>
      </div>
      <ul className="list-disc list-inside text-violet-100 space-y-1">
        {entry.lessons.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ul>
    </div>
  );
}
