import type React from "react";
import { useMemo, useState } from "react";
import type {
  EditorCondition,
  EditorNode,
  EditorWorkflowDraft,
} from "./draft.ts";

interface WhenConditionsEditorProps {
  conditions?: EditorCondition[];
  onChange: (conditions?: EditorCondition[]) => void;
}

const WhenConditionsEditor: React.FC<WhenConditionsEditorProps> = ({
  conditions = [],
  onChange,
}) => {
  const handleAdd = () => {
    onChange([...conditions, { ref: "", equals: true }]);
  };

  const handleRemove = (index: number) => {
    const next = conditions.filter((_, i) => i !== index);
    onChange(next.length > 0 ? next : undefined);
  };

  const handleUpdate = (index: number, patch: Partial<EditorCondition>) => {
    const next = conditions.map((c, i) =>
      i === index ? { ...c, ...patch } : c,
    );
    onChange(next);
  };

  return (
    <div
      style={{
        marginTop: "10px",
        borderTop: "1px solid var(--border)",
        paddingTop: "8px",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "6px",
        }}
      >
        <span style={{ fontSize: "12px", fontWeight: 600 }}>
          Execution Conditions (When)
        </span>
        <button
          className="btn"
          type="button"
          style={{ fontSize: "11px", padding: "2px 6px" }}
          onClick={handleAdd}
        >
          + Add Condition
        </button>
      </div>

      {conditions.length === 0 ? (
        <span className="quiet" style={{ fontSize: "11px" }}>
          No conditions configured (runs unconditionally)
        </span>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {conditions.map((c, idx) => (
            <div
              key={`cond-${c.ref}-${JSON.stringify(c.equals)}`}
              style={{
                background: "var(--bg)",
                padding: "6px",
                borderRadius: "4px",
                border: "1px solid var(--border)",
                display: "flex",
                flexDirection: "column",
                gap: "4px",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <span className="quiet" style={{ fontSize: "10px" }}>
                  Condition #{idx + 1}
                </span>
                <button
                  className="btn"
                  type="button"
                  style={{ fontSize: "10px", padding: "1px 4px" }}
                  onClick={() => handleRemove(idx)}
                >
                  ✕
                </button>
              </div>

              <div>
                <label
                  htmlFor={`when-ref-${idx}`}
                  style={{
                    display: "block",
                    fontSize: "10px",
                    fontWeight: 600,
                  }}
                >
                  Reference (ref) *
                </label>
                <input
                  id={`when-ref-${idx}`}
                  type="text"
                  value={c.ref}
                  placeholder="${nodes.step.out.json#/ok}"
                  onChange={(e) => handleUpdate(idx, { ref: e.target.value })}
                  style={{
                    width: "100%",
                    fontSize: "11px",
                    fontFamily: "var(--font-mono)",
                  }}
                />
              </div>

              <div>
                <label
                  htmlFor={`when-equals-${idx}`}
                  style={{
                    display: "block",
                    fontSize: "10px",
                    fontWeight: 600,
                  }}
                >
                  Equals Value (JSON)
                </label>
                <input
                  id={`when-equals-${idx}`}
                  type="text"
                  value={JSON.stringify(c.equals)}
                  onChange={(e) => {
                    try {
                      const val = JSON.parse(e.target.value);
                      handleUpdate(idx, { equals: val });
                    } catch {}
                  }}
                  style={{
                    width: "100%",
                    fontSize: "11px",
                    fontFamily: "var(--font-mono)",
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

interface PropertyDrawerProps {
  selectedNode: EditorNode | null;
  draft: EditorWorkflowDraft;
  availableSkills: string[];
  availableModels: Record<string, string[]>;
  onUpdateNode: (updated: EditorNode) => void;
  onUpdateDraftSettings: (settings: {
    inputs: string[];
    maxParallel: number;
    budgetUsd?: number;
  }) => void;
  onClose: () => void;
}

export const PropertyDrawer: React.FC<PropertyDrawerProps> = ({
  selectedNode,
  draft,
  availableSkills,
  availableModels,
  onUpdateNode,
  onUpdateDraftSettings,
  onClose,
}) => {
  const [activeGroup, setActiveGroup] = useState<
    "model" | "prompt" | "behavior" | "outputs"
  >("model");

  // Reference suggestion candidates based on draft and selectedNode
  const referenceCandidates = useMemo(() => {
    const list: Array<{ label: string; ref: string; desc: string }> = [];

    // Inputs
    for (const inp of draft.inputs) {
      list.push({
        label: `inputs.${inp}`,
        ref: `\${inputs.${inp}}`,
        desc: "Workflow input parameter",
      });
    }

    // Foreach items if inside foreach
    function checkInsideForeach(
      nodes: EditorNode[],
      targetId: string,
    ): boolean {
      for (const n of nodes) {
        if (n.kind === "foreach") {
          if (n.nodes.some((c) => c.id === targetId)) return true;
          if (checkInsideForeach(n.nodes, targetId)) return true;
        }
        if (n.kind === "group" && checkInsideForeach(n.nodes, targetId)) {
          return true;
        }
      }
      return false;
    }

    if (selectedNode && checkInsideForeach(draft.nodes, selectedNode.id)) {
      list.push({
        label: "item.<field>",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: template syntax
        ref: "${item.}",
        desc: "Current foreach loop item",
      });
    }

    // Upstream nodes outputs
    function collectUpstreamOutputs(nodes: EditorNode[]): void {
      for (const n of nodes) {
        if (selectedNode && n.id === selectedNode.id) continue;
        if (n.kind === "agent" && n.outputs) {
          for (const out of n.outputs) {
            list.push({
              label: `nodes.${n.id}.${out}`,
              ref: `\${nodes.${n.id}.${out}}`,
              desc: `Output file from ${n.id}`,
            });
          }
        } else if (n.kind === "command") {
          list.push({
            label: `nodes.${n.id}.stdout`,
            ref: `\${nodes.${n.id}.stdout}`,
            desc: `Stdout from ${n.id}`,
          });
          list.push({
            label: `nodes.${n.id}.exitCode`,
            ref: `\${nodes.${n.id}.exitCode}`,
            desc: `Exit code from ${n.id}`,
          });
        }
        if (n.kind === "group" || n.kind === "foreach") {
          collectUpstreamOutputs(n.nodes);
        }
      }
    }

    collectUpstreamOutputs(draft.nodes);
    return list;
  }, [draft, selectedNode]);

  if (!selectedNode) {
    // Show Workflow Global Settings
    return (
      <aside
        className="drawer"
        style={{
          width: "340px",
          borderLeft: "1px solid var(--border)",
          background: "var(--panel)",
          padding: "16px",
          display: "flex",
          flexDirection: "column",
          gap: "16px",
          overflowY: "auto",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <h3 style={{ margin: 0, fontSize: "14px" }}>Workflow Settings</h3>
          <button className="btn" type="button" onClick={onClose}>
            ✕
          </button>
        </div>

        <div>
          <label
            htmlFor="drawer-wf-inputs"
            style={{
              display: "block",
              fontWeight: 600,
              fontSize: "12px",
              marginBottom: "4px",
            }}
          >
            Inputs (comma-separated)
          </label>
          <input
            id="drawer-wf-inputs"
            type="text"
            value={draft.inputs.join(", ")}
            placeholder="e.g. prompt, target"
            onChange={(e) => {
              const items = e.target.value
                .split(",")
                .map((s) => s.trim())
                .filter((s) => s.length > 0);
              onUpdateDraftSettings({
                inputs: items,
                maxParallel: draft.maxParallel,
                budgetUsd: draft.budgetUsd,
              });
            }}
            style={{ width: "100%" }}
          />
        </div>

        <div>
          <label
            htmlFor="drawer-wf-parallel"
            style={{
              display: "block",
              fontWeight: 600,
              fontSize: "12px",
              marginBottom: "4px",
            }}
          >
            Max Parallel Execution
          </label>
          <input
            id="drawer-wf-parallel"
            type="number"
            min="1"
            max="16"
            value={draft.maxParallel}
            onChange={(e) => {
              const val = Math.max(1, Number.parseInt(e.target.value, 10) || 1);
              onUpdateDraftSettings({
                inputs: draft.inputs,
                maxParallel: val,
                budgetUsd: draft.budgetUsd,
              });
            }}
            style={{ width: "100%" }}
          />
        </div>

        <div>
          <label
            htmlFor="drawer-wf-budget"
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
            id="drawer-wf-budget"
            type="number"
            step="0.01"
            min="0"
            value={draft.budgetUsd ?? ""}
            placeholder="e.g. 5.00"
            onChange={(e) => {
              const val = e.target.value
                ? Number.parseFloat(e.target.value)
                : undefined;
              onUpdateDraftSettings({
                inputs: draft.inputs,
                maxParallel: draft.maxParallel,
                budgetUsd: val,
              });
            }}
            style={{ width: "100%" }}
          />
        </div>
      </aside>
    );
  }

  // Node Property View
  return (
    <aside
      className="drawer"
      style={{
        width: "360px",
        borderLeft: "1px solid var(--border)",
        background: "var(--panel)",
        padding: "16px",
        display: "flex",
        flexDirection: "column",
        gap: "14px",
        overflowY: "auto",
        boxSizing: "border-box",
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
            Node Properties
          </span>
          <h3 style={{ margin: "2px 0 0", fontSize: "15px" }}>
            {selectedNode.id} ({selectedNode.kind})
          </h3>
        </div>
        <button className="btn" type="button" onClick={onClose}>
          ✕
        </button>
      </div>

      {/* ID Rename */}
      <div>
        <label
          htmlFor="drawer-node-id"
          style={{
            display: "block",
            fontSize: "12px",
            fontWeight: 600,
            marginBottom: "3px",
          }}
        >
          Node ID *
        </label>
        <input
          id="drawer-node-id"
          type="text"
          value={selectedNode.id}
          onChange={(e) => {
            onUpdateNode({ ...selectedNode, id: e.target.value.trim() });
          }}
          style={{ width: "100%", fontFamily: "var(--font-mono)" }}
        />
      </div>

      {/* Agent Property Tabs (D-5: Model, Prompt, Behavior, Outputs) */}
      {selectedNode.kind === "agent" && (
        <>
          <div
            style={{
              display: "flex",
              borderBottom: "1px solid var(--border)",
              gap: "10px",
              fontSize: "12px",
            }}
          >
            {(["model", "prompt", "behavior", "outputs"] as const).map(
              (group) => (
                <button
                  key={group}
                  type="button"
                  onClick={() => setActiveGroup(group)}
                  style={{
                    background: "none",
                    border: "none",
                    borderBottom:
                      activeGroup === group
                        ? "2px solid var(--ink)"
                        : "2px solid transparent",
                    padding: "6px 4px",
                    fontWeight: activeGroup === group ? 600 : 400,
                    cursor: "pointer",
                    textTransform: "capitalize",
                  }}
                >
                  {group}
                </button>
              ),
            )}
          </div>

          {activeGroup === "model" && (
            <div
              style={{ display: "flex", flexDirection: "column", gap: "10px" }}
            >
              <div>
                <label
                  htmlFor="drawer-agent-model"
                  style={{
                    display: "block",
                    fontSize: "12px",
                    fontWeight: 600,
                    marginBottom: "3px",
                  }}
                >
                  Model *
                </label>
                <select
                  id="drawer-agent-model"
                  value={selectedNode.model}
                  onChange={(e) => {
                    onUpdateNode({
                      ...selectedNode,
                      model: e.target.value,
                    });
                  }}
                  style={{ width: "100%" }}
                >
                  <option value="">-- Select Model --</option>
                  {Object.keys(availableModels).map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                  {/* Allow fallback to custom model */}
                  {selectedNode.model &&
                    !availableModels[selectedNode.model] && (
                      <option value={selectedNode.model}>
                        {selectedNode.model}
                      </option>
                    )}
                </select>
              </div>

              <div>
                <label
                  htmlFor="drawer-agent-thinking"
                  style={{
                    display: "block",
                    fontSize: "12px",
                    fontWeight: 600,
                    marginBottom: "3px",
                  }}
                >
                  Thinking Level
                </label>
                <select
                  id="drawer-agent-thinking"
                  value={
                    selectedNode.thinkingLevel ?? selectedNode.thinking ?? "off"
                  }
                  onChange={(e) => {
                    onUpdateNode({
                      ...selectedNode,
                      thinkingLevel: e.target.value,
                      thinking: e.target.value,
                    });
                  }}
                  style={{ width: "100%" }}
                >
                  {[
                    "off",
                    "minimal",
                    "low",
                    "medium",
                    "high",
                    "xhigh",
                    "max",
                  ].map((lvl) => (
                    <option key={lvl} value={lvl}>
                      {lvl}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}

          {activeGroup === "prompt" && (
            <div
              style={{ display: "flex", flexDirection: "column", gap: "10px" }}
            >
              <div>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: "3px",
                  }}
                >
                  <label
                    htmlFor="drawer-agent-task"
                    style={{ fontSize: "12px", fontWeight: 600 }}
                  >
                    Task *
                  </label>
                  <span className="quiet" style={{ fontSize: "11px" }}>
                    Type <code style={{ fontSize: "10px" }}>{"${"}</code> to
                    insert ref
                  </span>
                </div>
                <textarea
                  id="drawer-agent-task"
                  rows={4}
                  value={selectedNode.task}
                  onChange={(e) => {
                    onUpdateNode({ ...selectedNode, task: e.target.value });
                  }}
                  style={{
                    width: "100%",
                    fontFamily: "var(--font-mono)",
                    fontSize: "12px",
                  }}
                />

                {/* Reference Picker */}
                <div style={{ marginTop: "6px" }}>
                  <span
                    className="quiet"
                    style={{ fontSize: "11px", display: "block" }}
                  >
                    Available References:
                  </span>
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: "4px",
                      marginTop: "4px",
                    }}
                  >
                    {referenceCandidates.map((cand) => (
                      <button
                        key={cand.label}
                        type="button"
                        className="btn"
                        style={{
                          fontSize: "11px",
                          padding: "2px 6px",
                          fontFamily: "var(--font-mono)",
                        }}
                        title={cand.desc}
                        onClick={() => {
                          const current = selectedNode.task;
                          onUpdateNode({
                            ...selectedNode,
                            task: current ? `${current} ${cand.ref}` : cand.ref,
                          });
                        }}
                      >
                        + {cand.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div>
                <label
                  htmlFor="drawer-agent-instructions"
                  style={{
                    display: "block",
                    fontSize: "12px",
                    fontWeight: 600,
                    marginBottom: "3px",
                  }}
                >
                  Additional Instructions
                </label>
                <textarea
                  id="drawer-agent-instructions"
                  rows={3}
                  value={selectedNode.instructions ?? ""}
                  onChange={(e) => {
                    onUpdateNode({
                      ...selectedNode,
                      instructions: e.target.value || undefined,
                    });
                  }}
                  style={{ width: "100%", fontSize: "12px" }}
                />
              </div>
            </div>
          )}

          {activeGroup === "behavior" && (
            <div
              style={{ display: "flex", flexDirection: "column", gap: "10px" }}
            >
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  fontSize: "12px",
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={Boolean(selectedNode.writable)}
                  onChange={(e) => {
                    onUpdateNode({
                      ...selectedNode,
                      writable: e.target.checked,
                    });
                  }}
                />
                <span>
                  <b>Writable</b> (allows node to modify repository workspace)
                </span>
              </label>

              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  fontSize: "12px",
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={Boolean(selectedNode.interactive)}
                  onChange={(e) => {
                    onUpdateNode({
                      ...selectedNode,
                      interactive: e.target.checked,
                    });
                  }}
                />
                <span>
                  <b>Interactive</b> (allows node to ask questions to user)
                </span>
              </label>

              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  fontSize: "12px",
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={Boolean(selectedNode.approval)}
                  onChange={(e) => {
                    onUpdateNode({
                      ...selectedNode,
                      approval: e.target.checked,
                    });
                  }}
                />
                <span>
                  <b>Approval</b> (requires human sign-off upon completion)
                </span>
              </label>

              <div>
                <label
                  htmlFor="drawer-agent-skills"
                  style={{
                    display: "block",
                    fontSize: "12px",
                    fontWeight: 600,
                    marginBottom: "3px",
                  }}
                >
                  Skills
                </label>
                <div
                  id="drawer-agent-skills"
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "4px",
                    maxHeight: "120px",
                    overflowY: "auto",
                    border: "1px solid var(--border)",
                    padding: "6px",
                    borderRadius: "4px",
                  }}
                >
                  {availableSkills.length === 0 ? (
                    <span className="quiet" style={{ fontSize: "11px" }}>
                      No skills registered in Settings
                    </span>
                  ) : (
                    availableSkills.map((sk) => {
                      const selected =
                        selectedNode.skillNames?.includes(sk) ?? false;
                      return (
                        <label
                          key={sk}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "6px",
                            fontSize: "12px",
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={selected}
                            onChange={(e) => {
                              const current = selectedNode.skillNames ?? [];
                              const updated = e.target.checked
                                ? [...current, sk]
                                : current.filter((s) => s !== sk);
                              onUpdateNode({
                                ...selectedNode,
                                skillNames: updated,
                              });
                            }}
                          />
                          <span>{sk}</span>
                        </label>
                      );
                    })
                  )}
                </div>
              </div>

              <WhenConditionsEditor
                conditions={selectedNode.when}
                onChange={(when) => onUpdateNode({ ...selectedNode, when })}
              />
            </div>
          )}

          {activeGroup === "outputs" && (
            <div
              style={{ display: "flex", flexDirection: "column", gap: "10px" }}
            >
              <div>
                <label
                  htmlFor="drawer-agent-outputs"
                  style={{
                    display: "block",
                    fontSize: "12px",
                    fontWeight: 600,
                    marginBottom: "3px",
                  }}
                >
                  Declared Output Files (comma-separated)
                </label>
                <input
                  id="drawer-agent-outputs"
                  type="text"
                  value={(selectedNode.outputs ?? []).join(", ")}
                  placeholder="e.g. result.json, report.md"
                  onChange={(e) => {
                    const files = e.target.value
                      .split(",")
                      .map((s) => s.trim())
                      .filter((s) => s.length > 0);
                    onUpdateNode({ ...selectedNode, outputs: files });
                  }}
                  style={{ width: "100%", fontFamily: "var(--font-mono)" }}
                />
              </div>

              <div>
                <label
                  htmlFor="drawer-agent-schemas"
                  style={{
                    display: "block",
                    fontSize: "12px",
                    fontWeight: 600,
                    marginBottom: "3px",
                  }}
                >
                  JSON Schemas (JSON format)
                </label>
                <textarea
                  id="drawer-agent-schemas"
                  rows={4}
                  value={
                    selectedNode.schemas
                      ? JSON.stringify(selectedNode.schemas, null, 2)
                      : ""
                  }
                  placeholder='{"result.json": { "type": "object" }}'
                  onChange={(e) => {
                    try {
                      const parsed = e.target.value
                        ? (JSON.parse(e.target.value) as Record<
                            string,
                            Record<string, unknown>
                          >)
                        : undefined;
                      onUpdateNode({ ...selectedNode, schemas: parsed });
                    } catch {
                      // Allow typing incomplete JSON
                    }
                  }}
                  style={{
                    width: "100%",
                    fontFamily: "var(--font-mono)",
                    fontSize: "11px",
                  }}
                />
              </div>
            </div>
          )}
        </>
      )}

      {/* Command Node Properties */}
      {selectedNode.kind === "command" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          <div>
            <label
              htmlFor="drawer-cmd-command"
              style={{
                display: "block",
                fontSize: "12px",
                fontWeight: 600,
                marginBottom: "3px",
              }}
            >
              Command *
            </label>
            <input
              id="drawer-cmd-command"
              type="text"
              value={selectedNode.command}
              onChange={(e) => {
                onUpdateNode({ ...selectedNode, command: e.target.value });
              }}
              placeholder="e.g. echo hello"
              style={{ width: "100%", fontFamily: "var(--font-mono)" }}
            />
          </div>

          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              fontSize: "12px",
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={Boolean(selectedNode.allowNonZeroExit)}
              onChange={(e) => {
                onUpdateNode({
                  ...selectedNode,
                  allowNonZeroExit: e.target.checked,
                });
              }}
            />
            <span>Allow Non-Zero Exit Code</span>
          </label>

          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              fontSize: "12px",
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={Boolean(selectedNode.writable)}
              onChange={(e) => {
                onUpdateNode({ ...selectedNode, writable: e.target.checked });
              }}
            />
            <span>Writable</span>
          </label>

          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              fontSize: "12px",
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={Boolean(selectedNode.approval)}
              onChange={(e) => {
                onUpdateNode({ ...selectedNode, approval: e.target.checked });
              }}
            />
            <span>Require Human Approval</span>
          </label>

          <WhenConditionsEditor
            conditions={selectedNode.when}
            onChange={(when) => onUpdateNode({ ...selectedNode, when })}
          />
        </div>
      )}

      {/* Group Node Properties */}
      {selectedNode.kind === "group" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          <div>
            <label
              htmlFor="drawer-group-maxrounds"
              style={{
                display: "block",
                fontSize: "12px",
                fontWeight: 600,
                marginBottom: "3px",
              }}
            >
              Max Rounds *
            </label>
            <input
              id="drawer-group-maxrounds"
              type="number"
              min="1"
              max="20"
              value={selectedNode.maxRounds}
              onChange={(e) => {
                onUpdateNode({
                  ...selectedNode,
                  maxRounds: Math.max(
                    1,
                    Number.parseInt(e.target.value, 10) || 1,
                  ),
                });
              }}
              style={{ width: "100%" }}
            />
          </div>

          <div>
            <label
              htmlFor="drawer-group-exhausted"
              style={{
                display: "block",
                fontSize: "12px",
                fontWeight: 600,
                marginBottom: "3px",
              }}
            >
              On Exhausted *
            </label>
            <select
              id="drawer-group-exhausted"
              value={selectedNode.onExhausted}
              onChange={(e) => {
                onUpdateNode({
                  ...selectedNode,
                  onExhausted: e.target.value as "fail" | "approve",
                });
              }}
              style={{ width: "100%" }}
            >
              <option value="fail">Fail workflow</option>
              <option value="approve">Request human approval</option>
            </select>
          </div>

          <div>
            <label
              htmlFor="drawer-group-until-ref"
              style={{
                display: "block",
                fontSize: "12px",
                fontWeight: 600,
                marginBottom: "3px",
              }}
            >
              Until Condition Reference *
            </label>
            <input
              id="drawer-group-until-ref"
              type="text"
              value={selectedNode.until?.ref ?? ""}
              placeholder="${nodes.reviewer.out.json#/ok}"
              onChange={(e) => {
                onUpdateNode({
                  ...selectedNode,
                  until: {
                    ref: e.target.value,
                    equals: selectedNode.until?.equals ?? true,
                  },
                });
              }}
              style={{ width: "100%", fontFamily: "var(--font-mono)" }}
            />
          </div>

          <div>
            <label
              htmlFor="drawer-group-until-val"
              style={{
                display: "block",
                fontSize: "12px",
                fontWeight: 600,
                marginBottom: "3px",
              }}
            >
              Until Equals Value (JSON)
            </label>
            <input
              id="drawer-group-until-val"
              type="text"
              value={JSON.stringify(selectedNode.until?.equals ?? true)}
              onChange={(e) => {
                try {
                  const parsed = JSON.parse(e.target.value);
                  onUpdateNode({
                    ...selectedNode,
                    until: {
                      ref: selectedNode.until?.ref ?? "",
                      equals: parsed,
                    },
                  });
                } catch {}
              }}
              style={{ width: "100%", fontFamily: "var(--font-mono)" }}
            />
          </div>

          <WhenConditionsEditor
            conditions={selectedNode.when}
            onChange={(when) => onUpdateNode({ ...selectedNode, when })}
          />
        </div>
      )}

      {/* Foreach Node Properties */}
      {selectedNode.kind === "foreach" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          <div>
            <label
              htmlFor="drawer-fe-source"
              style={{
                display: "block",
                fontSize: "12px",
                fontWeight: 600,
                marginBottom: "3px",
              }}
            >
              Source Array Reference *
            </label>
            <input
              id="drawer-fe-source"
              type="text"
              value={selectedNode.source}
              onChange={(e) => {
                onUpdateNode({ ...selectedNode, source: e.target.value });
              }}
              placeholder="${nodes.planner.tasks.json}"
              style={{ width: "100%", fontFamily: "var(--font-mono)" }}
            />
          </div>

          <WhenConditionsEditor
            conditions={selectedNode.when}
            onChange={(when) => onUpdateNode({ ...selectedNode, when })}
          />
        </div>
      )}
    </aside>
  );
};
