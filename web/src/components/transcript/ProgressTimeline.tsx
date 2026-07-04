import { useMemo } from "react";
import { parseProgressMarkers, stripProgressMarkers, markerIcon, markerLabel, type ProgressMarker } from "../../lib/parseProgressMarkers";

/**
 * ProgressTimeline — renders streaming text from an agent.
 *
 * When [PROGRESS: ...] markers are present, renders them as a structured
 * timeline. Otherwise renders raw text. No heuristic detection — that's
 * the brain's job.
 */
export function ProgressTimeline({
  text,
  agentLabel,
  className = "",
}: {
  text: string;
  agentLabel?: string;
  className?: string;
}) {
  const markers = useMemo(() => parseProgressMarkers(text), [text]);
  const cleanText = useMemo(() => stripProgressMarkers(text), [text]);

  return (
    <div className={`rounded border border-ink-700 bg-ink-900/80 p-2 space-y-0.5 ${className}`}>
      {agentLabel && (
        <div className="text-[10px] uppercase tracking-wider text-ink-500 mb-1">{agentLabel}</div>
      )}
      {markers.length > 0 ? (
        markers.map((m, i) => (
          <MarkerRow key={i} marker={m} isLatest={i === markers.length - 1} />
        ))
      ) : null}
      {cleanText.length > 0 && (
        <div className={`${markers.length > 0 ? "mt-1.5 pt-1.5 border-t border-ink-700/50" : ""} text-[11px] text-ink-300 max-h-48 overflow-y-auto whitespace-pre-wrap break-words font-mono`}>
          {cleanText}
        </div>
      )}
      {text.length === 0 && (
        <div className="text-[11px] text-ink-500 italic flex items-center gap-1.5">
          <span className="inline-flex gap-0.5 items-end">
            <Dot delay={0} />
            <Dot delay={150} />
            <Dot delay={300} />
          </span>
          Thinking…
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

function Dot({ delay }: { delay: number }) {
  return (
    <span
      className="inline-block w-1 h-1 rounded-full bg-emerald-400"
    />
  );
}

/**
 * CompactProgress — single-line summary of latest progress marker.
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
