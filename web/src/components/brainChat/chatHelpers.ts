import type { BrainConfigPatch, RunReconfigPatch } from "./types";

export function extractLabeledJson(text: string, label: string): unknown {
  const re = new RegExp(`${label}:\\s*({[\\s\\S]*?})(?=\\n[A-Z_]+:|$)`, "i");
  const m = text.match(re);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

export function extractReconfig(text: string): RunReconfigPatch | null {
  const parsed = extractLabeledJson(text, "RECONFIG") as RunReconfigPatch | null;
  if (parsed && typeof parsed === "object") return parsed;
  return null;
}

export function formatReconfigLabel(patch: RunReconfigPatch): string {
  const parts: string[] = [];
  if (patch.extendWallClockCapMin != null) parts.push(`+${patch.extendWallClockCapMin}m cap`);
  if (patch.extendRounds != null) parts.push(`+${patch.extendRounds} rounds`);
  if (patch.extendTokenBudget != null) parts.push(`+${patch.extendTokenBudget.toLocaleString()} tokens`);
  if (patch.wallClockCapMin != null) parts.push(`cap → ${patch.wallClockCapMin}m`);
  if (patch.rounds != null) parts.push(`rounds → ${patch.rounds}`);
  if (patch.tokenBudget != null) parts.push(`budget → ${patch.tokenBudget.toLocaleString()}`);
  if (patch.thinkGuardRefereeEnabled != null) {
    parts.push(`referee ${patch.thinkGuardRefereeEnabled ? "on" : "off"}`);
  }
  if (patch.thinkGuardRefereeMaxCallsPerRun != null) {
    parts.push(`referee calls → ${patch.thinkGuardRefereeMaxCallsPerRun}`);
  }
  if (patch.thinkGuardRefereeMinThinkChars != null) {
    parts.push(`referee min think → ${patch.thinkGuardRefereeMinThinkChars.toLocaleString()}`);
  }
  if (patch.thinkGuardRefereeThinkTailMinChars != null || patch.thinkGuardRefereeThinkTailMaxChars != null) {
    const min = patch.thinkGuardRefereeThinkTailMinChars;
    const max = patch.thinkGuardRefereeThinkTailMaxChars;
    if (min != null && max != null) parts.push(`referee tail ${min.toLocaleString()}–${max.toLocaleString()}`);
    else if (min != null) parts.push(`referee tail min → ${min.toLocaleString()}`);
    else if (max != null) parts.push(`referee tail max → ${max!.toLocaleString()}`);
  }
  if (patch.thinkGuardRefereeMaxOutputTokens != null) {
    parts.push(`referee max out → ${patch.thinkGuardRefereeMaxOutputTokens} tok`);
  }
  return parts.join(", ") || "limits";
}

export function extractConfig(text: string): BrainConfigPatch | null {
  // Prefer fenced json, then first balanced object (mirrors shared extractor).
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  let candidate = fence ? fence[1] : text;
  // find first balanced
  let depth = 0, start = -1;
  for (let i = 0; i < candidate.length; i++) {
    const c = candidate[i];
    if (c === '{') { if (depth === 0) start = i; depth++; }
    else if (c === '}') { depth--; if (depth === 0 && start !== -1) { candidate = candidate.slice(start, i+1); break; } }
  }
  try {
    const parsed = JSON.parse(candidate);
    if (parsed && (parsed.preset || parsed.parentPath)) return parsed;
  } catch {}
  return null;
}

export function isAffirmative(text: string): boolean {
  return /\b(yes|yep|yeah|sure|go|start|launch|do it|please|confirm|ready|ok|okay)\b/i.test(text);
}
