/**
 * Sentinel returned by JSON salvage when the model cannot reconstruct structured output.
 * Live UI used to show raw `{"_unparseable":true}` under agent bubbles — format this.
 */

export function isUnparseableSalvageJson(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  // Fast path: exact / near-exact sentinel
  if (/^\{\s*"_unparseable"\s*:\s*true\s*\}\s*$/i.test(t)) return true;
  try {
    const v = JSON.parse(t) as unknown;
    return (
      typeof v === "object"
      && v !== null
      && !Array.isArray(v)
      && (v as { _unparseable?: unknown })._unparseable === true
    );
  } catch {
    return false;
  }
}

export function formatUnparseableSalvageMessage(opts?: {
  kind?: string;
  parseError?: string;
}): string {
  const kind = opts?.kind?.trim() || "agent";
  const err = opts?.parseError?.trim();
  const lines = [
    "JSON salvage failed — prior output could not be reconstructed as structured data.",
    `Kind: ${kind}`,
  ];
  if (err) lines.push(`Parser: ${err.slice(0, 240)}`);
  lines.push(
    "What this means: the model (or a salvage pass) could not emit valid JSON for this step.",
    "Next: retry the step, use a stronger model, or reduce prompt size / tool noise.",
  );
  return lines.join("\n");
}
