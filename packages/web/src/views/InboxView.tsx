import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { InboxResponse } from "../types";

interface InboxViewProps {
  onSelectNode: (runId: string, nodePath: string) => void;
}

export const InboxView: React.FC<InboxViewProps> = ({ onSelectNode }) => {
  const [inbox, setInbox] = useState<InboxResponse>({
    questions: [],
    approvals: [],
  });
  const [loading, setLoading] = useState(true);

  const loadInbox = useCallback(async () => {
    try {
      const res = await api.getInbox();
      setInbox(res);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadInbox();
    const timer = setInterval(() => {
      void loadInbox();
    }, 2000);
    return () => clearInterval(timer);
  }, [loadInbox]);

  const totalCount = inbox.questions.length + inbox.approvals.length;

  const formatWaiting = (createdStr: string) => {
    const elapsed = Math.max(
      0,
      Math.floor((Date.now() - new Date(createdStr).getTime()) / 1000),
    );
    if (elapsed < 60) return `${elapsed}s ago`;
    const m = Math.floor(elapsed / 60);
    return `${m}m ${elapsed % 60}s ago`;
  };

  return (
    <div className="view-container">
      <div className="view-header">
        <div>
          <h2>Inbox</h2>
          <p>
            Questions waiting for answers and nodes requiring human approval
          </p>
        </div>
      </div>

      {loading && totalCount === 0 ? (
        <p className="quiet">Checking inbox...</p>
      ) : totalCount === 0 ? (
        <div className="empty-state">
          <h3>Inbox is Clear</h3>
          <p>
            No questions or approvals are currently waiting for your attention.
          </p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Type</th>
                <th>Run ID</th>
                <th>Node</th>
                <th>Summary / Prompt</th>
                <th>Waiting Since</th>
              </tr>
            </thead>
            <tbody>
              {inbox.questions.map((q) => (
                <tr
                  key={`q-${q.runId}-${q.nodePath}`}
                  onClick={() => onSelectNode(q.runId, q.nodePath)}
                  title="Click to answer question in run drawer"
                >
                  <td>
                    <span className="badge-status badge-waiting">Question</span>
                  </td>
                  <td className="code" style={{ fontWeight: 600 }}>
                    {q.runId}
                  </td>
                  <td className="code">{q.nodePath}</td>
                  <td style={{ fontWeight: 500 }}>{q.question.prompt}</td>
                  <td
                    className="quiet"
                    style={{ fontVariantNumeric: "tabular-nums" }}
                  >
                    {formatWaiting(q.createdAt)}
                  </td>
                </tr>
              ))}
              {inbox.approvals.map((a) => (
                <tr
                  key={`appr-${a.runId}-${a.nodePath}`}
                  onClick={() => onSelectNode(a.runId, a.nodePath)}
                  title="Click to review approval in run drawer"
                >
                  <td>
                    <span
                      className="badge-status badge-waiting"
                      style={{ background: "#fef3c7" }}
                    >
                      Approval
                    </span>
                  </td>
                  <td className="code" style={{ fontWeight: 600 }}>
                    {a.runId}
                  </td>
                  <td className="code">{a.nodePath}</td>
                  <td style={{ fontWeight: 500 }}>
                    {a.request.reason === "group_exhausted"
                      ? "Group reached max rounds without satisfying until condition"
                      : "Node finished; manual approval required before downstream runs"}
                  </td>
                  <td
                    className="quiet"
                    style={{ fontVariantNumeric: "tabular-nums" }}
                  >
                    {formatWaiting(a.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
