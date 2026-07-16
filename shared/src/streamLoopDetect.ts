/**
 * Detect and collapse final-text / mixed-stream generation loops.
 *
 * Run 9f449937 RCA: agent-3 streamed ~298k chars of nearly-identical
 * "I'll fetch the BIS API…" phrases after a leaked </think>. Growth was
 * real Ollama JSONL deltas (~50–200 chars/frame over minutes), not a UI
 * double-paint. Cloud often still reports a modest eval_count, so the
 * dashboard may not show a "token explosion" even while our cumulative
 * buffer balloons.
 *
 * These helpers are pure and shared by:
 *  - streamThinkGuard (abort in-flight)
 *  - stripAgentText (collapse before transcript persist)
 *  - agentStreaming (cap WS payload size)
 */

export interface PhraseLoopHit {
  /** Representative repeating unit (trimmed). */
  phrase: string;
  /** How many times the unit appears (greedy non-overlapping count). */
  count: number;
  /** Fraction of text covered by the repeating unit (0..1). */
  coveredRatio: number;
  /** Char length of the unit. */
  phraseLen: number;
}

const MIN_PHRASE = 40;
const MAX_PHRASE = 220;
const MIN_REPEATS = 6;

/**
 * Detect a high-coverage phrase loop in `text`.
 * Prefers longer phrases and requires the loop to dominate the string.
 */
export function detectPhraseLoop(text: string): PhraseLoopHit | null {
  if (!text || text.length < MIN_PHRASE * MIN_REPEATS) return null;

  // Focus on the tail — loops usually append; head may still be real prose.
  const window = text.length > 80_000 ? text.slice(-80_000) : text;
  let best: PhraseLoopHit | null = null;

  // Try suffix lengths from long → short so we catch full sentences first.
  for (let len = Math.min(MAX_PHRASE, Math.floor(window.length / MIN_REPEATS)); len >= MIN_PHRASE; len--) {
    const phrase = window.slice(-len);
    if (!phrase.trim() || /^\s+$/.test(phrase)) continue;
    // Skip ultra-low-entropy (spaces / single char)
    if (new Set(phrase).size < 8) continue;

    let count = 0;
    let pos = window.length;
    while (pos >= len && window.slice(pos - len, pos) === phrase) {
      count++;
      pos -= len;
    }
    // Also count non-suffix occurrences for coverage (capped scan).
    if (count < MIN_REPEATS) {
      count = countOccurrences(window, phrase);
    }
    if (count < MIN_REPEATS) continue;

    const coveredRatio = Math.min(1, (count * len) / window.length);
    if (coveredRatio < 0.35) continue;

    if (!best || count * len > best.count * best.phraseLen) {
      best = { phrase, count, coveredRatio, phraseLen: len };
    }
    // Early exit on very strong hit
    if (count >= 20 && coveredRatio >= 0.5) break;
  }

  return best;
}

function countOccurrences(hay: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let i = 0;
  const step = Math.max(1, Math.floor(needle.length * 0.5));
  while (i <= hay.length - needle.length) {
    const at = hay.indexOf(needle, i);
    if (at < 0) break;
    n++;
    i = at + step;
    if (n > 5000) break; // safety
  }
  return n;
}

export interface CollapseResult {
  text: string;
  collapsed: boolean;
  removedChars: number;
  hit: PhraseLoopHit | null;
}

/**
 * Collapse a phrase loop for storage/display: keep head + a few copies + marker.
 */
export function collapsePhraseLoop(
  text: string,
  opts: { maxKeep?: number; minLenToCollapse?: number } = {},
): CollapseResult {
  const maxKeep = opts.maxKeep ?? 2;
  const minLen = opts.minLenToCollapse ?? 8_000;
  if (!text || text.length < minLen) {
    return { text, collapsed: false, removedChars: 0, hit: null };
  }

  const hit = detectPhraseLoop(text);
  if (!hit || hit.count < MIN_REPEATS || hit.coveredRatio < 0.4) {
    return { text, collapsed: false, removedChars: 0, hit };
  }

  const phrase = hit.phrase;
  // Find first occurrence
  const first = text.indexOf(phrase);
  if (first < 0) {
    return { text, collapsed: false, removedChars: 0, hit };
  }

  const head = text.slice(0, first);
  const kept = phrase.repeat(maxKeep);
  const note =
    `\n\n…[stream loop collapsed: ~${hit.count}× repeated ${hit.phraseLen}-char phrase; ` +
    `${text.length.toLocaleString()} → `;
  const body = head + kept + note;
  // close note after we know final length
  const closed =
    body +
    `${(head.length + kept.length + 80).toLocaleString()} chars kept]…\n`;

  // Prefer a simpler deterministic note
  const collapsedText =
    `${head}${kept}\n\n…[stream loop collapsed: ~${hit.count}× repeated ` +
    `${hit.phraseLen}-char unit; dropped ${(text.length - head.length - kept.length).toLocaleString()} chars]…`;

  return {
    text: collapsedText,
    collapsed: true,
    removedChars: text.length - collapsedText.length,
    hit,
  };
}

/** True when raw stream is dominated by a generation loop (abort signal). */
export function isDominantStreamLoop(
  text: string,
  opts: { minLen?: number; minRatio?: number; minCount?: number } = {},
): PhraseLoopHit | null {
  const minLen = opts.minLen ?? 12_000;
  const minRatio = opts.minRatio ?? 0.4;
  const minCount = opts.minCount ?? MIN_REPEATS;
  if (text.length < minLen) return null;
  const hit = detectPhraseLoop(text);
  if (!hit) return null;
  if (hit.count >= minCount && hit.coveredRatio >= minRatio) return hit;
  return null;
}
