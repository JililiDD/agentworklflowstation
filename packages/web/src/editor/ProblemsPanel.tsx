import type React from "react";
import { useState } from "react";
import type { EditorNode, EditorWorkflowDraft } from "./draft.ts";

export interface ValidationIssue {
  nodeId?: string;
  code: string;
  message: string;
  suggestion?: string;
}

export function validateDraftLocally(
  draft: EditorWorkflowDraft,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const seenIds = new Set<string>();

  // Map each nodeId to its parentId (or undefined for root)
  const parentMap = new Map<string, string | undefined>();
  const allNodesMap = new Map<string, EditorNode>();

  function collectNodes(nodes: EditorNode[], parentId?: string): void {
    for (const n of nodes) {
      if (!n.id || !/^[A-Za-z][\w-]*$/.test(n.id)) {
        issues.push({
          nodeId: n.id,
          code: "INVALID_ID",
          message: `Node ID '${n.id}' must start with a letter and contain only letters, numbers, dashes and underscores.`,
          suggestion: "Rename node ID to a valid identifier.",
        });
      }
      if (seenIds.has(n.id)) {
        issues.push({
          nodeId: n.id,
          code: "DUPLICATE_ID",
          message: `Duplicate node ID '${n.id}'. Each node must have a unique identifier.`,
          suggestion: "Change one of the duplicated node IDs.",
        });
      } else {
        seenIds.add(n.id);
      }

      parentMap.set(n.id, parentId);
      allNodesMap.set(n.id, n);

      if (n.kind === "agent") {
        if (!n.model || n.model.trim().length === 0) {
          issues.push({
            nodeId: n.id,
            code: "MISSING_MODEL",
            message: `Agent node '${n.id}' has no model specified.`,
            suggestion: "Select a model in the Model tab.",
          });
        }
        if (!n.task || n.task.trim().length === 0) {
          issues.push({
            nodeId: n.id,
            code: "MISSING_TASK",
            message: `Agent node '${n.id}' has an empty task description.`,
            suggestion: "Write task prompt instructions in the Prompt tab.",
          });
        }
      } else if (n.kind === "command") {
        if (!n.command || n.command.trim().length === 0) {
          issues.push({
            nodeId: n.id,
            code: "MISSING_COMMAND",
            message: `Command node '${n.id}' has no shell command specified.`,
            suggestion: "Enter a command string to execute.",
          });
        }
      } else if (n.kind === "group") {
        if (!n.until?.ref?.startsWith("${")) {
          issues.push({
            nodeId: n.id,
            code: "INVALID_UNTIL",
            message: `Group '${n.id}' until condition reference is invalid.`,
            suggestion:
              // biome-ignore lint/suspicious/noTemplateCurlyInString: template syntax
              "Set until.ref to a valid output reference like ${nodes.step.out.json#/ok}.",
          });
        }
        collectNodes(n.nodes, n.id);
      } else if (n.kind === "foreach") {
        if (!n.source?.startsWith("${")) {
          issues.push({
            nodeId: n.id,
            code: "INVALID_SOURCE",
            message: `Foreach '${n.id}' source reference is invalid.`,
            suggestion:
              // biome-ignore lint/suspicious/noTemplateCurlyInString: template syntax
              "Set source to a valid JSON array reference like ${nodes.step.items.json}.",
          });
        }
        collectNodes(n.nodes, n.id);
      }
    }
  }

  collectNodes(draft.nodes);

  // Check dependencies: cycles, missing deps, cross-container rules
  for (const [id, node] of allNodesMap.entries()) {
    const myParent = parentMap.get(id);

    for (const dep of node.dependsOn) {
      if (dep === id) {
        issues.push({
          nodeId: id,
          code: "SELF_CYCLE",
          message: `Node '${id}' cannot depend on itself.`,
          suggestion: "Remove self-referencing dependency.",
        });
        continue;
      }

      if (!allNodesMap.has(dep)) {
        issues.push({
          nodeId: id,
          code: "MISSING_DEP",
          message: `Node '${id}' depends on non-existent node '${dep}'.`,
          suggestion: `Remove '${dep}' from dependencies or create the node.`,
        });
        continue;
      }

      // Cross-container check: if node is outside container, it cannot depend directly on node inside container
      const depParent = parentMap.get(dep);
      if (myParent !== depParent) {
        if (depParent !== undefined && myParent === undefined) {
          issues.push({
            nodeId: id,
            code: "CROSS_CONTAINER_DEP",
            message: `Node '${id}' outside container cannot depend directly on '${dep}' inside container '${depParent}'.`,
            suggestion: `Make '${id}' depend on the container '${depParent}' instead.`,
          });
        }
      }
    }
  }

  // Detect simple cycles
  const visiting = new Set<string>();
  const visited = new Set<string>();

  function hasCycle(curr: string): boolean {
    if (visiting.has(curr)) return true;
    if (visited.has(curr)) return false;

    visiting.add(curr);
    const n = allNodesMap.get(curr);
    if (n) {
      for (const d of n.dependsOn) {
        if (hasCycle(d)) return true;
      }
    }
    visiting.delete(curr);
    visited.add(curr);
    return false;
  }

  for (const id of allNodesMap.keys()) {
    if (!visited.has(id)) {
      if (hasCycle(id)) {
        issues.push({
          nodeId: id,
          code: "CYCLE_DETECTED",
          message: `Cyclic dependency chain detected involving node '${id}'.`,
          suggestion: "Remove dependency to break the cycle.",
        });
        break;
      }
    }
  }

  return issues;
}

