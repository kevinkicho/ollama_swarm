/**
 * Optional structured envelope for peer reason validation in freeform
 * discussion (council, debate, RR). Parallel to ```mention``` but for
 * claim → challenge/validate → approve/deny semantics.
 *
 *   ```deliberate
 *   subject: draft-3 should land first
 *   claim: agent-2 has stronger evidence for the Tc bug
 *   stance: approve | deny | challenge | validate
 *   why: cites the exact unpacking bug and a test path
 *   evidence: scripts/predict_tc.py
 *   to: agent-1   # optional addressee
 *   ```
 */

export type DeliberateStance = "approve" | "deny" | "challenge" | "validate";

export interface DeliberateEnvelope {
  subject: string;
  claim: string;
  stance: DeliberateStance;
  why: string;
  evidence: string[];
  to?: string;
  fromAgentIndex?: number;
}

const DELIBERATE_FENCE_RE = /```deliberate\s*\n([\s\S]*?)\n```/g;

export function parseDeliberateEnvelopes(text: string): DeliberateEnvelope[] {
  const out: DeliberateEnvelope[] = [];
  for (const match of text.matchAll(DELIBERATE_FENCE_RE)) {
    const env = envelopeFromFields(parseFields(match[1] ?? ""));
    if (env) out.push(env);
  }
  // RR-E: also accept JSON ballots (vote-mode structured disposition).
  for (const env of parseJsonDeliberationBallots(text)) {
    out.push(env);
  }
  return out;
}

/** Structured vote ballot JSON (optional alternative to ```deliberate fences). */
export function parseJsonDeliberationBallots(text: string): DeliberateEnvelope[] {
  const out: DeliberateEnvelope[] = [];
  const fenced = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n```/gi)];
  const bodies = fenced.map((m) => m[1]!).concat(text);
  for (const body of bodies) {
    const t = body.trim();
    if (!t.startsWith("{") && !t.startsWith("[")) continue;
    try {
      const parsed = JSON.parse(t) as unknown;
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        if (!item || typeof item !== "object") continue;
        const o = item as Record<string, unknown>;
        // Ballot shape: { disposition, rationale, subject?, claim?, evidence? }
        const disposition = String(o.disposition ?? o.stance ?? "").toLowerCase();
        const stance = normalizeStance(disposition);
        if (!stance) continue;
        const subject = String(o.subject ?? o.topic ?? "ballot").trim();
        const claim = String(o.claim ?? o.rationale ?? o.why ?? "").trim();
        if (!claim) continue;
        const evidenceRaw = o.evidence;
        const evidence = Array.isArray(evidenceRaw)
          ? evidenceRaw.map((x) => String(x).trim()).filter(Boolean)
          : String(evidenceRaw ?? "")
              .split(/[,;\n]/)
              .map((s) => s.trim())
              .filter(Boolean);
        out.push({
          subject,
          claim,
          stance,
          why: String(o.why ?? o.rationale ?? claim).trim(),
          evidence,
          to: o.to ? String(o.to).trim() : undefined,
        });
      }
    } catch {
      /* not JSON */
    }
  }
  return out;
}

function envelopeFromFields(fields: Record<string, string>): DeliberateEnvelope | null {
  const subject = fields.subject?.trim() ?? "";
  const claim = fields.claim?.trim() ?? fields.reason?.trim() ?? "";
  const stanceRaw = (fields.stance ?? fields.verdict ?? "").trim().toLowerCase();
  const stance = normalizeStance(stanceRaw);
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

function normalizeStance(raw: string): DeliberateStance | null {
  if (raw === "approve" || raw === "accept" || raw === "yes") return "approve";
  if (raw === "deny" || raw === "reject" || raw === "no") return "deny";
  if (raw === "challenge" || raw === "dispute") return "challenge";
  if (raw === "validate" || raw === "valid" || raw === "sound") return "validate";
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

/** Instruction block for peer discussion agents. */
export function buildDeliberationProtocolInstructionBlock(): string {
  return [
    "=== Peer deliberation protocol ===",
    "When you evaluate a peer's draft or claim, emit a structured verdict (prefer one of):",
    "1) Fence form:",
    "```deliberate",
    "subject: <what is decided — draft, fix, criterion>",
    "claim: <their reason in one sentence>",
    "stance: approve | deny | challenge | validate",
    "why: <your validation reason — evidence-based>",
    "evidence: <optional file or quote pointers, comma-separated>",
    "to: agent-N   # optional",
    "```",
    "2) JSON ballot (vote / structured reconcile modes):",
    '{"disposition":"approve|deny|challenge|validate","rationale":"<why>","subject":"<topic>","claim":"<claim>","evidence":["path"]}',
    "approve = ship/accept; deny = reject; validate = reason is sound (not final ship);",
    "challenge = dispute the reason and demand better evidence.",
    "Higher-up roles (auditor/planner) still make final hierarchy approve/deny on commits.",
    "=== end deliberation protocol ===",
  ].join("\n");
}

export function injectDeliberationProtocolIntoPrompt(
  prompt: string,
  opts?: { includeInstruction?: boolean },
): string {
  if (opts?.includeInstruction === false) return prompt;
  return `${buildDeliberationProtocolInstructionBlock()}\n\n${prompt}`;
}
