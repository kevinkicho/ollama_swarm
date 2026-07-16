// Parse agent thinking / explore text into readable prose + compact tool intents.
// DeepSeek models mix chain-of-thought prose with <function> XML blocks;
// this helper powers the transcript "Show thinking" panel.

import { extractToolCallMarkers } from "./extractToolCallMarkers.js";

export interface PseudoToolIntent {
  name: string;
  detail?: string;
  raw: string;
}

function shortenPath(path: string): string {
  const norm = path.replace(/\\/g, "/").trim();
  const parts = norm.split("/").filter(Boolean);
  if (parts.length <= 2) return norm;
  return parts.slice(-2).join("/");
}

/** Turn one raw pseudo-tool marker into a one-line intent label. */
export function summarizePseudoToolMarker(raw: string): PseudoToolIntent {
  const fnName =
    raw.match(/<function\s+name>([^<]+)<\/function\s*>/i)?.[1]?.trim() ??
    raw.match(/<function_name>([^<]+)<\/function_name>/i)?.[1]?.trim() ??
    // Shape B (run 9f449937): <function><name>read</name><parameters>…
    raw.match(/<name>([^<]+)<\/name>/i)?.[1]?.trim();
  if (fnName) {
    const path =
      raw.match(/<parameter\s+name=["']path["']>([^<]+)<\/parameter>/i)?.[1]?.trim() ??
      raw.match(/<parameter\s+name=["']file["']>([^<]+)<\/parameter>/i)?.[1]?.trim() ??
      raw.match(/"path"\s*:\s*"([^"]+)"/i)?.[1]?.trim() ??
      raw.match(/"file"\s*:\s*"([^"]+)"/i)?.[1]?.trim();
    const pattern =
      raw.match(/<parameter\s+name=["']pattern["']>([^<]+)<\/parameter>/i)?.[1]?.trim() ??
      raw.match(/"pattern"\s*:\s*"([^"]+)"/i)?.[1]?.trim();
    const detail = path ? shortenPath(path) : pattern ? `/${pattern}/` : undefined;
    return { name: fnName, detail, raw };
  }

  const opener = raw.match(/^<([a-z_]+)\b/i)?.[1]?.toLowerCase();
  if (opener) {
    const path =
      raw.match(/\bpath=["']([^"']+)["']/i)?.[1] ??
      raw.match(/>([^<]+)<\/\1>/i)?.[1]?.trim();
    return {
      name: opener,
      detail: path ? shortenPath(path) : undefined,
      raw,
    };
  }

  return { name: "tool", raw };
}

export function parseThinkingDisplay(text: string): {
  prose: string;
  intents: PseudoToolIntent[];
} {
  if (!text.trim()) return { prose: "", intents: [] };
  const { toolCalls, finalText } = extractToolCallMarkers(text);
  const intents = toolCalls.map(summarizePseudoToolMarker);
  return { prose: finalText.trim(), intents };
}