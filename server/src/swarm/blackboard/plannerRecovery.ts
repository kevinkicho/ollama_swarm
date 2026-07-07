// Planner-owned structured emit recovery.
// Cascade: rule-based extract → explore/emit turns → auditor JSON salvage → sibling-retry.

import type { Agent } from "../../services/AgentManager.js";
import type { ProfileName } from "../../tools/ToolDispatcher.js";
import {
  extractJsonCandidate,
  formatParseTier,
} from "@ollama-swarm/shared/parseAgentJson";
import { interruptibleSleep } from "../interruptibleSleep.js";
import { runPlannerAuditorSalvage } from "./plannerAuditorAssist.js";

export const PLANNER_EMIT_MAX_ATTEMPTS = 8;
export const PLANNER_EMIT_PAUSE_BASE_MS = 12_000;

export type ParseAttemptResult<T> =
  | { ok: true; value: T; raw: string; dropped?: unknown[] }
  | { ok: false; reason: string; raw: string };

export interface PlannerEmitRecoveryOpts<T> {
  kind: "contract" | "planner-todos";
  agent: Agent;
  auditor?: Agent;
  getStopping: () => boolean;
  appendSystem: (msg: string) => void;
  appendAgent: (
    agent: Agent,
    text: string,
    options?: { assistKind?: "auditor-salvage" },
  ) => void;
  findingsPost: (entry: { agentId: string; text: string; createdAt: number }) => void;
  emitActivity: (label: string, attempt: number, maxAttempts: number, mode: "explore" | "emit") => void;
  promptPlannerSafely: (
    agent: Agent,
    promptText: string,
    agentName: ProfileName,
    ollamaFormat?: "json" | Record<string, unknown>,
  ) => Promise<{ response: string; agentUsed: Agent }>;
  buildExplorePrompt: () => string;
  buildRepairPrompt: (previousResponse: string, parseError: string, auditorNote?: string) => string;
  exploreProfile: ProfileName;
  emitProfile: ProfileName;
  jsonSchema: Record<string, unknown>;
  parse: (raw: string) => ParseAttemptResult<T>;
  getActive: () => { dedicatedAuditor?: boolean } | undefined;
  maxAttempts?: number;
}

function responseExcerpt(raw: string, max = 8000): string {
  const t = raw.trim();
  return t.length <= max ? t : t.slice(0, max - 3) + "...";
}

function tryParseWithRuleBasedExtract<T>(
  raw: string,
  parse: (r: string) => ParseAttemptResult<T>,
  appendSystem: (msg: string) => void,
  agentId: string,
  kind: string,
): ParseAttemptResult<T> {
  const direct = parse(raw);
  if (direct.ok) return direct;

  const candidate = extractJsonCandidate(raw);
  if (!candidate) return direct;

  const salvaged = parse(candidate.json);
  if (salvaged.ok) {
    appendSystem(
      `[${agentId}] ${kind} rule-based JSON extract (${formatParseTier(candidate.tier)}) succeeded.`,
    );
    return salvaged;
  }
  return direct;
}

/** Pause between planner emit attempts (no wall-clock cap on a single turn). */
export async function pauseBetweenPlannerAttempts(
  attempt: number,
  getStopping: () => boolean,
): Promise<void> {
  if (attempt <= 1 || getStopping()) return;
  const ms = PLANNER_EMIT_PAUSE_BASE_MS * Math.min(attempt - 1, 5);
  const controller = new AbortController();
  await interruptibleSleep(ms, controller.signal);
}

export async function runPlannerEmitRecovery<T>(
  opts: PlannerEmitRecoveryOpts<T>,
): Promise<
  | { ok: true; value: T; raw: string; dropped: unknown[] }
  | { ok: false; reason: string; lastRaw: string }