interface ProblemsPanelProps {
  issues: ValidationIssue[];
  onSelectNode: (nodeId: string) => void;
}

export const ProblemsPanel: React.FC<ProblemsPanelProps> = ({
  issues,
  onSelectNode,
}) => {
  const [expanded, setExpanded] = useState(true);

  if (issues.length === 0) {
    return null;
  }

  return (
    <div
      className="problems-panel"
      style={{
        borderTop: "1px solid var(--border)",
        background: "var(--panel)",
        boxShadow: "0 -2px 8px rgba(0,0,0,0.05)",
        maxHeight: expanded ? "180px" : "36px",
        display: "flex",
        flexDirection: "column",
        transition: "max-height 0.2s ease",
      }}
    >
      <button
        type="button"
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "6px 16px",
          background: "var(--bg)",
          border: "none",
          borderBottom: expanded ? "1px solid var(--border)" : "none",
          fontSize: "12px",
          cursor: "pointer",
          width: "100%",
          textAlign: "left",
        }}
        onClick={() => setExpanded(!expanded)}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <span style={{ color: "var(--error, #ef4444)", fontWeight: 600 }}>
            ⚠️ Problems ({issues.length})
          </span>
          <span className="quiet" style={{ fontSize: "11px" }}>
            {expanded ? "Click to collapse" : "Click to expand"}
          </span>
        </div>
        <span style={{ fontSize: "11px" }}>{expanded ? "▼" : "▲"}</span>
      </button>

      {expanded && (
        <div
          style={{
            overflowY: "auto",
            padding: "8px 16px",
            display: "flex",
            flexDirection: "column",
            gap: "6px",
          }}
        >
          {issues.map((issue) => (
            <div
              key={`${issue.nodeId ?? "global"}-${issue.code}-${issue.message}`}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "4px 8px",
                background: "rgba(239, 68, 68, 0.05)",
                borderLeft: "3px solid var(--error, #ef4444)",
                borderRadius: "2px",
                fontSize: "12px",
              }}
            >
              <div>
                {issue.nodeId && (
                  <span
                    className="code"
                    style={{
                      fontWeight: 600,
                      marginRight: "8px",
                      color: "var(--ink)",
                    }}
                  >
                    [{issue.nodeId}]
                  </span>
                )}
                <span>{issue.message}</span>
                {issue.suggestion && (
                  <span
                    className="quiet"
                    style={{ marginLeft: "6px", fontSize: "11px" }}
                  >
                    Fix: {issue.suggestion}
                  </span>
                )}
              </div>
              {issue.nodeId && (
                <button
                  className="btn"
                  type="button"
                  style={{
                    fontSize: "11px",
                    padding: "2px 8px",
                    marginLeft: "12px",
                    whiteSpace: "nowrap",
                  }}
                  onClick={() => {
                    if (issue.nodeId) onSelectNode(issue.nodeId);
                  }}
                >
                  Go to node →
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
