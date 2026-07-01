import { useState } from "react";

interface PatchHunk {
  file: string;
  search?: string;
  replace?: string;
  content?: string;
  op: "replace" | "create" | "append" | "delete";
}

interface PatchPreview {
  id: string;
  title: string;
  description: string;
  priority: "high" | "medium" | "low";
  hunks: PatchHunk[];
  status: "pending" | "previewing" | "applying" | "applied" | "failed" | "rolled-back";
  error?: string;
  commitSha?: string;
  appliedAt?: number;
  confidence?: number;
}

interface PatchPreviewPanelProps {
  patch: PatchPreview;
  onApply?: () => void;
  onReject?: () => void;
  onRollback?: () => void;
  showDebug?: boolean;
}

export function PatchPreviewPanel({
  patch,
  onApply,
  onReject,
  onRollback,
  showDebug = false,
}: PatchPreviewPanelProps) {
  const [expandedHunks, setExpandedHunks] = useState<Set<number>>(new Set());
  const [showRaw, setShowRaw] = useState(false);

  const toggleHunk = (i: number) => {
    setExpandedHunks((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };

  return (
    <div className="rounded border border-ink-700 bg-ink-800 p-3 space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-amber-400 font-semibold text-xs">⚙ Patch Preview</span>
          <StatusBadge status={patch.status} />
          {patch.confidence !== undefined && (
            <span className="text-[10px] text-ink-500">
              Confidence: {Math.round(patch.confidence * 100)}%
            </span>
          )}
        </div>
        <div className="flex gap-1">
          <button
            onClick={() => setShowRaw(!showRaw)}
            className="text-[10px] px-1.5 py-0.5 rounded bg-ink-700 hover:bg-ink-600 text-ink-400"
          >
            {showRaw ? "Formatted" : "Raw"}
          </button>
        </div>
      </div>

      {/* Title and description */}
      <div>
        <div className="text-sm text-ink-200 font-medium">{patch.title}</div>
        <div className="text-xs text-ink-400 mt-1">{patch.description}</div>
      </div>

      {/* Hunks */}
      <div className="space-y-2">
        {patch.hunks.map((hunk, i) => (
          <HunkPreview
            key={i}
            hunk={hunk}
            index={i}
            expanded={expandedHunks.has(i)}
            onToggle={() => toggleHunk(i)}
            showRaw={showRaw}
          />
        ))}
      </div>

      {/* Debug info */}
      {showDebug && (
        <div className="rounded bg-ink-900/50 p-2 text-[10px] text-ink-500 font-mono space-y-1">
          <div>Patch ID: {patch.id}</div>
          <div>Hunks: {patch.hunks.length}</div>
          {patch.commitSha && <div>Commit: {patch.commitSha.slice(0, 8)}</div>}
          {patch.appliedAt && <div>Applied: {new Date(patch.appliedAt).toLocaleString()}</div>}
          {patch.error && <div className="text-red-400">Error: {patch.error}</div>}
        </div>
      )}

      {/* Actions */}
      {patch.status === "pending" && (
        <div className="flex gap-2 pt-2 border-t border-ink-700/50">
          <button
            onClick={onApply}
            className="text-xs px-3 py-1 rounded bg-emerald-700 hover:bg-emerald-600 text-emerald-100 font-medium"
          >
            Apply Patch
          </button>
          <button
            onClick={onReject}
            className="text-xs px-3 py-1 rounded bg-ink-700 hover:bg-ink-600 text-ink-300"
          >
            Reject
          </button>
        </div>
      )}

      {patch.status === "failed" && onRollback && (
        <div className="flex gap-2 pt-2 border-t border-ink-700/50">
          <button
            onClick={onRollback}
            className="text-xs px-3 py-1 rounded bg-amber-700 hover:bg-amber-600 text-amber-100 font-medium"
          >
            ↺ Rollback
          </button>
        </div>
      )}
    </div>
  );
}

function HunkPreview({
  hunk,
  index,
  expanded,
  onToggle,
  showRaw,
}: {
  hunk: PatchHunk;
  index: number;
  expanded: boolean;
  onToggle: () => void;
  showRaw: boolean;
}) {
  const opColor =
    hunk.op === "create"
      ? "text-emerald-400"
      : hunk.op === "delete"
      ? "text-red-400"
      : "text-amber-400";

  return (
    <div className="rounded border border-ink-700 bg-ink-900/50 overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-2 py-1.5 text-xs hover:bg-ink-800/50 transition"
      >
        <span className="text-ink-500">{expanded ? "▾" : "▸"}</span>
        <span className={`${opColor} font-mono`}>{hunk.op}</span>
        <span className="text-ink-300 truncate">{hunk.file}</span>
      </button>
      {expanded && (
        <div className="px-2 pb-2 border-t border-ink-700/50">
          {showRaw ? (
            <pre className="text-[10px] text-ink-400 font-mono whitespace-pre-wrap mt-1">
              {JSON.stringify(hunk, null, 2)}
            </pre>
          ) : (
            <DiffView hunk={hunk} />
          )}
        </div>
      )}
    </div>
  );
}

function DiffView({ hunk }: { hunk: PatchHunk }) {
  if (hunk.op === "create" || hunk.op === "append") {
    return (
      <div className="mt-1 text-[10px] font-mono">
        <div className="text-emerald-400 mb-1">+ New content:</div>
        <pre className="text-emerald-300/80 whitespace-pre-wrap bg-emerald-900/20 rounded p-1 max-h-32 overflow-y-auto">
          {hunk.content ?? "(empty)"}
        </pre>
      </div>
    );
  }

  if (hunk.op === "delete") {
    return (
      <div className="mt-1 text-[10px] font-mono text-red-400">
        Delete entire file
      </div>
    );
  }

  // replace
  return (
    <div className="mt-1 text-[10px] font-mono space-y-1">
      {hunk.search && (
        <div>
          <div className="text-red-400 mb-0.5">- Search:</div>
          <pre className="text-red-300/80 whitespace-pre-wrap bg-red-900/20 rounded p-1 max-h-24 overflow-y-auto">
            {hunk.search}
          </pre>
        </div>
      )}
      {hunk.replace !== undefined && (
        <div>
          <div className="text-emerald-400 mb-0.5">+ Replace:</div>
          <pre className="text-emerald-300/80 whitespace-pre-wrap bg-emerald-900/20 rounded p-1 max-h-24 overflow-y-auto">
            {hunk.replace}
          </pre>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const config: Record<string, { color: string; label: string }> = {
    pending: { color: "bg-ink-600 text-ink-300", label: "Pending" },
    previewing: { color: "bg-blue-900/50 text-blue-300", label: "Previewing" },
    applying: { color: "bg-amber-900/50 text-amber-300", label: "Applying" },
    applied: { color: "bg-emerald-900/50 text-emerald-300", label: "Applied" },
    failed: { color: "bg-red-900/50 text-red-300", label: "Failed" },
    "rolled-back": { color: "bg-amber-900/50 text-amber-300", label: "Rolled Back" },
  };

  const c = config[status] ?? config.pending;
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded ${c.color}`}>
      {c.label}
    </span>
  );
}
