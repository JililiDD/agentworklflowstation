import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { DurableRunState } from "../types";

interface RunsListViewProps {
  onSelectRun: (runId: string) => void;
}

export const RunsListView: React.FC<RunsListViewProps> = ({ onSelectRun }) => {
  const [runs, setRuns] = useState<DurableRunState[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadRuns = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const list = await api.listRuns();
      setRuns(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadRuns();
    // Auto-refresh runs list every 3s
    const timer = setInterval(() => {
      void api
        .listRuns()
        .then(setRuns)
        .catch(() => {});
    }, 3000);
    return () => clearInterval(timer);
  }, [loadRuns]);

  const formatDuration = (createdStr: string, updatedStr: string) => {
    const start = new Date(createdStr).getTime();
    const end = new Date(updatedStr).getTime();
    const sec = Math.max(0, Math.floor((end - start) / 1000));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}m ${s}s`;
  };

  if (loading && runs.length === 0) {
    return (
      <div className="view-container">
        <div className="view-header">
          <h2>Runs</h2>
        </div>
        <p className="quiet">Loading runs...</p>
      </div>
    );
  }

  return (
    <div className="view-container">
      <div className="view-header">
        <div>
          <h2>Runs</h2>
          <p>Historical and active workflow executions</p>
        </div>
      </div>

      {error && <div className="alert-error">{error}</div>}

      {runs.length === 0 ? (
        <div className="empty-state">
          <h3>No Runs Yet</h3>
          <p>Go to the Workflows tab to start your first execution.</p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Run ID</th>
                <th>Target Repository</th>
                <th>Branch</th>
                <th>Status</th>
                <th>Elapsed</th>
                <th>Cost</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => {
                const statusClass =
                  r.status === "succeeded"
                    ? "badge-succeeded"
                    : r.status === "running"
                      ? "badge-running"
                      : r.status === "failed" || r.status === "budget_exceeded"
                        ? "badge-failed"
                        : "badge-waiting";

                return (
                  <tr
                    key={r.runId}
                    onClick={() => onSelectRun(r.runId)}
                    title="Click to view run details"
                  >
                    <td className="code" style={{ fontWeight: 600 }}>
                      {r.runId}
                    </td>
                    <td className="code quiet" style={{ fontSize: "11.5px" }}>
                      {r.repoDir}
                    </td>
                    <td className="code quiet" style={{ fontSize: "11.5px" }}>
                      {r.branch}
                    </td>
                    <td>
                      <span className={`badge-status ${statusClass}`}>
                        {r.status}
                      </span>
                    </td>
                    <td style={{ fontVariantNumeric: "tabular-nums" }}>
                      {formatDuration(r.createdAt, r.updatedAt)}
                    </td>
                    <td style={{ fontVariantNumeric: "tabular-nums" }}>
                      {r.totalUsage.costUsd !== undefined
                        ? `$${r.totalUsage.costUsd.toFixed(2)}`
                        : "—"}
                    </td>
                    <td className="quiet" style={{ fontSize: "11.5px" }}>
                      {new Date(r.createdAt).toLocaleString()}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
