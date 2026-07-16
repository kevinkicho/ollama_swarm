/**
 * Merge one streaming field frame that may be either a delta or a full
 * cumulative snapshot. Used by OllamaClient (and any future provider) so
 * we never double-append cumulative frames into quadratic garbage.
 *
 * Rules:
 *  - empty next → keep prev
 *  - empty prev → take next
 *  - next starts with prev and is longer/equal → cumulative assign
 *  - prev starts with next and is longer → ignore redundant prefix rebroadcast
 *  - else → treat as delta append
 */
export function mergeStreamField(prev: string, next: string): string {
  if (!next) return prev;
  if (!prev) return next;
  if (next.startsWith(prev) && next.length >= prev.length) return next;
  if (prev.startsWith(next) && next.length < prev.length) return prev;
  return prev + next;
}
