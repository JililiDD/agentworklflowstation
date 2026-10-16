import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { RunSetupValidation, WorkflowLibraryItem } from "../types";

interface WorkflowsViewProps {
  onStartRun: (runId: string) => void;
}

export const WorkflowsView: React.FC<WorkflowsViewProps> = ({ onStartRun }) => {
  const [workflows, setWorkflows] = useState<WorkflowLibraryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Selected workflow for setup modal/form
  const [selectedWorkflow, setSelectedWorkflow] =
    useState<WorkflowLibraryItem | null>(null);
  const [targetRepo, setTargetRepo] = useState("");
  const [inputValues, setInputValues] = useState<Record<string, string>>({});
  const [budgetUsd, setBudgetUsd] = useState<number | undefined>(undefined);
  const [validation, setValidation] = useState<RunSetupValidation | null>(null);
  const [validating, setValidating] = useState(false);
  const [starting, setStarting] = useState(false);

  const loadWorkflows = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const list = await api.listWorkflows();
      setWorkflows(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadWorkflows();
  }, [loadWorkflows]);

  useEffect(() => {
    if (workflows.length > 0) {
      const hash = window.location.hash;
      const match = /[?&]run=([^&]+)/.exec(hash);
      if (match?.[1]) {
        const runWfId = decodeURIComponent(match[1]);
        const target = workflows.find((w) => w.id === runWfId);
        if (target) {
          setSelectedWorkflow(target);
          setValidation(null);
          setInputValues({});
          setBudgetUsd(target.budgetUsd);
        }
      }
    }
  }, [workflows]);

  const handleSelectToRun = (wf: WorkflowLibraryItem) => {
    setSelectedWorkflow(wf);
    setValidation(null);
    setInputValues({});
    setBudgetUsd(wf.budgetUsd);
  };

  const handleValidate = async () => {
    if (!selectedWorkflow || !targetRepo.trim()) return;
    try {
      setValidating(true);
      const res = await api.validateRunSetup({
        workflowId: selectedWorkflow.id,
        targetRepo: targetRepo.trim(),
        inputs: inputValues,
      });
      setValidation(res);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setValidating(false);
    }
  };

  const handleLaunch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedWorkflow || !targetRepo.trim()) return;

    try {
      setStarting(true);
      // Run preflight check if not yet done
      const precheck = await api.validateRunSetup({
        workflowId: selectedWorkflow.id,
        targetRepo: targetRepo.trim(),
        inputs: inputValues,
      });
      setValidation(precheck);

      if (!precheck.valid || precheck.errors.length > 0) {
        return;
      }

      const res = await api.startRun({
        workflowId: selectedWorkflow.id,
        targetRepo: targetRepo.trim(),
        inputs: inputValues,
        budgetUsd,
      });

      onStartRun(res.runId);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  };

  if (loading) {
    return (
      <div className="view-container">
        <div className="view-header">
          <h2>Workflows</h2>
        </div>
        <p className="quiet">Loading workflow library...</p>
      </div>
    );
  }

  return (
    <div className="view-container">
      <div className="view-header">
        <div>
          <h2>Workflows</h2>
          <p>
            Inspect available workflows and launch executions on target
            repositories
          </p>
        </div>
        <button
          className="btn primary"
          type="button"
          onClick={() => {
            window.location.hash = "#workflow-editor/new";
          }}
        >
          + Create Workflow
        </button>
      </div>

      {error && <div className="alert-error">{error}</div>}

      {/* Selected Run Setup Modal / Box */}
      {selectedWorkflow && (
        <div
          style={{
            background: "var(--panel)",
            border: "1px solid var(--ink)",
            borderRadius: "6px",
            padding: "20px",
            boxShadow: "0 4px 12px rgba(0,0,0,0.08)",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <div>
              <span className="quiet" style={{ fontSize: "11px" }}>
                Launch Workflow
              </span>
              <h3 style={{ margin: "2px 0 0", fontSize: "16px" }}>
                {selectedWorkflow.name || selectedWorkflow.id}
              </h3>
            </div>
            <button
              className="btn"
              type="button"
              onClick={() => {
                setSelectedWorkflow(null);
                setValidation(null);
              }}
            >
              Cancel
            </button>
          </div>

          <form
            onSubmit={handleLaunch}
            style={{
              marginTop: "16px",
              display: "flex",
              flexDirection: "column",
              gap: "12px",
            }}
          >
            <div>
              <label
                htmlFor="target-repo-input"
                style={{
                  display: "block",
                  fontWeight: 600,
                  fontSize: "12px",
                  marginBottom: "4px",
                }}
              >
                Target Git Repository Path *
              </label>
              <input
                id="target-repo-input"
                type="text"
                placeholder="/path/to/target/git-repository"
                value={targetRepo}
                onChange={(e) => {
                  setTargetRepo(e.target.value);
                  setValidation(null);
                }}
                required
                style={{ width: "100%" }}
              />
            </div>

            {selectedWorkflow.inputs && selectedWorkflow.inputs.length > 0 && (
              <div>
                <span
                  style={{
                    display: "block",
                    fontWeight: 600,
                    fontSize: "12px",
                    marginBottom: "4px",
                  }}
                >
                  Workflow Inputs
                </span>
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "8px",
                  }}
                >
                  {selectedWorkflow.inputs.map((inp) => (
                    <div
                      key={inp}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "10px",
                      }}
                    >
                      <label
                        htmlFor={`wf-input-${inp}`}
                        className="code"
                        style={{ width: "140px", fontSize: "12px" }}
                      >
                        {inp}:
                      </label>
                      <input
                        id={`wf-input-${inp}`}
                        type="text"
                        placeholder={`Value for ${inp}`}
                        value={inputValues[inp] ?? ""}
                        onChange={(e) => {
                          setInputValues({
                            ...inputValues,
                            [inp]: e.target.value,
                          });
                          setValidation(null);
                        }}
                        style={{ flex: 1 }}
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div>
              <label
                htmlFor="budget-usd-input"
                style={{
                  display: "block",
                  fontWeight: 600,
                  fontSize: "12px",
                  marginBottom: "4px",
                }}
              >
                Budget Limit (USD, optional)
              </label>
              <input
                id="budget-usd-input"
                type="number"
                step="0.01"
                min="0"
                placeholder={
                  selectedWorkflow.budgetUsd
                    ? String(selectedWorkflow.budgetUsd)
                    : "e.g. 10.00"
                }
                value={budgetUsd ?? ""}
                onChange={(e) =>
                  setBudgetUsd(
                    e.target.value
                      ? Number.parseFloat(e.target.value)
                      : undefined,
                  )
                }
                style={{ width: "160px" }}
              />
            </div>

            {/* Validation Feedback */}
            {validation && (
              <div
                style={{ display: "flex", flexDirection: "column", gap: "6px" }}
              >
                {validation.warnings.map((w) => (
                  <div key={w} className="alert-warning">
                    Warning: {w}
                  </div>
                ))}
                {validation.errors.map((e) => (
                  <div key={e} className="alert-error">
                    Error: {e}
                  </div>
                ))}
                {validation.valid && validation.errors.length === 0 && (
                  <div
                    className="alert-warning"
                    style={{
                      background: "#dcfce7",
                      borderColor: "#86efac",
                      color: "#166534",
                    }}
                  >
                    ✓ Preflight checks passed. Ready to start run.
                  </div>
                )}
              </div>
            )}

            <div style={{ display: "flex", gap: "10px", marginTop: "8px" }}>
              <button
                className="btn"
                type="button"
                disabled={!targetRepo.trim() || validating}
                onClick={handleValidate}
              >
                {validating ? "Checking..." : "Preflight Check"}
              </button>
              <button
                className="btn primary"
                type="submit"
                disabled={
                  starting ||
                  !targetRepo.trim() ||
                  (validation !== null && !validation.valid)
                }
              >
                {starting ? "Launching..." : "Start Run"}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Workflows Grid */}
      {workflows.length === 0 ? (
        <div className="empty-state">
          <h3>No Workflows Found</h3>
          <p>
            Place YAML workflow files in your data directory (
            <span className="code">~/.local/share/aipilotagent/workflows/</span>
            ) or save them via API.
          </p>
        </div>
      ) : (
        <div className="card-grid">
          {workflows.map((wf) => (
            <div key={wf.id} className="item-card">
              <div className="card-top">
                <h3>{wf.name || wf.id}</h3>
                <span
                  className={`badge-status ${wf.valid ? "badge-succeeded" : "badge-failed"}`}
                >
                  {wf.valid ? "Valid" : "Invalid"}
                </span>
              </div>

              <div
                style={{
                  fontSize: "12px",
                  color: "var(--muted)",
                  display: "flex",
                  flexDirection: "column",
                  gap: "3px",
                }}
              >
                <div>
                  Nodes: <b>{wf.nodeCount ?? 0}</b> · Max Parallel:{" "}
                  <b>{wf.maxParallel ?? 1}</b>
                </div>
                {wf.budgetUsd !== undefined && (
                  <div>
                    Budget: <b>${wf.budgetUsd.toFixed(2)}</b>
                  </div>
                )}
                {wf.inputs && wf.inputs.length > 0 && (
                  <div>
                    Inputs: <span className="code">{wf.inputs.join(", ")}</span>
                  </div>
                )}
                {wf.error && (
                  <div className="alert-error" style={{ marginTop: "4px" }}>
                    {wf.error}
                  </div>
                )}
              </div>

              <div
                style={{
                  marginTop: "auto",
                  paddingTop: "8px",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <span className="quiet" style={{ fontSize: "11px" }}>
                  {new Date(wf.updatedAt).toLocaleDateString()}
                </span>
                <div style={{ display: "flex", gap: "6px" }}>
                  <button
                    className="btn"
                    type="button"
                    onClick={() => {
                      window.location.hash = `#workflow-editor/${encodeURIComponent(wf.id)}`;
                    }}
                  >
                    Edit
                  </button>
                  <button
                    className="btn primary"
                    type="button"
                    disabled={!wf.valid}
                    onClick={() => handleSelectToRun(wf)}
                  >
                    Run Workflow
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
