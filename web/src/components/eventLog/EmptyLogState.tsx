export function EmptyLogState({
  logDir,
  eventLogPath,
}: {
  logDir?: string;
  eventLogPath?: string;
}) {
  return (
    <div className="space-y-2.5 text-xs text-ink-400 leading-relaxed">
      <p className="text-ink-200 font-medium">No events recorded yet</p>
      <p>
        Start a run and events append to{" "}
        <code className="font-mono text-[10px] bg-ink-800 px-1 py-0.5 rounded text-ink-300">
          logs/current.jsonl
        </code>
        . This panel shows the raw broadcast stream — live runs appear here before{" "}
        <span className="text-ink-300">Runs</span> has a summary.
      </p>
      {eventLogPath ? (
        <p className="text-[10px] text-ink-500 font-mono break-all">path: {eventLogPath}</p>
      ) : logDir ? (
        <p className="text-[10px] text-ink-500 font-mono break-all">log dir: {logDir}</p>
      ) : null}
    </div>
  );
}
