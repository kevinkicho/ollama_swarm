// Shared truncation helper used by every BB log line that surfaces a
// todo/criterion description in a system message. Centralized so the
// 80-char cap stays consistent across the runner + per-commit
// invocations (critic, verifier).
export function truncate(s: string, max: number = 80): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
