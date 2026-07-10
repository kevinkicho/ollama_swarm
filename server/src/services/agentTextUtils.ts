// Pure text helpers used by AgentManager (extracted for modularity).

/**
 * Robust error-to-string that handles non-Error throwables (plain
 * objects like { data: {...} } that the OpenCode SDK can throw when
 * throwOnError=true). Falls back through: Error.message → .name +
 * .message → JSON.stringify → String. Without this, concurrent-spawn
 * races surface in the UI as "[object Object]" — useless for debugging.
 */
export function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object") {
    const o = err as { name?: string; message?: string; code?: string };
    const head = o.name ? `${o.name}: ` : "";
    if (o.message) return head + o.message;
    try {
      return head + JSON.stringify(err).slice(0, 500);
    } catch {
      return head + String(err);
    }
  }
  return String(err);
}

/**
 * Pull the latest ASSISTANT message's concatenated text-part content from a
 * session.messages response. Used by probeAndDecide to check whether the model
 * is still producing tokens when SSE goes quiet. Returns null if no assistant
 * message exists yet (early in the call).
 */
export function extractLatestAssistantText(res: unknown): string | null {
  // Shape: { data: Array<{ info: Message, parts: Part[] }> } per SDK gen
  // — but the SDK wrapper sometimes returns the array directly. Handle both.
  const wrapper = res as { data?: unknown };
  const list = (wrapper?.data ?? res) as Array<{
    info?: { role?: string };
    parts?: Array<{ type?: string; text?: string }>;
  }>;
  if (!Array.isArray(list)) return null;
  // Find LAST assistant message (most recent).
  for (let i = list.length - 1; i >= 0; i--) {
    const msg = list[i];
    if (msg?.info?.role !== "assistant") continue;
    const parts = msg.parts ?? [];
    let combined = "";
    for (const p of parts) {
      if (p?.type === "text" && typeof p.text === "string") combined += p.text;
    }
    return combined;
  }
  return null;
}
