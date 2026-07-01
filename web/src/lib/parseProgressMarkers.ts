// parseProgressMarkers.ts — Extract structured progress markers from streaming text.
//
// Agents emit markers like [PROGRESS: read: src/App.jsx] in their streaming text.
// This module parses them into structured objects for the UI to render.

export interface ProgressMarker {
  type: "read" | "grep" | "write" | "plan" | "criteria" | "verify" | "skip" | "done";
  detail: string;
  raw: string;
}

const MARKER_REGEX = /^\[PROGRESS:\s*(\w+):\s*(.+?)\]\s*$/;

/**
 * Parse progress markers from streaming text.
 * Returns markers in order of appearance, skipping non-marker lines.
 */
export function parseProgressMarkers(text: string): ProgressMarker[] {
  const markers: ProgressMarker[] = [];
  const lines = text.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    const m = trimmed.match(MARKER_REGEX);
    if (m) {
      const type = m[1].toLowerCase() as ProgressMarker["type"];
      if (["read", "grep", "write", "plan", "criteria", "verify", "skip", "done"].includes(type)) {
        markers.push({ type, detail: m[2].trim(), raw: trimmed });
      }
    }
  }
  return markers;
}

/**
 * Strip progress markers from streaming text, returning the remaining content.
 * Used to show clean text after markers are extracted.
 */
export function stripProgressMarkers(text: string): string {
  return text
    .split("\n")
    .filter((line) => !MARKER_REGEX.test(line.trim()))
    .join("\n")
    .trim();
}

/**
 * Get icon for progress marker type.
 */
export function markerIcon(type: ProgressMarker["type"]): string {
  switch (type) {
    case "read": return "📖";
    case "grep": return "🔍";
    case "write": return "✏️";
    case "plan": return "📋";
    case "criteria": return "🎯";
    case "verify": return "✅";
    case "skip": return "⏭️";
    case "done": return "🏁";
    default: return "▸";
  }
}

/**
 * Get a human-readable label for the marker type.
 */
export function markerLabel(type: ProgressMarker["type"]): string {
  switch (type) {
    case "read": return "Reading";
    case "grep": return "Searching";
    case "write": return "Writing";
    case "plan": return "Planning";
    case "criteria": return "Progress";
    case "verify": return "Verifying";
    case "skip": return "Skipping";
    case "done": return "Done";
    default: return type;
  }
}
