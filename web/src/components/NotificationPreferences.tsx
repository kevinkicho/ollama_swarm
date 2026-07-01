import React, { useState } from 'react';

type RunStatus = 'all' | 'success' | 'failure' | 'running';

const NotificationPreferences: React.FC = () => {
  const [enabled, setEnabled] = useState(true);
  const [statusFilter, setStatusFilter] = useState<RunStatus>('all');

  return (
    <div>
      <h2>Notification Preferences</h2>
      <label>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        Enable notifications
      </label>
      <div>
        <label>Filter by run status:</label>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as RunStatus)}
        >
          <option value="all">All</option>
          <option value="success">Success</option>
          <option value="failure">Failure</option>
          <option value="running">Running</option>
        </select>
      </div>
    </div>
  );
};

export default NotificationPreferences;
