// Heuristic detection of runaway / repetitive streams (offline log analysis).

export type StreamAnomalyKind =
  | "phrase_repeat"
  | "trailing_suffix_repeat"
  | "stream_length";

export interface StreamAnomalyFinding {
  kind: StreamAnomalyKind;
  /** Human-readable pattern sample. */
  pattern: string;
  count: number;
  detail: string;
}

export interface StreamAnomalyDetectorOpts {
  /** Start checking once cumulative text reaches this length. Default 10_000. */
  minLength?: number;
  /** Minimum global occurrences of a repeated phrase to flag. Default 8. */
  minPhraseCount?: number;
  /** Stream length milestones (chars) to flag once each. */
  lengthMilestones?: number[];
}

const DEFAULT_MILESTONES = [50_000, 100_000, 200_000, 300_000];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function detectTrailingSuffixRepeat(text: string): StreamAnomalyFinding | null {
  if (text.length < 60) return null;
  const maxLen = Math.min(500, Math.floor(text.length / 3));
  for (let rLen = maxLen; rLen >= 20; rLen--) {
    const tail = text.slice(-rLen);
    let count = 0;
    let pos = text.length;
    while (pos >= rLen && text.slice(pos - rLen, pos) === tail) {
      count++;
      pos -= rLen;
    }
    if (count >= 3) {
      return {
        kind: "trailing_suffix_repeat",
        pattern: tail.slice(0, 100).replace(/\s+/g, " "),
        count,
        detail: `Suffix of ${rLen} chars repeated ${count} times at stream tail`,
      };
    }
  }
  return null;
}

function detectPhraseRepeat(
  text: string,
  minCount: number,
): StreamAnomalyFinding | null {
  const normalized = text.replace(/\s+/g, " ");
  const maxPhraseLen = Math.min(120, Math.floor(normalized.length / minCount));
  for (let len = maxPhraseLen; len >= 30; len -= 10) {
    const seen = new Set<string>();
    for (let i = 0; i <= normalized.length - len; i += Math.max(5, Math.floor(len / 4))) {
      const sub = normalized.slice(i, i + len).trim();
      if (sub.length < 30 || seen.has(sub)) continue;
      seen.add(sub);
      const count = (normalized.match(new RegExp(escapeRegExp(sub), "g")) || []).length;
      if (count >= minCount) {
        return {
          kind: "phrase_repeat",
          pattern: sub.slice(0, 100),
          count,
          detail: `Phrase repeated ${count} times in stream`,
        };
      }
    }
  }
  return null;
}

/** Scan cumulative stream text for repetition / runaway length signals. */
export function detectStreamAnomalies(
  text: string,
  opts?: StreamAnomalyDetectorOpts,
  alreadyMilestones?: ReadonlySet<number>,
): StreamAnomalyFinding[] {
  const minLength = opts?.minLength ?? 10_000;
  const minPhraseCount = opts?.minPhraseCount ?? 8;
  const milestones = opts?.lengthMilestones ?? DEFAULT_MILESTONES;
  if (text.length < minLength) return [];

  const out: StreamAnomalyFinding[] = [];

  const phrase = detectPhraseRepeat(text, minPhraseCount);
  if (phrase) out.push(phrase);

  const suffix = detectTrailingSuffixRepeat(text);
  if (suffix) out.push(suffix);

  for (const m of milestones) {
    if (text.length >= m && !alreadyMilestones?.has(m)) {
      out.push({
        kind: "stream_length",
        pattern: `${m.toLocaleString()} chars`,
        count: text.length,
        detail: `Stream exceeded ${m.toLocaleString()} characters`,
      });
    }
  }

  return out;
}