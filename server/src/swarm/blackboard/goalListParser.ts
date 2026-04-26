// Task #127: parse a numbered goal list of the shape:
//   1. [TITLE] - description ...
//   2. [TITLE] - description ...
// Returns each item's text WITHOUT the leading "N." marker. Tolerant
// of "1)" and bare "1" prefixes too. Stops at lines that don't start
// with a number (e.g. the "TOP: N" trailer or empty trailing prose).
// Exported for testability.
//
// Task #164 (refactor): extracted from BlackboardRunner.ts as part of
// the 4209-LOC split. Used by both the goal-generation pre-pass (#127)
// and the stretch-goal reflection pass (#129).
export function parseGoalList(text: string): string[] {
  const items: string[] = [];
  let current: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const numStart = /^\s*(\d{1,2})[.)]\s+(.*)$/.exec(line);
    if (numStart) {
      if (current.length > 0) items.push(current.join(" ").trim());
      current = [numStart[2] ?? ""];
    } else if (current.length > 0 && line.trim().length > 0 && !/^TOP\s*:/i.test(line)) {
      current.push(line.trim());
    } else if (current.length > 0 && (line.trim().length === 0 || /^TOP\s*:/i.test(line))) {
      items.push(current.join(" ").trim());
      current = [];
    }
  }
  if (current.length > 0) items.push(current.join(" ").trim());
  return items.filter((s) => s.length > 0);
}
