import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  DeliberationLayer,
  DeliberationSink,
  DeliberationTransaction,
  DeliberationVerdict,
} from "./deliberationTypes.js";

export type { DeliberationTransaction, DeliberationSink } from "./deliberationTypes.js";

export interface RecordDeliberationInput {
  runId: string;
  layer: DeliberationLayer;
  subject: string;
  claim: string;
  proposer: string;
  verdict: DeliberationVerdict;
  preset?: string;
  validator?: string;
  validationReason?: string;
  evidence?: string[];
  related?: DeliberationTransaction["related"];
  ts?: number;
  id?: string;
}

/** Build a complete transaction row (pure). */
export function buildDeliberationTransaction(
  input: RecordDeliberationInput,
): DeliberationTransaction {
  return {
    id: input.id ?? randomUUID(),
    ts: input.ts ?? Date.now(),
    runId: input.runId,
    layer: input.layer,
    preset: input.preset,
    subject: input.subject.slice(0, 400),
    claim: input.claim.slice(0, 800),
    proposer: input.proposer.slice(0, 80),
    validator: input.validator?.slice(0, 80),
    verdict: input.verdict,
    validationReason: input.validationReason?.slice(0, 800),
    evidence: input.evidence?.slice(0, 20).map((e) => e.slice(0, 200)),
    related: input.related,
    schemaVersion: 1,
  };
}

/** One-line transcript form for operators. */
export function formatDeliberationTranscriptLine(tx: DeliberationTransaction): string {
  const v = tx.verdict.toUpperCase();
  const who = tx.validator ? `${tx.proposer} → ${tx.validator}` : tx.proposer;
  const why = tx.validationReason
    ? ` — ${tx.validationReason.slice(0, 160)}`
    : tx.claim
      ? ` — ${tx.claim.slice(0, 160)}`
      : "";
  return `[deliberation:${tx.layer}] ${v} · ${who} · ${tx.subject.slice(0, 80)}${why}`;
}

/**
 * Record a deliberation transaction to:
 *   1. transcript (system line)
 *   2. WS event `deliberation_transaction`
 *   3. debug logDiag
 *   4. durable JSONL under clone logs (best-effort)
 */
export async function recordDeliberation(
  input: RecordDeliberationInput,
  sink: DeliberationSink = {},
): Promise<DeliberationTransaction> {
  const tx = buildDeliberationTransaction({
    ...input,
    runId: input.runId || sink.runId || "unknown",
  });

  const line = formatDeliberationTranscriptLine(tx);
  try {
    sink.appendSystem?.(line);
  } catch {
    /* non-fatal */
  }

  try {
    sink.emit?.({ type: "deliberation_transaction", transaction: tx });
  } catch {
    /* non-fatal */
  }

  try {
    sink.logDiag?.({
      type: "deliberation_transaction",
      ...tx,
    });
  } catch {
    /* non-fatal */
  }

  const clone = sink.clonePath?.trim();
  const runId = tx.runId;
  if (clone && runId && runId !== "unknown") {
    try {
      await appendDeliberationJsonl(clone, runId, tx);
    } catch {
      /* disk best-effort */
    }
  }

  return tx;
}

/** Fire-and-forget wrapper for hot paths that shouldn't await disk. */
export function recordDeliberationAsync(
  input: RecordDeliberationInput,
  sink: DeliberationSink = {},
): void {
  void recordDeliberation(input, sink).catch(() => {
    /* swallow */
  });
}

export async function appendDeliberationJsonl(
  clonePath: string,
  runId: string,
  tx: DeliberationTransaction,
): Promise<string> {
  const dir = path.join(clonePath, "logs", runId);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, "deliberation.jsonl");
  await fs.appendFile(file, JSON.stringify(tx) + "\n", "utf8");
  // Also mirror under short run id prefix for easier discovery (same as summaries).
  const short = runId.slice(0, 8);
  if (short !== runId) {
    const shortDir = path.join(clonePath, "logs", short);
    try {
      await fs.mkdir(shortDir, { recursive: true });
      await fs.appendFile(path.join(shortDir, "deliberation.jsonl"), JSON.stringify(tx) + "\n", "utf8");
    } catch {
      /* ignore short mirror */
    }
  }
  return file;
}

/** Compact tail for embedding in summary.json (dissemination without full JSONL). */
export async function loadDeliberationForSummary(
  clonePath: string | undefined,
  runId: string | undefined,
  limit = 40,
): Promise<
  Array<{
    ts: number;
    layer: string;
    verdict: string;
    subject: string;
    claim?: string;
    validationReason?: string;
    proposer?: string;
    validator?: string;
  }>
> {
  if (!clonePath || !runId) return [];
  const rows = await readDeliberationLog(clonePath, runId);
  return rows.slice(-limit).map((tx) => ({
    ts: tx.ts,
    layer: tx.layer,
    verdict: tx.verdict,
    subject: tx.subject,
    ...(tx.claim ? { claim: tx.claim.slice(0, 240) } : {}),
    ...(tx.validationReason ? { validationReason: tx.validationReason.slice(0, 240) } : {}),
    ...(tx.proposer ? { proposer: tx.proposer } : {}),
    ...(tx.validator ? { validator: tx.validator } : {}),
  }));
}

/** Read all deliberation rows for a run (for export / post-run dissemination). */
export async function readDeliberationLog(
  clonePath: string,
  runId: string,
): Promise<DeliberationTransaction[]> {
  const candidates = [
    path.join(clonePath, "logs", runId, "deliberation.jsonl"),
    path.join(clonePath, "logs", runId.slice(0, 8), "deliberation.jsonl"),
  ];
  for (const file of candidates) {
    try {
      const raw = await fs.readFile(file, "utf8");
      const rows: DeliberationTransaction[] = [];
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          rows.push(JSON.parse(line) as DeliberationTransaction);
        } catch {
          /* skip bad line */
        }
      }
      if (rows.length) return rows;
    } catch {
      /* try next */
    }
  }
  return [];
}
