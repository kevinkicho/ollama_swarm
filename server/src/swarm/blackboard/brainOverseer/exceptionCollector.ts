// Exception collector for the brain system overseer.
//
// Captures structured exception events from the existing event system.
// These are emitted by workers, replanner, auditor, and planner when
// things go wrong (declines, skips, empty responses, loops, etc.).

export interface ExceptionEvent {
  type: "brain_fallback" | "worker_declined" | "stale_todo" | "replan_skip"
      | "empty_response" | "loop_detected" | "degenerate_contract"
      | "auditor_override" | "retry_exhausted";
  agentId: string;
  todoId?: string;
  reason: string;
  timestamp: number;
  runId: string;
  context?: Record<string, unknown>;
}

export interface PatternFingerprint {
  type: string;
  reasonKey: string;
  component: string;
}

export function buildFingerprint(event: ExceptionEvent): string {
  // Normalize the reason to a key for deduplication
  const reasonKey = event.reason
    .slice(0, 100)
    .toLowerCase()
    .replace(/\d+/g, "#")  // Normalize numbers
    .replace(/\s+/g, " ")
    .trim();
  return `${event.type}|${reasonKey}`;
}

export class ExceptionCollector {
  private events: ExceptionEvent[] = [];
  private runId: string;

  constructor(runId: string) {
    this.runId = runId;
  }

  record(event: Omit<ExceptionEvent, "runId" | "timestamp">): void {
    this.events.push({
      ...event,
      runId: this.runId,
      timestamp: Date.now(),
    });
  }

  getRecent(n: number = 50): ExceptionEvent[] {
    return this.events.slice(-n);
  }

  getByType(type: ExceptionEvent["type"]): ExceptionEvent[] {
    return this.events.filter((e) => e.type === type);
  }

  getPatternSummary(): PatternSummary {
    const byType: Record<string, number> = {};
    const byFingerprint: Map<string, { count: number; events: ExceptionEvent[] }> = new Map();

    for (const event of this.events) {
      byType[event.type] = (byType[event.type] ?? 0) + 1;
      const fp = buildFingerprint(event);
      const existing = byFingerprint.get(fp);
      if (existing) {
        existing.count++;
        existing.events.push(event);
      } else {
        byFingerprint.set(fp, { count: 1, events: [event] });
      }
    }

    const recurringPatterns: PatternSummary["recurringPatterns"] = [];
    for (const [fingerprint, data] of byFingerprint) {
      if (data.count >= 2) {
        recurringPatterns.push({
          pattern: fingerprint,
          count: data.count,
          affectedTodos: [...new Set(data.events.map((e) => e.todoId).filter((id): id is string => id != null))],
          suggestedFix: "", // Brain fills this in during analysis
        });
      }
    }
    recurringPatterns.sort((a, b) => b.count - a.count);

    return {
      totalExceptions: this.events.length,
      byType,
      recurringPatterns,
    };
  }

  getAll(): ExceptionEvent[] {
    return [...this.events];
  }
}

export interface PatternSummary {
  totalExceptions: number;
  byType: Record<string, number>;
  recurringPatterns: Array<{
    pattern: string;
    count: number;
    affectedTodos: string[];
    suggestedFix: string;
  }>;
}
