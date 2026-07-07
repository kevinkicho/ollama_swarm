import { extractFirstBalanced } from "@ollama-swarm/shared/extractJson";

export interface CouncilIssue {
  issue: string;
  file?: string;
  severity?: "high" | "medium" | "low" | string;
  suggestion?: string;
}

export type ExecutionStatus = "done" | "failed" | "skipped" | "working" | "summary" | "other";

export interface ExecutionEvent {
  status: ExecutionStatus;
  agentId?: string;
  detail: string;
  raw: string;
}

export function parseCouncilIssues(text: string): CouncilIssue[] | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const jsonSlice = extractFirstBalanced(trimmed) ?? trimmed;
  try {
    const parsed = JSON.parse(jsonSlice) as unknown;
    if (!Array.isArray(parsed)) return null;
    const issues: CouncilIssue[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      const issue = typeof o.issue === "string" ? o.issue.trim() : "";
      if (!issue) continue;
      issues.push({
        issue,
        file: typeof o.file === "string" ? o.file : undefined,
        severity: typeof o.severity === "string" ? o.severity.toLowerCase() : undefined,
        suggestion: typeof o.suggestion === "string" ? o.suggestion : undefined,
      });
    }
    return issues.length > 0 ? issues : null;
  } catch {
    return null;
  }
}

export function parseExecutionLine(text: string): ExecutionEvent {
  const raw = text;
  const body = text.replace(/^\[execution\]\s*/i, "").trim();

  const completeMatch = /^Complete:\s*(\d+)\s*done,\s*(\d+)\s*failed,\s*(\d+)\s*skipped/i.exec(body);
  if (completeMatch) {
    return {
      status: "summary",
      detail: `${completeMatch[1]} done · ${completeMatch[2]} failed · ${completeMatch[3]} skipped`,
      raw,
    };
  }

  const agentMatch = /^(agent-\d+)/i.exec(body);
  const agentId = agentMatch?.[1];

  if (/skipped:/i.test(body)) {
    return { status: "skipped", agentId, detail: body.replace(/^agent-\d+\s+skipped:\s*/i, ""), raw };
  }
  if (/working on:/i.test(body)) {
    return { status: "working", agentId, detail: body.replace(/^agent-\d+\s+working on:\s*/i, ""), raw };
  }
  if (body.includes("✓") || /\bapplied\b/i.test(body)) {
    return { status: "done", agentId, detail: body, raw };
  }
  if (body.includes("✗") || /failed|parse failed|repair failed/i.test(body)) {
    return { status: "failed", agentId, detail: body, raw };
  }

  return { status: "other", agentId, detail: body, raw };
}

export function severityCounts(issues: CouncilIssue[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of issues) {
    const key = i.severity ?? "unknown";
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}