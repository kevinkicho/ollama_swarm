import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { TranscriptEntry } from "../types.js";
import { councilRunIdShort } from "./councilExecutionResume.js";
import { parseStandupIssues } from "./councilStandupFallback.js";

export const LEDGER_SCHEMA_VERSION = 1 as const;
export const LEDGER_MAX_OBSERVATIONS = 120;

export type LedgerObservationKind =
  | "finding"
  | "commit"
  | "skip"
  | "fail"
  | "synthesis"
  | "note";

export interface LedgerObservation {
  kind: LedgerObservationKind;
  text: string;
  cycle: number;
  at: number;
  agentId?: string;
  files?: string[];
}

export interface CouncilProgressLedger {
  schemaVersion: typeof LEDGER_SCHEMA_VERSION;
  runId: string;
  updatedAt: number;
  lastCycle: number;
  observations: LedgerObservation[];
}

export function createEmptyLedger(runId: string): CouncilProgressLedger {
  return {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    runId,
    updatedAt: Date.now(),
    lastCycle: 0,
    observations: [],
  };
}

export function ledgerFilePath(clonePath: string, runId: string): string {
  return path.join(clonePath, "logs", councilRunIdShort(runId), "progress-ledger.json");
}

export function loadCouncilProgressLedger(
  clonePath: string,
  runId: string,
): CouncilProgressLedger {
  const file = ledgerFilePath(clonePath, runId);
  if (!existsSync(file)) return createEmptyLedger(runId);
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as CouncilProgressLedger;
    if (raw?.schemaVersion !== LEDGER_SCHEMA_VERSION || raw.runId !== runId) {
      return createEmptyLedger(runId);
    }
    if (!Array.isArray(raw.observations)) raw.observations = [];
    return raw;
  } catch {
    return createEmptyLedger(runId);
  }
}

export function saveCouncilProgressLedger(
  clonePath: string,
  ledger: CouncilProgressLedger,
): void {
  const file = ledgerFilePath(clonePath, ledger.runId);
  mkdirSync(path.dirname(file), { recursive: true });
  ledger.updatedAt = Date.now();
  writeFileSync(file, JSON.stringify(ledger, null, 2), "utf8");
}

export function appendLedgerObservation(
  ledger: CouncilProgressLedger,
  obs: Omit<LedgerObservation, "at"> & { at?: number },
): void {
  ledger.observations.push({
    ...obs,
    at: obs.at ?? Date.now(),
  });
  if (ledger.observations.length > LEDGER_MAX_OBSERVATIONS) {
    ledger.observations = ledger.observations.slice(-LEDGER_MAX_OBSERVATIONS);
  }
}

/** Harvest standup issue JSON from agent drafts in a transcript slice. */
export function harvestStandupFindingsFromEntries(
  ledger: CouncilProgressLedger,
  cycle: number,
  entries: readonly TranscriptEntry[],
): number {
  let n = 0;
  for (const e of entries) {
    if (e.role !== "agent") continue;
    if (e.summary?.kind !== "council_draft") continue;
    if ((e.summary as { phase?: string }).phase !== "standup") continue;
    const issues = parseStandupIssues(e.text ?? "");
    if (!issues?.length) continue;
    for (const issue of issues) {
      const text = [issue.issue, issue.suggestion].filter(Boolean).join(" — ");
      appendLedgerObservation(ledger, {
        kind: "finding",
        text: text.slice(0, 400),
        cycle,
        agentId: e.agentId,
        files: issue.file ? [issue.file] : undefined,
      });
      n++;
    }
  }
  return n;
}

/** Record execution transcript lines as neutral observations (no routing). */
export function ingestExecutionTranscriptLines(
  ledger: CouncilProgressLedger,
  cycle: number,
  lines: readonly string[],
): void {
  for (const line of lines) {
    if (!line.startsWith("[execution]")) continue;
    const body = line.replace(/^\[execution\]\s*/i, "").trim();
    if (/^Complete:/i.test(body)) continue;
    if (/working on:/i.test(body)) continue;

    let kind: LedgerObservationKind = "note";
    let agentId: string | undefined;
    const agentMatch = /^(agent-\d+)/i.exec(body);
    if (agentMatch) agentId = agentMatch[1];

    if (/skipped:/i.test(body)) kind = "skip";
    else if (/✓|applied/i.test(body)) kind = "commit";
    else if (/failed|parse failed|repair failed|error:/i.test(body)) kind = "fail";
    else if (/Synthesized/i.test(body)) kind = "synthesis";

    appendLedgerObservation(ledger, {
      kind,
      text: body.slice(0, 400),
      cycle,
      agentId,
    });
  }
}

/**
 * Neutral, factual context for agents — shared progress, not instructions.
 * Agents decide how to use it.
 */
export function buildProgressContextBlock(
  ledger: CouncilProgressLedger,
  opts: { maxChars?: number } = {},
): string {
  const maxChars = opts.maxChars ?? 3500;
  if (ledger.observations.length === 0) return "";

  const byKind = (k: LedgerObservationKind) =>
    ledger.observations.filter((o) => o.kind === k).slice(-12);

  const sections: string[] = [];
  const pushSection = (title: string, items: LedgerObservation[]) => {
    if (!items.length) return;
    const lines = items.map((o) => {
      const who = o.agentId ? `${o.agentId} ` : "";
      const files = o.files?.length ? ` [${o.files.join(", ")}]` : "";
      return `- (cycle ${o.cycle}) ${who}${o.text}${files}`;
    });
    sections.push(`${title}:\n${lines.join("\n")}`);
  };

  pushSection("Recent commits / applied work", byKind("commit"));
  pushSection("Recent skips (worker-reported)", byKind("skip"));
  pushSection("Recent failures (for awareness)", byKind("fail"));
  pushSection("Standup findings (from agents)", byKind("finding"));
  pushSection("Synthesis notes", byKind("synthesis"));

  const header = `Run ${councilRunIdShort(ledger.runId)} — shared progress through cycle ${ledger.lastCycle}.`;
  let out = [header, ...sections].join("\n\n");
  if (out.length > maxChars) {
    out = `${out.slice(0, maxChars - 20)}\n… (truncated)`;
  }
  return out;
}

export function wrapProgressContextForPrompt(context: string): string {
  const trimmed = context.trim();
  if (!trimmed) return "";
  return [
    "",
    "=== SHARED RUN PROGRESS (from prior cycles — informational) ===",
    trimmed,
    "=== END SHARED RUN PROGRESS ===",
    "",
  ].join("\n");
}