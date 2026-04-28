// V2 cutover Phase 2c-pre (2026-04-28): Findings extracted out of
// Board so the V2 TodoQueue doesn't need to absorb diagnostic-note
// responsibility. Findings are append-only diagnostic notes the
// auditor + replanner emit (e.g., "todo X failed because anchor
// missing in file Y") — they belong with logging, not with todo
// state machine.
//
// API mirrors the old Board methods (post + list) so callers can
// be migrated in a single search-replace pass.

import { randomUUID } from "node:crypto";
import type { Finding } from "./types.js";

export interface FindingsLogOpts {
  /** Optional id generator (deterministic in tests). */
  genId?: () => string;
}

export class FindingsLog {
  private readonly findings = new Map<string, Finding>();
  private readonly genId: () => string;

  constructor(opts: FindingsLogOpts = {}) {
    this.genId = opts.genId ?? randomUUID;
  }

  /** Append a diagnostic note. Returns a defensive copy. Throws if
   *  text is whitespace-only — diagnostic notes must say something. */
  post(input: { agentId: string; text: string; createdAt: number }): Finding {
    if (!input.text.trim()) throw new Error("finding text cannot be empty");
    const finding: Finding = {
      id: this.genId(),
      agentId: input.agentId,
      text: input.text,
      createdAt: input.createdAt,
    };
    this.findings.set(finding.id, finding);
    return { ...finding };
  }

  /** All findings in insertion order. Returns defensive copies so
   *  callers can't mutate internal state through them. */
  list(): Finding[] {
    return [...this.findings.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((f) => ({ ...f }));
  }

  /** Reset the log. Used at run-start so each run gets a clean slate. */
  clear(): void {
    this.findings.clear();
  }
}