> {
  const maxAttempts = opts.maxAttempts ?? PLANNER_EMIT_MAX_ATTEMPTS;
  let lastRaw = "";
  let lastReason = "no attempts";
  let exploreResponse = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (opts.getStopping()) {
      return { ok: false, reason: "run stopping", lastRaw };
    }

    await pauseBetweenPlannerAttempts(attempt, opts.getStopping);

    if (attempt >= 3 && attempt % 2 === 1 && opts.auditor) {
      const salvagedJson = await runPlannerAuditorSalvage(
        opts.auditor,
        {
          getStopping: opts.getStopping,
          appendSystem: opts.appendSystem,
          appendAgent: opts.appendAgent,
          findingsPost: opts.findingsPost,
          promptPlannerSafely: (a, p, n, schema) => opts.promptPlannerSafely(a, p, n!, schema),
          getActive: opts.getActive,
        },
        {
          kind: opts.kind,
          parseError: lastReason,
          responseExcerpt: lastRaw || exploreResponse,
          attempt,
          jsonSchema: opts.jsonSchema,
        },
      );
      if (salvagedJson) {
        const salvaged = opts.parse(salvagedJson);
        if (salvaged.ok) {
          opts.appendSystem(
            `[${opts.agent.id}] ${opts.kind} auditor salvage parsed successfully on attempt ${attempt}/${maxAttempts}.`,
          );
          return {
            ok: true,
            value: salvaged.value,
            raw: salvagedJson,
            dropped: (salvaged.dropped as unknown[]) ?? [],
          };
        }
        lastReason = salvaged.reason;
        lastRaw = salvagedJson;
      }
    }

    const useEmitOnly = attempt >= 2 && attempt % 2 === 0;
    const mode: "explore" | "emit" = useEmitOnly ? "emit" : "explore";
    const profile = useEmitOnly ? opts.emitProfile : opts.exploreProfile;
    const label = useEmitOnly
      ? `${opts.kind} emit-only retry`
      : `${opts.kind} derivation`;

    opts.emitActivity(label, attempt, maxAttempts, mode);
    opts.appendSystem(
      `[${opts.agent.id}] ${label} — attempt ${attempt}/${maxAttempts}${useEmitOnly ? " (JSON only, no tools)" : ""}`,
    );

    const prompt = useEmitOnly
      ? opts.buildRepairPrompt(lastRaw || exploreResponse, lastReason)
      : attempt === 1
        ? opts.buildExplorePrompt()
        : opts.buildRepairPrompt(lastRaw || exploreResponse, lastReason);

    const { response, agentUsed } = await opts.promptPlannerSafely(
      opts.agent,
      prompt,
      profile,
      useEmitOnly ? opts.jsonSchema : undefined,
    );
    if (opts.getStopping()) return { ok: false, reason: "run stopping", lastRaw: response };

    opts.appendAgent(agentUsed, response);
    if (!useEmitOnly) exploreResponse = response;
    lastRaw = response;

    const parsed = tryParseWithRuleBasedExtract(
      response,
      opts.parse,
      opts.appendSystem,
      opts.agent.id,
      opts.kind,
    );
    if (parsed.ok) {
      opts.appendSystem(
        `[${opts.agent.id}] ${opts.kind} parsed successfully on attempt ${attempt}/${maxAttempts}.`,
      );
      return {
        ok: true,
        value: parsed.value,
        raw: response,
        dropped: (parsed.dropped as unknown[]) ?? [],
      };
    }

    lastReason = parsed.reason;
    if (!useEmitOnly) {
      opts.appendSystem(
        `[${opts.agent.id}] ${opts.kind} explore complete (attempt ${attempt}/${maxAttempts}) — structured emit pending.`,
      );
      continue;
    }
    opts.appendSystem(
      `[${opts.agent.id}] ${opts.kind} parse failed (attempt ${attempt}/${maxAttempts}): ${parsed.reason}`,
    );
  }

  opts.appendSystem(
    `[${opts.agent.id}] ${opts.kind} emit exhausted ${maxAttempts} attempts — last error: ${lastReason}`,
  );
  opts.findingsPost({
    agentId: opts.agent.id,
    text: `Planner ${opts.kind} failed after ${maxAttempts} attempts. Last error: ${lastReason}. Response excerpt: ${responseExcerpt(lastRaw, 1500)}`,
    createdAt: Date.now(),
  });

  return { ok: false, reason: lastReason, lastRaw };
}