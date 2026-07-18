/**
 * Client-side ```deliberate fence parser for council draft bubbles.
 * Mirrors server deliberationProtocol shape without importing server code.
 */

export type DeliberateStance = "approve" | "deny" | "challenge" | "validate";

export interface DeliberateEnvelope {
  subject: string;
  claim: string;
  stance: DeliberateStance;
  why: string;
  evidence: string[];
  to?: string;
}

const DELIBERATE_FENCE_RE = /```deliberate\s*\n([\s\S]*?)\n```/gi;

function normalizeStance(raw: string): DeliberateStance | null {
  const s = raw.trim().toLowerCase();
  if (s === "approve" || s === "accept" || s === "yes") return "approve";
  if (s === "deny" || s === "reject" || s === "no") return "deny";
  if (s === "challenge" || s === "dispute") return "challenge";
  if (s === "validate" || s === "valid" || s === "sound") return "validate";
  return null;
}

function parseFields(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of body.split(/\r?\n/)) {
    const m = /^\s*([a-zA-Z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    out[m[1]!.toLowerCase()] = m[2]!;
  }
  return out;
}

function envelopeFromFields(fields: Record<string, string>): DeliberateEnvelope | null {
  const subject = fields.subject?.trim() ?? "";
  const claim = fields.claim?.trim() ?? fields.reason?.trim() ?? "";
  const stance = normalizeStance(fields.stance ?? fields.verdict ?? "");
  if (!subject || !claim || !stance) return null;
  const evidence = (fields.evidence ?? "")
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    subject,
    claim,
    stance,
    why: (fields.why ?? fields.rationale ?? "").trim(),
    evidence,
    to: fields.to?.trim() || undefined,
  };
}

/** Parse ```deliberate … ``` fences from agent text. */
export function parseDeliberateEnvelopes(text: string): DeliberateEnvelope[] {
  const out: DeliberateEnvelope[] = [];
  for (const match of text.matchAll(DELIBERATE_FENCE_RE)) {
    const env = envelopeFromFields(parseFields(match[1] ?? ""));
    if (env) out.push(env);
  }
  // Unclosed fence (stream truncated) — last ```deliberate to EOF
  if (out.length === 0) {
    const open = /```deliberate\s*\n([\s\S]+)$/i.exec(text.trim());
    if (open) {
      const env = envelopeFromFields(parseFields(open[1] ?? ""));
      if (env) out.push(env);
    }
  }
  return out;
}

export function stanceChipClass(stance: DeliberateStance): string {
  switch (stance) {
    case "approve":
    case "validate":
      return "bg-emerald-900/40 text-emerald-300 border-emerald-800/50";
    case "deny":
      return "bg-rose-900/40 text-rose-300 border-rose-800/50";
    case "challenge":
      return "bg-amber-900/40 text-amber-300 border-amber-800/50";
  }
}
