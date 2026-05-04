// T199 (2026-05-04): LLM-driven dynamic role catalog for role-diff.
//
// Replaces the keyword-table thin-cut from T198b with a proper planner
// pass: ask an agent (typically agent-1) to read the directive +
// repo structure + propose 4-7 specialist roles tailored to the
// actual work. Returns null on parse failure / empty response /
// agent error so the caller falls back to BUILD_ROLES gracefully.
//
// Output contract (planner emits JSON only, no fences):
//   { "roles": [
//       { "name": "Auth specialist",
//         "guidance": "Auth flows, session management, token handling…",
//         "deliverableHint": "Cite the specific token/cookie/middleware…" },
//       ...
//     ] }
//
// Validation:
//   - roles must be 3-8 items (smaller = no specialization win;
//     larger = wraps past agentCount-8 anyway)
//   - each role.name <= 60 chars (catalog display constraint)
//   - each role.guidance + deliverableHint trimmed to 600 chars
//     (prompt-budget guard)
//   - duplicate names dropped (case-insensitive)
//
// Failure modes (all return null, caller falls back):
//   - agent error (network / abort / quota wall)
//   - empty response
//   - JSON parse failure
//   - schema validation failure (wrong field names, non-array, etc.)
//   - < 3 valid roles after dedup + length checks

import type { Agent, AgentManager } from "../services/AgentManager.js";
import type { SwarmRole } from "./roles.js";
import { promptWithRetry } from "./promptWithRetry.js";
import { extractText } from "./extractText.js";
import { describeSdkError } from "./sdkError.js";

const MAX_ROLES_FROM_LLM = 8;
const MIN_ROLES_FROM_LLM = 3;
const MAX_NAME_CHARS = 60;
const MAX_GUIDANCE_CHARS = 600;

export interface DynamicRoleCatalogInput {
  agent: Agent;
  manager: AgentManager;
  /** The user's directive (must be non-empty — caller's responsibility). */
  directive: string;
  /** Repo top-level entries to give the planner some grounding. */
  topLevel: readonly string[];
  /** README excerpt (first ~2000 chars). Empty when no README. */
  readmeExcerpt?: string;
}

export async function deriveDynamicRoleCatalog(
  input: DynamicRoleCatalogInput,
): Promise<SwarmRole[] | null> {
  const prompt = buildRoleCatalogPrompt(input);
  let raw: string;
  try {
    const ctrl = new AbortController();
    const result = (await promptWithRetry(input.agent, prompt, {
      signal: ctrl.signal,
      manager: input.manager,
      agentName: "swarm-read",
      describeError: (e) => describeSdkError(e),
    })) as { data?: { parts?: Array<{ type: string; text: string }> } };
    raw = result.data?.parts?.find((p) => p.type === "text")?.text ?? "";
  } catch {
    return null;
  }
  if (!raw || raw.trim().length === 0) return null;
  const text = extractText(raw) ?? raw;
  return parseRoleCatalogResponse(text);
}

/** Pure prompt builder — exported for tests. */
export function buildRoleCatalogPrompt(input: DynamicRoleCatalogInput): string {
  const tree =
    input.topLevel.length > 0 ? input.topLevel.join(", ") : "(empty)";
  const readme = input.readmeExcerpt?.trim()
    ? input.readmeExcerpt.trim().slice(0, 2000)
    : "(no README excerpt available)";
  return [
    "You are picking the roles for a role-diff swarm. The user has a SPECIFIC directive; the team needs SPECIALIST roles tailored to that directive (not the generic 7-role catalog).",
    "",
    `=== DIRECTIVE ===`,
    input.directive,
    `=== END DIRECTIVE ===`,
    "",
    `=== REPO TOP-LEVEL ===`,
    tree,
    `=== END REPO TOP-LEVEL ===`,
    "",
    `=== README EXCERPT (first 2000 chars) ===`,
    readme,
    `=== END README ===`,
    "",
    "Propose 4-7 SPECIALIST roles. Each role should map to a different aspect of the directive's work — the team will execute IN PARALLEL with each role contributing one piece. Examples:",
    "  - Refactor auth → +Auth specialist, +Security reviewer, +Migration planner, +Test coverage analyst",
    "  - Speed up search → +Performance profiler, +Index designer, +Caching strategist, +Benchmarking engineer",
    "  - Add a feature → +Researcher, +Designer, +Implementer, +Tester, +Documenter",
    "",
    "Output STRICT JSON only — no prose, no markdown fences:",
    '{"roles": [',
    '  {"name": "<role title, ≤60 chars>", "guidance": "<2-3 sentences telling the agent what to focus on>", "deliverableHint": "<1 sentence describing what their MY DELIVERABLE block must contain>"},',
    '  ...',
    "]}",
    "",
    "Rules:",
    "- 4-7 roles total (more wraps past the 8-agent cap; fewer doesn't justify the dynamic catalog).",
    "- Each role must be DIFFERENT from peers — no overlap.",
    "- Each role must clearly map to the directive — not generic ('Code reviewer' is too generic; 'Auth-flow code reviewer' is specific).",
    "- Use file paths from the repo top-level / README when relevant.",
    "- JSON only. No prose. No fences.",
  ].join("\n");
}

/** Pure parser — exported for tests. Returns null on any parse /
 *  schema failure so the caller can fall back to the static catalog. */
export function parseRoleCatalogResponse(raw: string): SwarmRole[] | null {
  // Tolerate fenced JSON + trailing prose.
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const candidate = fenceMatch ? fenceMatch[1] : raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    const braceMatch = candidate.match(/\{[\s\S]*\}/);
    if (!braceMatch) return null;
    try {
      parsed = JSON.parse(braceMatch[0]);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object") return null;
  const rolesRaw = (parsed as { roles?: unknown }).roles;
  if (!Array.isArray(rolesRaw)) return null;
  const out: SwarmRole[] = [];
  const seenNames = new Set<string>();
  for (const r of rolesRaw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const name = typeof o.name === "string" ? o.name.trim() : "";
    const guidance = typeof o.guidance === "string" ? o.guidance.trim() : "";
    const deliverableHint =
      typeof o.deliverableHint === "string" ? o.deliverableHint.trim() : "";
    if (name.length === 0 || name.length > MAX_NAME_CHARS) continue;
    if (guidance.length === 0) continue;
    const key = name.toLowerCase();
    if (seenNames.has(key)) continue;
    seenNames.add(key);
    out.push({
      name,
      guidance: guidance.slice(0, MAX_GUIDANCE_CHARS),
      ...(deliverableHint
        ? { deliverableHint: deliverableHint.slice(0, MAX_GUIDANCE_CHARS) }
        : {}),
    });
    if (out.length >= MAX_ROLES_FROM_LLM) break;
  }
  if (out.length < MIN_ROLES_FROM_LLM) return null;
  return out;
}
