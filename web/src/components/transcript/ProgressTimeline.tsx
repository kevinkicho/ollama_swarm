import { useState, useMemo } from "react";
import { parseProgressMarkers, stripProgressMarkers, markerIcon, markerLabel, type ProgressMarker } from "../../lib/parseProgressMarkers";

/**
 * ProgressTimeline — renders structured progress markers from streaming text.
 *
 * Parses [PROGRESS: type: detail] markers and displays them as a vertical
 * timeline with icons. Falls back to raw text when no markers are found.
 *
 * Used in StreamingDock and PlannerThinkingPanel.
 */
export function ProgressTimeline({
  text,
  className = "",
}: {
  text: string;
  className?: string;
}) {
  const markers = useMemo(() => parseProgressMarkers(text), [text]);
  const cleanText = useMemo(() => stripProgressMarkers(text), [text]);

  if (markers.length === 0) return null;

  return (
    <div className={`space-y-0.5 ${className}`}>
      {markers.map((m, i) => (
        <MarkerRow key={i} marker={m} isLatest={i === markers.length - 1} />
      ))}
      {cleanText.length > 0 && (
        <div className="mt-1 text-[11px] text-ink-400 truncate max-w-full" title={cleanText}>
          {cleanText.slice(-200)}
        </div>
      )}
    </div>
  );
}

function MarkerRow({ marker, isLatest }: { marker: ProgressMarker; isLatest: boolean }) {
  return (
    <div className={`flex items-center gap-1.5 text-[11px] ${isLatest ? "text-ink-200" : "text-ink-400"}`}>
      <span className="flex-shrink-0 w-4 text-center">{markerIcon(marker.type)}</span>
      <span className="flex-shrink-0 text-[10px] uppercase tracking-wider opacity-60">
        {markerLabel(marker.type)}
      </span>
      <span className="truncate min-w-0">{marker.detail}</span>
    </div>
  );
}

/**
 * CompactProgress — single-line summary of latest progress marker.
 * Used when space is tight (e.g., sidebar agent cards).
 */
export function CompactProgress({ text }: { text: string }) {
  const markers = useMemo(() => parseProgressMarkers(text), [text]);
  if (markers.length === 0) return null;
  const latest = markers[markers.length - 1];
  return (
    <span className="text-[11px] text-ink-300 truncate">
      {markerIcon(latest.type)} {latest.detail}
    </span>
  );
}
