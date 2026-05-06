import { randomUUID } from "node:crypto";
import type { TranscriptEntry } from "../../types.js";
import { formatChatReceipt } from "../chatReceipt.js";
import type { TierContext } from "./tierRunner.js";
import { allCriteriaResolvedSnapshot as allCriteriaResolvedSnapshotExtracted } from "./tierRunner.js";

export interface UserInputHandlerContext {
  transcript: TranscriptEntry[];
  emit: (e: { type: string; [key: string]: unknown }) => void;
  appendSystem: (text: string, summary?: import("../../types.js").TranscriptEntrySummary) => void;
  tierContext: () => TierContext;
}

export function injectUser(
  ctx: UserInputHandlerContext,
  text: string,
  opts?: { intent?: "suggest" | "steer" | "ask"; targetAgent?: string },
): void {
  const intent = opts?.intent ?? "steer";
  const entry: TranscriptEntry = {
    id: randomUUID(),
    role: "user",
    text,
    ts: Date.now(),
    intent,
    ...(opts?.targetAgent ? { targetAgent: opts.targetAgent } : {}),
  };
  ctx.transcript.push(entry);
  ctx.emit({ type: "transcript_append", entry });
  ctx.appendSystem(formatChatReceipt(intent, opts?.targetAgent));
}

export function allCriteriaResolvedSnapshot(ctx: UserInputHandlerContext): boolean {
  return allCriteriaResolvedSnapshotExtracted(ctx.tierContext());
}