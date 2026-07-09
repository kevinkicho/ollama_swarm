import { memo, useState } from "react";
import type { TranscriptEntry } from "../../types";
import {
  compactPipelineStatusChip,
  compactPipelineStatusText,
} from "./compactPipelineStatus";

/** Single-line pipeline status (research pre-pass, web tools) — expandable for web_tool previews. */
export const CompactPipelineStatusLine = memo(function CompactPipelineStatusLine({
  entry,
  ts,
}: {
  entry: TranscriptEntry;
  ts: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const text = compactPipelineStatusText(entry);
  const chip = compactPipelineStatusChip(entry);
  const webSummary =
    entry.summary?.kind === "web_tool" ? entry.summary : undefined;
  const isWebTool = webSummary != null;
  const ok = webSummary?.ok;
  const preview = webSummary?.preview;
  const chipCls = isWebTool
    ? ok
      ? "text-cyan-300 bg-cyan-950/50 border border-cyan-800/50"
      : "text-rose-300 bg-rose-950/40 border border-rose-800/50"
    : "text-ink-600 bg-ink-800/60";

  return (
    <div
      className="py-0.5 pl-2 text-[10px] text-ink-500/90 font-mono border-l border-ink-700/40 opacity-90"
      data-compact-pipeline-status="true"
    >
      <div className="flex items-center gap-2">
        <span className={`shrink-0 uppercase tracking-wider text-[9px] px-1 rounded ${chipCls}`}>
          {chip}
        </span>
        <span className="min-w-0 flex-1 truncate" title={text}>
          {text}
        </span>
        {isWebTool && preview ? (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="shrink-0 text-[9px] uppercase tracking-wide text-ink-500 hover:text-ink-300"
          >
            {expanded ? "Hide" : "Preview"}
          </button>
        ) : null}
        <span className="shrink-0 text-ink-600">{ts}</span>
      </div>
      {expanded && preview ? (
        <div className="mt-1 mr-2 rounded border border-cyan-900/40 bg-cyan-950/15 px-2 py-1 text-[10px] text-ink-400 whitespace-pre-wrap break-all max-h-32 overflow-y-auto">
          {preview}
        </div>
      ) : null}
    </div>
  );
});