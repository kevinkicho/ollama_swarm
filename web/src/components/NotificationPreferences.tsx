import React, { useState, useEffect } from "react";
import { notificationService } from "../services/notificationService";

type RunStatus = "all" | "success" | "failure" | "running";

export function NotificationPreferences() {
  const [enabled, setEnabled] = useState(() => notificationService.getPreferences().enabled);
  const [statusFilter, setStatusFilter] = useState<RunStatus>("all");

  // Sync enabled state with the notification service
  useEffect(() => {
    notificationService.setPreferences({ enabled });
  }, [enabled]);

  return (
    <div className="rounded border border-ink-700 bg-ink-800 p-3 space-y-2">
      <div className="text-[10px] uppercase tracking-wider text-ink-500 font-semibold">
        Notification Preferences
      </div>

      <label className="flex items-center gap-2 text-xs cursor-pointer select-none">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="w-3 h-3 accent-emerald-400"
        />
        <span className="text-ink-200">Enable notifications</span>
      </label>

      <div className="space-y-1">
        <div className="text-[10px] text-ink-500">Filter by run status:</div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as RunStatus)}
          className="text-[10px] bg-ink-900 border border-ink-700 rounded px-1.5 py-0.5 text-ink-200 w-full focus:outline-none focus:border-ink-500"
        >
          <option value="all">All</option>
          <option value="success">Success</option>
          <option value="failure">Failure</option>
          <option value="running">Running</option>
        </select>
      </div>
    </div>
  );
}
