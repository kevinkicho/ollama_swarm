// Virtual list size estimates for transcript entries — extracted from Transcript.tsx.

/** Over-estimate entry height so virtual ranges don't hide content before measure. */
export function estimateTranscriptEntrySize(e: {
  role?: string;
  text?: string;
  summary?: { kind?: string; [key: string]: unknown } | null;
  thoughts?: string | unknown[] | undefined;
  streamSnapshot?: unknown;
  toolCalls?: unknown[];
} | undefined): number {
  if (!e) return 80;
  // Over-estimate more aggressively to avoid initial under-placement that causes
  // overlap/stagger (items placed too high, stacking on previous). Measure will tighten.
  if (e.role === "agent-stream") {
    const tlen = (e.text || "").length;
    const lines = Math.max(4, Math.ceil(tlen / 24));
    return 100 + lines * 18 + (tlen > 1000 ? 500 : 0) + (tlen > 3000 ? 800 : 0) + (tlen > 6000 ? 1100 : 0);
  }
  const kind = e.summary?.kind || "";
  if (e.text && e.text.startsWith("▸▸RUN-START▸▸")) {
    return 140;
  }
  if (kind === "agents_ready") {
    const n = (e.summary as { agents?: unknown[] })?.agents?.length ?? 5;
    return 120 + n * 30;
  }
  if (kind === "worker_hunks") {
    const numHunks = (e.summary as { hunks?: unknown[] })?.hunks?.length ?? 3;
    return 400 + numHunks * 220;
  }
  if (kind.includes("synthesis") || kind === "stretch_goals") return 350;
  if (kind === "deliverable") return 280;
  if (kind === "run_finished") {
    const n = (e.summary as { agents?: unknown[] })?.agents?.length ?? 4;
    const hasExtra =
      !!(e.summary as { totalPromptTokens?: unknown })?.totalPromptTokens ||
      !!(e.summary as { totalResponseTokens?: unknown })?.totalResponseTokens;
    return 850 + n * 45 + (hasExtra ? 100 : 0);
  }
  if (kind === "seed_announce") {
    const count = (e.summary as { topLevel?: unknown[] })?.topLevel?.length ?? 12;
    return 320 + Math.min(count, 12) * 32;
  }
  if (kind === ("run_start" as string)) return 220;

  const textLen = (e.text || "").length;
  if (textLen > 0) {
    if (e.role === "system") {
      const approxLines = Math.min(6, Math.max(1, Math.ceil(textLen / 38)));
      return 36 + approxLines * 15;
    }
    const lines = Math.max(2, Math.ceil(textLen / 22));
    const base = 55;
    let size = base + lines * 18;
    if (e.thoughts && (Array.isArray(e.thoughts) ? e.thoughts.length > 0 : String(e.thoughts).length > 0)) size += 24;
    if (e.streamSnapshot) size += 24;
    if (e.toolCalls && e.toolCalls.length > 0) size += 40;
    if (textLen > 800) size += 200;
    if (textLen > 2500) size += 400;
    if (textLen > 5000) size += 700;
    return size;
  }
  return 70;
}
