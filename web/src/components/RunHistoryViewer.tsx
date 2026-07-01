import React, { useState, useEffect } from 'react';

interface Run {
  id: string;
  status: string;
  date: string;
  model: string;
  transcript: string;
}

const RunHistoryViewer: React.FC = () => {
  const [runs, setRuns] = useState<Run[]>([]);
  const [filterStatus, setFilterStatus] = useState<string>('');
  const [filterDate, setFilterDate] = useState<string>('');
  const [filterModel, setFilterModel] = useState<string>('');
  const [selectedRun, setSelectedRun] = useState<Run | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchRuns = async () => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        if (filterStatus) params.append('status', filterStatus);
        if (filterDate) params.append('date', filterDate);
        if (filterModel) params.append('model', filterModel);
        const response = await fetch(`/api/runs?${params.toString()}`);
        if (!response.ok) throw new Error('Failed to fetch runs');
        const data: Run[] = await response.json();
        setRuns(data);
      } catch (err: any) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };
    fetchRuns();
  }, [filterStatus, filterDate, filterModel]);

  const handleSelectRun = (run: Run) => {
    setSelectedRun(run);
  };

  const handleCloseTranscript = () => {
    setSelectedRun(null);
  };

  return (
    <div className="run-history-viewer">
      <h2>Run History</h2>
      <div className="filters">
        <label>
          Status:
          <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
            <option value="">All</option>
            <option value="success">Success</option>
            <option value="failure">Failure</option>
            <option value="running">Running</option>
          </select>
        </label>
        <label>
          Date:
          <input type="date" value={filterDate} onChange={(e) => setFilterDate(e.target.value)} />
        </label>
        <label>
          Model:
          <input type="text" value={filterModel} onChange={(e) => setFilterModel(e.target.value)} placeholder="Filter by model" />
        </label>
      </div>
      {loading && <p>Loading runs...</p>}
      {error && <p className="error">Error: {error}</p>}
      {!loading && !error && runs.length === 0 && <p>No runs found.</p>}
      <ul className="run-list">
        {runs.map((run) => (
          <li key={run.id} onClick={() => handleSelectRun(run)} className="run-item">
            <span className="run-status">{run.status}</span>
            <span className="run-date">{new Date(run.date).toLocaleDateString()}</span>
            <span className="run-model">{run.model}</span>
          </li>
        ))}
      </ul>
      {selectedRun && (
        <div className="transcript-modal">
          <div className="transcript-content">
            <h3>Transcript for Run {selectedRun.id}</h3>
            <pre>{selectedRun.transcript}</pre>
            <button onClick={handleCloseTranscript}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
};

export default RunHistoryViewer;
