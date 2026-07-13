import type { DerivedRunState, EventCategory } from "../../lib/eventLogUi";

export interface RunSliceSummary {
  sliceIndex: number;
  derived: DerivedRunState;
  recordCount: number;
  isSessionBoundary: boolean;
  source?: "global" | "per-run-debug" | "archive-index";
}

export type DetailTarget = { runId?: string; sliceIndex: number };

export interface EventLogResponse {
  runs: RunSliceSummary[];
  malformed: number;
  sources: string[];
  totalRecords: number;
  /** Total runs before server limit/offset (when paginated). */
  total?: number;
  offset?: number;
  limit?: number;
  hasMore?: boolean;
  logDir?: string;
  eventLogPath?: string;
  archivesTotal?: number;
  archivesRead?: number;
  perRunDebugCount?: number;
}

export interface LoggedRecord {
  ts: number;
  event: { type: string } & Record<string, unknown>;
}

export interface RunDetailResponse {
  runId: string | null;
  sliceIndex?: number;
  derived: DerivedRunState;
  records: LoggedRecord[];
  /** Full record count before pagination. */
  totalRecords?: number;
  hasMoreOlder?: boolean;
  hasMoreNewer?: boolean;
  oldestTs?: number;
  newestTs?: number;
  limit?: number;
  isSessionBoundary: boolean;
  malformed: number;
  sources: string[];
  logDir?: string;
  debugLog?: { relativePath: string; bytes: number } | null;
}

export const CATEGORY_TABS: Array<{ id: "all" | EventCategory; label: string }> = [
  { id: "all", label: "all" },
  { id: "lifecycle", label: "lifecycle" },
  { id: "agent", label: "agent" },
  { id: "transcript", label: "transcript" },
  { id: "todo", label: "todo" },
  { id: "diag", label: "diag" },
  { id: "other", label: "other" },
];
