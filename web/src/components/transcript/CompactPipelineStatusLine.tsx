import { memo } from "react";
import type { TranscriptEntry } from "../../types";
import {
  compactPipelineStatusChip,
  compactPipelineStatusText,
} from "./compactPipelineStatus";

/** Single-line pipeline status (research pre-pass, web tools) — no collapsible body. */
export const CompactPipelineStatusLine = memo(function CompactPipelineStatusLine({
  entry,
  ts,
}: {
  entry: TranscriptEntry;
  ts: string;
}) {
  const text = compactPipelineStatusText(entry);
  const chip = compactPipelineStatusChip(entry);
  return (
    <div
      className="flex items-center gap-2 py-0.5 pl-2 text-[10px] text-ink-500/90 font-mono border-l border-ink-700/40 opacity-80"
      data-compact-pipeline-status="true"
    >
      <span className="shrink-0 uppercase tracking-wider text-[9px] text-ink-600 bg-ink-800/60 px-1 rounded">
        {chip}
      </span>
      <span className="min-w-0 flex-1 truncate" title={text}>
        {text}
      </span>
      <span className="shrink-0 text-ink-600">{ts}</span>
    </div>
  );
});