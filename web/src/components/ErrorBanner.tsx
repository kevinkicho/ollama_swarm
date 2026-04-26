import { useState } from "react";
import { useSwarm } from "../state/store";

// Topbar error banner — short summary inline, click "Details" for the
// full message + originating runId in a modal. Close button dismisses.
export function ErrorBanner({
  error,
}: {
  error: { message: string; runId?: string; ts: number };
}) {
  const dismissError = useSwarm((s) => s.dismissError);
  const currentRunId = useSwarm((s) => s.runId);
  const [showDetails, setShowDetails] = useState(false);
  const isStale = error.runId && currentRunId && error.runId !== currentRunId;
  // Trim long error strings inline; the full text lives in the modal.
  const shortMsg =
    error.message.length > 160
      ? `${error.message.slice(0, 159)}…`
      : error.message;
  return (
    <>
      <div className="px-6 py-2 bg-red-900/40 text-red-200 text-sm border-b border-red-900 flex items-center gap-3">
        {isStale ? (
          <span className="text-xs px-1.5 py-0.5 rounded bg-amber-900/60 text-amber-200 font-mono shrink-0">
            STALE
          </span>
        ) : null}
        <span className="flex-1 truncate" title={error.message}>
          {shortMsg}
        </span>
        <button
          type="button"
          onClick={() => setShowDetails(true)}
          className="text-xs px-2 py-0.5 rounded border border-red-700 hover:bg-red-900/60"
        >
          Details
        </button>
        <button
          type="button"
          onClick={dismissError}
          aria-label="Dismiss error"
          className="text-red-200 hover:text-white text-lg leading-none px-1"
        >
          ×
        </button>
      </div>
      {showDetails ? (
        <ErrorDetailsModal
          error={error}
          isStale={Boolean(isStale)}
          currentRunId={currentRunId}
          onClose={() => setShowDetails(false)}
          onDismiss={() => {
            dismissError();
            setShowDetails(false);
          }}
        />
      ) : null}
    </>
  );
}

function ErrorDetailsModal({
  error,
  isStale,
  currentRunId,
  onClose,
  onDismiss,
}: {
  error: { message: string; runId?: string; ts: number };
  isStale: boolean;
  currentRunId?: string;
  onClose: () => void;
  onDismiss: () => void;
}) {
  const when = new Date(error.ts).toLocaleString();
  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-ink-900 border border-red-800 rounded-lg max-w-2xl w-full p-5 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-red-200">Run error</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close details"
            className="text-ink-400 hover:text-white text-xl leading-none"
          >
            ×
          </button>
        </div>
        {isStale ? (
          <div className="text-xs px-3 py-2 rounded bg-amber-950/40 border border-amber-800/60 text-amber-200">
            This error is from a <strong>previous run</strong> ({error.runId?.slice(0, 8)})
            — not the run currently displayed
            {currentRunId ? ` (${currentRunId.slice(0, 8)})` : ""}. Safe to dismiss.
          </div>
        ) : null}
        <div className="text-xs text-ink-400 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono">
          <span>When:</span>
          <span className="text-ink-200">{when}</span>
          <span>Run:</span>
          <span className="text-ink-200">{error.runId ?? "(no runId at error time)"}</span>
        </div>
        <pre className="text-xs text-red-200 bg-black/40 border border-red-900/50 rounded p-3 max-h-72 overflow-auto whitespace-pre-wrap break-words">
          {error.message}
        </pre>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="text-sm px-3 py-1.5 rounded border border-ink-600 hover:bg-ink-800"
          >
            Close
          </button>
          <button
            type="button"
            onClick={onDismiss}
            className="text-sm px-3 py-1.5 rounded bg-red-900 border border-red-700 hover:bg-red-800 text-red-100"
          >
            Dismiss error
          </button>
        </div>
      </div>
    </div>
  );
}
