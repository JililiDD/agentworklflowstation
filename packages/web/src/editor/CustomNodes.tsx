import { Handle, type NodeProps, Position } from "@xyflow/react";
import type React from "react";
import type {
  EditorAgentNode,
  EditorCommandNode,
  EditorForeachNode,
  EditorGroupNode,
} from "./draft.ts";

export interface CustomNodeData {
  node:
    | EditorAgentNode
    | EditorCommandNode
    | EditorGroupNode
    | EditorForeachNode;
  collapsed?: boolean;
  depth?: number;
  hasError?: boolean;
  errorMessage?: string;
}

export const AgentNodeComponent: React.FC<NodeProps> = ({ data, selected }) => {
  const nodeData = data as unknown as CustomNodeData;
  const agent = nodeData.node as EditorAgentNode;
  const hasError = nodeData.hasError;

  return (
    <div
      className={`card card-agent ${selected ? "selected" : ""} ${hasError ? "has-error" : ""}`}
      style={{
        width: "250px",
        background: "var(--panel)",
        border: hasError
          ? "2px solid var(--error, #ef4444)"
          : selected
            ? "2px solid var(--ink)"
            : "1px solid var(--border)",
        borderRadius: "6px",
        padding: "10px",
        fontSize: "12px",
        position: "relative",
        boxSizing: "border-box",
        cursor: "pointer",
      }}
    >
      <Handle
        type="target"
        position={Position.Top}
        style={{ background: "var(--ink)", width: "8px", height: "8px" }}
      />

      {/* Top row: Icon, ID, badges */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "6px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <span style={{ fontSize: "14px" }}>🤖</span>
          <span style={{ fontWeight: 600, fontSize: "13px" }}>{agent.id}</span>
        </div>
        <div style={{ display: "flex", gap: "4px", alignItems: "center" }}>
          {agent.writable && (
            <span title="Writable (can modify workspace)">✏️</span>
          )}
          {agent.interactive && (
            <span title="Interactive (can ask questions)">💬</span>
          )}
          {agent.approval && <span title="Requires human approval">🛡️</span>}
          {agent.when && agent.when.length > 0 && (
            <span title="Conditional execution">⚡</span>
          )}
          {hasError && (
            <span
              className="error-icon"
              style={{ color: "var(--error, #ef4444)", fontWeight: "bold" }}
              title={nodeData.errorMessage ?? "Validation error"}
            >
              ⚠️
            </span>
          )}
        </div>
      </div>

      {/* Model & Thinking */}
      <div
        className="code quiet"
        style={{
          fontSize: "11px",
          marginBottom: "6px",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {agent.model || "no-model"}{" "}
        {agent.thinking ? `(${agent.thinking})` : ""}
      </div>

      {/* Task preview (2 lines) */}
      <div
        style={{
          color: "var(--muted)",
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
          minHeight: "28px",
          marginBottom: "8px",
          lineHeight: "1.3",
        }}
      >
        {agent.task || "(No task specified)"}
      </div>

      {/* Skills bottom row */}
      <div
        style={{
          borderTop: "1px solid var(--border)",
          paddingTop: "6px",
          fontSize: "11px",
          color: "var(--muted)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <span>
          {agent.skillNames && agent.skillNames.length > 0
            ? `Skill: ${agent.skillNames.join(", ")}`
            : "No skills"}
        </span>
        {agent.outputs && agent.outputs.length > 0 && (
          <span className="code" style={{ fontSize: "10px" }}>
            {agent.outputs.length} out
          </span>
        )}
      </div>

      <Handle
        type="source"
        position={Position.Bottom}
        style={{ background: "var(--ink)", width: "8px", height: "8px" }}
      />
    </div>
  );
};

export const CommandNodeComponent: React.FC<NodeProps> = ({
  data,
  selected,
}) => {
  const nodeData = data as unknown as CustomNodeData;
  const cmd = nodeData.node as EditorCommandNode;
  const hasError = nodeData.hasError;

  return (
    <div
      className={`card card-command ${selected ? "selected" : ""} ${hasError ? "has-error" : ""}`}
      style={{
        width: "250px",
        background: "var(--panel)",
        border: hasError
          ? "2px solid var(--error, #ef4444)"
          : selected
            ? "2px solid var(--ink)"
            : "1px solid var(--border)",
        borderRadius: "6px",
        padding: "10px",
        fontSize: "12px",
        position: "relative",
        boxSizing: "border-box",
        cursor: "pointer",
      }}
    >
      <Handle
        type="target"
        position={Position.Top}
        style={{ background: "var(--ink)", width: "8px", height: "8px" }}
      />

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "6px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <span style={{ fontSize: "14px" }}>💻</span>
          <span style={{ fontWeight: 600, fontSize: "13px" }}>{cmd.id}</span>
        </div>
        <div style={{ display: "flex", gap: "4px", alignItems: "center" }}>
          {cmd.writable && <span title="Writable">✏️</span>}
          {cmd.approval && <span title="Requires human approval">🛡️</span>}
          {cmd.when && cmd.when.length > 0 && (
            <span title="Conditional">⚡</span>
          )}
          {hasError && (
            <span
              className="error-icon"
              style={{ color: "var(--error, #ef4444)", fontWeight: "bold" }}
              title={nodeData.errorMessage ?? "Validation error"}
            >
              ⚠️
            </span>
          )}
        </div>
      </div>

      <div
        className="code"
        style={{
          background: "var(--bg)",
          padding: "6px",
          borderRadius: "4px",
          color: "var(--muted)",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          fontSize: "11px",
        }}
      >
        $ {cmd.command || "(No command)"}
      </div>

      <Handle
        type="source"
        position={Position.Bottom}
        style={{ background: "var(--ink)", width: "8px", height: "8px" }}
      />
    </div>
  );
};

export const GroupNodeComponent: React.FC<NodeProps> = ({ data, selected }) => {
  const nodeData = data as unknown as CustomNodeData;
  const group = nodeData.node as EditorGroupNode;
  const collapsed = Boolean(nodeData.collapsed);
  const hasError = nodeData.hasError;

  return (
    <div
      className={`container-group ${selected ? "selected" : ""} ${hasError ? "has-error" : ""}`}
      style={{
        width: "100%",
        height: "100%",
        background: "rgba(240, 240, 240, 0.4)",
        border: hasError
          ? "2px solid var(--error, #ef4444)"
          : selected
            ? "2px solid var(--ink)"
            : "1px dashed var(--muted)",
        borderRadius: "8px",
        position: "relative",
        boxSizing: "border-box",
      }}
    >
      <Handle
        type="target"
        position={Position.Top}
        style={{ background: "var(--ink)", width: "8px", height: "8px" }}
      />

      {/* Header bar */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "6px 10px",
          background: "var(--panel)",
          borderBottom: collapsed ? "none" : "1px solid var(--border)",
          borderTopLeftRadius: "6px",
          borderTopRightRadius: "6px",
          fontSize: "12px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <span>🔄</span>
          <span style={{ fontWeight: 600 }}>Group: {group.id}</span>
          <span className="quiet code" style={{ fontSize: "11px" }}>
            until: {group.until?.ref ? "configured" : "none"} (max{" "}
            {group.maxRounds} r)
          </span>
        </div>
        <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
          {hasError && <span style={{ color: "var(--error)" }}>⚠️</span>}
          <span className="badge-status" style={{ fontSize: "10px" }}>
            {group.nodes.length} nodes
          </span>
        </div>
      </div>

      <Handle
        type="source"
        position={Position.Bottom}
        style={{ background: "var(--ink)", width: "8px", height: "8px" }}
      />
    </div>
  );
};

export const ForeachNodeComponent: React.FC<NodeProps> = ({
  data,
  selected,
}) => {
  const nodeData = data as unknown as CustomNodeData;
  const fe = nodeData.node as EditorForeachNode;
  const collapsed = Boolean(nodeData.collapsed);
  const hasError = nodeData.hasError;

  return (
    <div
      className={`container-foreach ${selected ? "selected" : ""} ${hasError ? "has-error" : ""}`}
      style={{
        width: "100%",
        height: "100%",
        background: "rgba(245, 245, 245, 0.4)",
        border: hasError
          ? "2px solid var(--error, #ef4444)"
          : selected
            ? "2px solid var(--ink)"
            : "1px dashed var(--muted)",
        borderRadius: "8px",
        position: "relative",
        boxSizing: "border-box",
        // D-13: Two offset stacked border lines behind foreach container
        boxShadow: "4px 4px 0 0 var(--border), 8px 8px 0 0 rgba(0, 0, 0, 0.05)",
      }}
    >
      <Handle
        type="target"
        position={Position.Top}
        style={{ background: "var(--ink)", width: "8px", height: "8px" }}
      />

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "6px 10px",
          background: "var(--panel)",
          borderBottom: collapsed ? "none" : "1px solid var(--border)",
          borderTopLeftRadius: "6px",
          borderTopRightRadius: "6px",
          fontSize: "12px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <span>🔁</span>
          <span style={{ fontWeight: 600 }}>Foreach: {fe.id}</span>
          <span
            className="quiet code"
            style={{
              fontSize: "11px",
              maxWidth: "160px",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            src: {fe.source || "(unset)"}
          </span>
        </div>
        <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
          {hasError && <span style={{ color: "var(--error)" }}>⚠️</span>}
          <span className="badge-status" style={{ fontSize: "10px" }}>
            {fe.nodes.length} nodes
          </span>
        </div>
      </div>

      <Handle
        type="source"
        position={Position.Bottom}
        style={{ background: "var(--ink)", width: "8px", height: "8px" }}
      />
    </div>
  );
};
