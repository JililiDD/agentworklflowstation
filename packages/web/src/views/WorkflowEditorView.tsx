import {
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeTypes,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import YAML from "yaml";
import { api } from "../api";
import {
  AgentNodeComponent,
  CommandNodeComponent,
  ForeachNodeComponent,
  GroupNodeComponent,
} from "../editor/CustomNodes.tsx";
import {
  createDefaultAgentNode,
  createDefaultCommandNode,
  createDefaultForeachNode,
  createDefaultGroupNode,
  draftToPlainObject,
  duplicateSubtree,
  type EditorNode,
  type EditorWorkflowDraft,
  parseDraftFromObject,
  renameNodeInDraft,
} from "../editor/draft.ts";
import {
  draftToFlowElements,
  type LayoutMap,
} from "../editor/flow-transform.ts";
import {
  ProblemsPanel,
  type ValidationIssue,
  validateDraftLocally,
} from "../editor/ProblemsPanel.tsx";
import { PropertyDrawer } from "../editor/PropertyDrawer.tsx";

const nodeTypes: NodeTypes = {
  agent: AgentNodeComponent,
  command: CommandNodeComponent,
  group: GroupNodeComponent,
  foreach: ForeachNodeComponent,
};

export interface WorkflowEditorViewProps {
  workflowId: string;
  onNavigate: (view: string) => void;
}

const WorkflowEditorInner: React.FC<WorkflowEditorViewProps> = ({
  workflowId,
  onNavigate,
}) => {
  const isNew = workflowId === "new";
  const [currentId, setCurrentId] = useState(
    isNew ? "new_workflow" : workflowId,
  );
  const [draft, setDraft] = useState<EditorWorkflowDraft>({
    inputs: [],
    maxParallel: 1,
    nodes: [],
  });
  const [layoutMap, setLayoutMap] = useState<LayoutMap>({});
  const [originalYaml, setOriginalYaml] = useState<string | null>(null);
  const [loading, setLoading] = useState(!isNew);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [yamlError, setYamlError] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Selection
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [clipboard, setClipboard] = useState<EditorNode[] | null>(null);

  // Available skills & models from platform
  const [skills, setSkills] = useState<string[]>([]);
  const [models, setModels] = useState<Record<string, string[]>>({});

  const { zoomIn, zoomOut, setViewport, fitView } = useReactFlow();

  // Load platform models and skills
  useEffect(() => {
    const loadPlatformData = async () => {
      try {
        const sks = await api.listSkills();
        setSkills(sks.map((s) => s.name));
      } catch {}
      // Standard recommended models
      setModels({
        "fake/small": ["off"],
        "claude-sonnet-4-5": ["off", "low", "medium", "high"],
        "claude-haiku-4-5": ["off", "low"],
        "gpt-4o": ["off", "low", "medium"],
        "gpt-4o-mini": ["off", "low"],
      });
    };
    void loadPlatformData();
  }, []);

  // Load workflow & layout
  const loadWorkflowData = useCallback(async (id: string) => {
    try {
      setLoading(true);
      setLoadError(null);
      setYamlError(null);

      const [wfRes, layoutRes] = await Promise.all([
        api.getWorkflow(id),
        api.getWorkflowLayout(id).catch(() => null),
      ]);

      setOriginalYaml(wfRes.yaml);
      if (layoutRes?.current) {
        setLayoutMap(layoutRes.current);
      }

      let parsed: unknown;
      try {
        parsed = YAML.parse(wfRes.yaml);
      } catch (err) {
        setYamlError(
          `YAML parse error: ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }

      const parseRes = parseDraftFromObject(parsed);
      if (!parseRes.valid) {
        setYamlError(
          `Unsupported workflow structure: ${parseRes.unsupportedFields.join(", ")}`,
        );
        return;
      }

      setDraft(parseRes.draft);
      setIsDirty(false);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isNew) {
      void loadWorkflowData(workflowId);
    } else {
      setDraft({ inputs: [], maxParallel: 1, nodes: [] });
      setIsDirty(false);
      setLoading(false);
    }
  }, [workflowId, isNew, loadWorkflowData]);

  // Validation issues
  const [serverIssues, setServerIssues] = useState<ValidationIssue[]>([]);
  const validateReqIdRef = useRef(0);

  useEffect(() => {
    const reqId = ++validateReqIdRef.current;
    const timer = setTimeout(async () => {
      try {
        const plainObj = draftToPlainObject(draft);
        const yamlText = YAML.stringify(plainObj);
        const res = await api.validateRunSetup({ workflowYaml: yamlText });
        if (reqId === validateReqIdRef.current) {
          const mapped: ValidationIssue[] = res.errors.map((err) => {
            const refMatch =
              /invalid condition: \${nodes\.([^.]+)\./.exec(err) ||
              /invalid or non-ancestor reference: \${nodes\.([^.]+)\./.exec(
                err,
              ) ||
              /condition needs a JSON field: \${nodes\.([^.]+)\./.exec(err) ||
              /node id: ([A-Za-z0-9_-]+)/.exec(err);
            return {
              nodeId: refMatch?.[1],
              code: "SERVER_VALIDATION_ERROR",
              message: err,
              suggestion: "Correct the definition per engine requirements",
            };
          });
          setServerIssues(mapped);
        }
      } catch {
        // ignore
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [draft]);

  const validationIssues = useMemo(() => {
    const local = validateDraftLocally(draft);
    const combined = [...local];
    for (const s of serverIssues) {
      if (!combined.some((c) => c.message === s.message)) {
        combined.push(s);
      }
    }
    return combined;
  }, [draft, serverIssues]);
  const isValid = validationIssues.length === 0;

  // Find currently selected EditorNode
  const selectedNode = useMemo(() => {
    if (!selectedNodeId) return null;
    function findNode(nodes: EditorNode[]): EditorNode | null {
      for (const n of nodes) {
        if (n.id === selectedNodeId) return n;
        if (n.kind === "group" || n.kind === "foreach") {
          const found = findNode(n.nodes);
          if (found) return found;
        }
      }
      return null;
    }
    return findNode(draft.nodes);
  }, [selectedNodeId, draft.nodes]);

  // Convert draft to React Flow elements with validation indicators
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);

  useEffect(() => {
    const res = draftToFlowElements(draft, layoutMap);
    const nodeErrorMap = new Map<string, string>();
    for (const issue of validationIssues) {
      if (issue.nodeId && !nodeErrorMap.has(issue.nodeId)) {
        nodeErrorMap.set(issue.nodeId, issue.message);
      }
    }

    const annotatedNodes = res.nodes.map((n) => ({
      ...n,
      selected: n.id === selectedNodeId,
      data: {
        ...(n.data || {}),
        hasError: nodeErrorMap.has(n.id),
        errorMessage: nodeErrorMap.get(n.id),
      },
    }));

    setNodes(annotatedNodes);
    setEdges(res.edges);
  }, [draft, layoutMap, selectedNodeId, validationIssues]);

  // Handle node changes locally without triggering draft layout loop
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes((nds) => applyNodeChanges(changes, nds));
  }, []);

  const onNodeDragStop = useCallback((_e: unknown, node: Node) => {
    setLayoutMap((prev) => ({
      ...prev,
      [node.id]: {
        ...(prev[node.id] || { x: 0, y: 0 }),
        x: Math.round(node.position.x),
        y: Math.round(node.position.y),
      },
    }));
    setIsDirty(true);
  }, []);

  // Connection validation: Same hierarchy level only (AC-24)
  const isValidConnection = useCallback(
    (connection: Connection | Edge) => {
      if (connection.source === connection.target) return false;
      const sourceNode = nodes.find((n) => n.id === connection.source);
      const targetNode = nodes.find((n) => n.id === connection.target);
      if (!sourceNode || !targetNode) return false;
      // D-6 & AC-24: Only allow connections between siblings in the exact same container
      return sourceNode.parentId === targetNode.parentId;
    },
    [nodes],
  );

  // Handle new edge connection
  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return;
      if (!isValidConnection(connection)) return;

      const sourceId = connection.source;
      const targetId = connection.target;

      function addDep(nodes: EditorNode[]): EditorNode[] {
        return nodes.map((n) => {
          if (n.id === targetId) {
            if (!n.dependsOn.includes(sourceId)) {
              return { ...n, dependsOn: [...n.dependsOn, sourceId] };
            }
          }
          if (n.kind === "group" || n.kind === "foreach") {
            return { ...n, nodes: addDep(n.nodes) };
          }
          return n;
        });
      }

      setDraft((prev) => ({ ...prev, nodes: addDep(prev.nodes) }));
      setIsDirty(true);
    },
    [isValidConnection],
  );

  // Handle edge deletion
  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setEdges((eds) => applyEdgeChanges(changes, eds));
    for (const c of changes) {
      if (c.type === "remove") {
        const [sourceId, targetId] = c.id.split("->");
        if (sourceId && targetId) {
          setDraft((prev) => {
            function removeDep(nodes: EditorNode[]): EditorNode[] {
              return nodes.map((n) => {
                if (n.id === targetId) {
                  return {
                    ...n,
                    dependsOn: n.dependsOn.filter((d) => d !== sourceId),
                  };
                }
                if (n.kind === "group" || n.kind === "foreach") {
                  return { ...n, nodes: removeDep(n.nodes) };
                }
                return n;
              });
            }
            return { ...prev, nodes: removeDep(prev.nodes) };
          });
          setIsDirty(true);
        }
      }
    }
  }, []);

  // Update node properties from drawer
  const handleUpdateNode = useCallback(
    (updated: EditorNode) => {
      const oldId = selectedNodeId;
      if (oldId && updated.id !== oldId) {
        setDraft((prev) => {
          const renamed = renameNodeInDraft(prev, oldId, updated.id);
          function replaceNode(nodes: EditorNode[]): EditorNode[] {
            return nodes.map((n) => {
              if (n.id === updated.id) return updated;
              if (n.kind === "group" || n.kind === "foreach") {
                return { ...n, nodes: replaceNode(n.nodes) };
              }
              return n;
            });
          }
          return { ...renamed, nodes: replaceNode(renamed.nodes) };
        });

        setLayoutMap((prev) => {
          const next = { ...prev };
          if (next[oldId]) {
            next[updated.id] = next[oldId];
            delete next[oldId];
          }
          return next;
        });

        setSelectedNodeId(updated.id);
        setIsDirty(true);
        return;
      }

      function replaceNode(nodes: EditorNode[]): EditorNode[] {
        return nodes.map((n) => {
          if (n.id === updated.id) {
            return updated;
          }
          if (n.kind === "group" || n.kind === "foreach") {
            return { ...n, nodes: replaceNode(n.nodes) };
          }
          return n;
        });
      }

      setDraft((prev) => ({ ...prev, nodes: replaceNode(prev.nodes) }));
      setIsDirty(true);
    },
    [selectedNodeId],
  );

  // Update workflow settings from drawer
  const handleUpdateDraftSettings = useCallback(
    (settings: {
      inputs: string[];
      maxParallel: number;
      budgetUsd?: number;
    }) => {
      setDraft((prev) => ({
        ...prev,
        inputs: settings.inputs,
        maxParallel: settings.maxParallel,
        budgetUsd: settings.budgetUsd,
      }));
      setIsDirty(true);
    },
    [],
  );

  // Add new node (D-3)
  const handleAddNode = (kind: "agent" | "command" | "group" | "foreach") => {
    const baseName = kind;
    let counter = 1;
    function collectAllIds(nodes: EditorNode[]): Set<string> {
      const set = new Set<string>();
      for (const n of nodes) {
        set.add(n.id);
        if (n.kind === "group" || n.kind === "foreach") {
          for (const cid of collectAllIds(n.nodes)) set.add(cid);
        }
      }
      return set;
    }
    const allIds = collectAllIds(draft.nodes);
    while (allIds.has(`${baseName}${counter}`)) {
      counter++;
    }
    const newId = `${baseName}${counter}`;

    let newNode: EditorNode;
    if (kind === "agent") newNode = createDefaultAgentNode(newId);
    else if (kind === "command") newNode = createDefaultCommandNode(newId);
    else if (kind === "group") newNode = createDefaultGroupNode(newId);
    else newNode = createDefaultForeachNode(newId);

    // If a container is currently selected, add inside container; otherwise root
    const currentSelectedId = selectedNode?.id;
    if (
      selectedNode &&
      (selectedNode.kind === "group" || selectedNode.kind === "foreach") &&
      currentSelectedId
    ) {
      function insertIntoContainer(nodes: EditorNode[]): EditorNode[] {
        return nodes.map((n) => {
          if (n.id === currentSelectedId) {
            if (n.kind === "group" || n.kind === "foreach") {
              return { ...n, nodes: [...n.nodes, newNode] };
            }
          }
          if (n.kind === "group" || n.kind === "foreach") {
            return { ...n, nodes: insertIntoContainer(n.nodes) };
          }
          return n;
        });
      }
      setDraft((prev) => ({ ...prev, nodes: insertIntoContainer(prev.nodes) }));
    } else {
      setDraft((prev) => ({ ...prev, nodes: [...prev.nodes, newNode] }));
    }

    setSelectedNodeId(newId);
    setIsDirty(true);
  };

  // Delete selected node
  const handleDeleteSelected = useCallback(() => {
    if (!selectedNodeId) return;
    function deleteFromTree(nodes: EditorNode[]): EditorNode[] {
      const res: EditorNode[] = [];
      for (const n of nodes) {
        if (n.id === selectedNodeId) continue;
        if (n.kind === "group" || n.kind === "foreach") {
          res.push({
            ...n,
            nodes: deleteFromTree(n.nodes),
            dependsOn: n.dependsOn.filter((d) => d !== selectedNodeId),
          });
        } else {
          res.push({
            ...n,
            dependsOn: n.dependsOn.filter((d) => d !== selectedNodeId),
          });
        }
      }
      return res;
    }

    setDraft((prev) => ({ ...prev, nodes: deleteFromTree(prev.nodes) }));
    setSelectedNodeId(null);
    setIsDirty(true);
  }, [selectedNodeId]);

  // Copy & Paste (AC-17)
  const handleCopy = useCallback(() => {
    if (!selectedNode) return;
    setClipboard([selectedNode]);
  }, [selectedNode]);

  const handlePaste = useCallback(() => {
    if (!clipboard || clipboard.length === 0) return;
    function collectAllIds(nodes: EditorNode[]): Set<string> {
      const set = new Set<string>();
      for (const n of nodes) {
        set.add(n.id);
        if (n.kind === "group" || n.kind === "foreach") {
          for (const cid of collectAllIds(n.nodes)) set.add(cid);
        }
      }
      return set;
    }
    const existingIds = collectAllIds(draft.nodes);
    const { newNodes } = duplicateSubtree(clipboard, existingIds);

    // Paste into current selected container or root
    const currentSelectedId = selectedNode?.id;
    if (
      selectedNode &&
      (selectedNode.kind === "group" || selectedNode.kind === "foreach") &&
      currentSelectedId
    ) {
      function insertClones(nodes: EditorNode[]): EditorNode[] {
        return nodes.map((n) => {
          if (n.id === currentSelectedId) {
            if (n.kind === "group" || n.kind === "foreach") {
              return { ...n, nodes: [...n.nodes, ...newNodes] };
            }
          }
          if (n.kind === "group" || n.kind === "foreach") {
            return { ...n, nodes: insertClones(n.nodes) };
          }
          return n;
        });
      }
      setDraft((prev) => ({ ...prev, nodes: insertClones(prev.nodes) }));
    } else {
      setDraft((prev) => ({ ...prev, nodes: [...prev.nodes, ...newNodes] }));
    }
    setIsDirty(true);
  }, [clipboard, draft.nodes, selectedNode]);

  // Keyboard shortcuts (D-7: Ctrl -, Ctrl +, Ctrl 0; Ctrl+C, Ctrl+V, Delete)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key === "=") {
        e.preventDefault();
        zoomIn();
      } else if ((e.ctrlKey || e.metaKey) && e.key === "-") {
        e.preventDefault();
        zoomOut();
      } else if ((e.ctrlKey || e.metaKey) && e.key === "0") {
        e.preventDefault();
        setViewport({ x: 0, y: 0, zoom: 1 });
      } else if ((e.ctrlKey || e.metaKey) && e.key === "c") {
        handleCopy();
      } else if ((e.ctrlKey || e.metaKey) && e.key === "v") {
        handlePaste();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        handleDeleteSelected();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    zoomIn,
    zoomOut,
    setViewport,
    handleCopy,
    handlePaste,
    handleDeleteSelected,
  ]);

  // Save handler (AC-19, AC-91, AC-92)
  const handleSave = async () => {
    if (!currentId.trim()) {
      alert("Workflow ID is required");
      return;
    }
    try {
      setSaving(true);
      setSaveError(null);
      setSaveSuccess(false);

      const plainObj = draftToPlainObject(draft);

      const currentLayout: LayoutMap = {};
      for (const n of nodes) {
        currentLayout[n.id] = {
          x: Math.round(n.position.x),
          y: Math.round(n.position.y),
          width:
            n.measured?.width ??
            (typeof n.style?.width === "number" ? n.style.width : undefined),
          height:
            n.measured?.height ??
            (typeof n.style?.height === "number" ? n.style.height : undefined),
          collapsed: Boolean(n.data?.collapsed),
        };
      }

      const res = await api.saveWorkflow({
        id: currentId.trim(),
        updatedObject: plainObj,
        layout: currentLayout,
        expectedYaml: originalYaml ?? undefined,
      });

      setOriginalYaml(res.yaml);
      setIsDirty(false);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);

      if (isNew) {
        window.location.hash = `#workflow-editor/${encodeURIComponent(currentId.trim())}`;
      }
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleBack = () => {
    if (isDirty) {
      const confirmed = window.confirm(
        "You have unsaved changes. Discard and leave?",
      );
      if (!confirmed) return;
    }
    onNavigate("workflows");
  };

  if (loading) {
    return (
      <div className="view-container">
        <p className="quiet">Loading workflow editor...</p>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="view-container">
        <div className="view-header">
          <h2>Workflow Editor</h2>
          <button className="btn" type="button" onClick={handleBack}>
            Back to Workflows
          </button>
        </div>
        <div className="alert-error" style={{ marginTop: "16px" }}>
          Failed to load workflow: {loadError}
        </div>
      </div>
    );
  }

  if (yamlError) {
    return (
      <div className="view-container">
        <div className="view-header">
          <div>
            <h2>Workflow Editor: {currentId}</h2>
            <p className="quiet">
              This workflow contains YAML or structures that cannot be safely
              modified in the visual editor.
            </p>
          </div>
          <button className="btn" type="button" onClick={handleBack}>
            Back to Workflows
          </button>
        </div>
        <div className="alert-error" style={{ marginTop: "16px" }}>
          {yamlError}
        </div>
        <p style={{ marginTop: "12px", fontSize: "13px" }}>
          To prevent data loss and preserve comments or custom YAML constructs,
          the visual editor is read-only for this file. Original file remains
          unchanged.
        </p>
      </div>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        height: "100vh",
        width: "calc(100vw - 52px)",
        overflow: "hidden",
      }}
    >
      {/* Top Bar (D-3, D-7, D-22) */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "8px 16px",
          background: "var(--panel)",
          borderBottom: "1px solid var(--border)",
          zIndex: 10,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <button className="btn" type="button" onClick={handleBack}>
            ← Back
          </button>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span style={{ fontWeight: 600, fontSize: "14px" }}>Workflow:</span>
            {isNew ? (
              <input
                type="text"
                value={currentId}
                onChange={(e) => {
                  setCurrentId(e.target.value);
                  setIsDirty(true);
                }}
                placeholder="workflow_id"
                style={{ width: "160px", fontFamily: "var(--font-mono)" }}
              />
            ) : (
              <span className="code" style={{ fontSize: "14px" }}>
                {currentId}
              </span>
            )}
            {isDirty && (
              <span
                style={{
                  fontSize: "11px",
                  color: "var(--muted)",
                  background: "var(--border)",
                  padding: "2px 6px",
                  borderRadius: "4px",
                }}
              >
                Unsaved changes
              </span>
            )}
          </div>
        </div>

        {/* Node Library / Add node buttons (D-3) */}
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <span className="quiet" style={{ fontSize: "12px" }}>
            Add node:
          </span>
          <button
            className="btn"
            type="button"
            onClick={() => handleAddNode("agent")}
          >
            🤖 + Agent
          </button>
          <button
            className="btn"
            type="button"
            onClick={() => handleAddNode("command")}
          >
            💻 + Command
          </button>
          <button
            className="btn"
            type="button"
            onClick={() => handleAddNode("group")}
          >
            🔄 + Group
          </button>
          <button
            className="btn"
            type="button"
            onClick={() => handleAddNode("foreach")}
          >
            🔁 + Foreach
          </button>
        </div>

        {/* Zoom Controls (D-7) */}
        <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
          <button
            className="btn"
            type="button"
            title="Zoom Out (Ctrl -)"
            onClick={() => zoomOut()}
          >
            -
          </button>
          <button
            className="btn"
            type="button"
            title="Reset Zoom (Ctrl 0)"
            onClick={() => setViewport({ x: 0, y: 0, zoom: 1 })}
          >
            100%
          </button>
          <button
            className="btn"
            type="button"
            title="Zoom In (Ctrl +)"
            onClick={() => zoomIn()}
          >
            +
          </button>
          <button
            className="btn"
            type="button"
            title="Fit View"
            onClick={() => fitView({ padding: 0.2 })}
          >
            Fit
          </button>
        </div>

        {/* Actions: Copy, Paste, Delete, Save, Run (D-22) */}
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          {selectedNode && (
            <>
              <button
                className="btn"
                type="button"
                title="Copy (Ctrl+C)"
                onClick={handleCopy}
              >
                Copy
              </button>
              <button
                className="btn"
                type="button"
                title="Delete node (Del)"
                onClick={handleDeleteSelected}
              >
                Delete
              </button>
            </>
          )}
          {clipboard && clipboard.length > 0 && (
            <button
              className="btn"
              type="button"
              title="Paste (Ctrl+V)"
              onClick={handlePaste}
            >
              Paste
            </button>
          )}

          {saveError && (
            <span style={{ color: "var(--error)", fontSize: "12px" }}>
              {saveError}
            </span>
          )}
          {saveSuccess && (
            <span style={{ color: "var(--success)", fontSize: "12px" }}>
              ✓ Saved
            </span>
          )}

          <button
            className="btn"
            type="button"
            disabled={saving}
            onClick={handleSave}
          >
            {saving ? "Saving..." : "Save"}
          </button>

          <button
            className="btn primary"
            type="button"
            disabled={!isValid || isDirty}
            title={
              !isValid
                ? `Workflow has ${validationIssues.length} validation errors. Fix them to run.`
                : isDirty
                  ? "Save workflow before running"
                  : "Launch workflow run"
            }
            onClick={() => {
              window.location.hash = `#workflows?run=${encodeURIComponent(currentId.trim())}`;
            }}
          >
            Run
          </button>
        </div>
      </div>

      {/* Main Canvas + Drawer */}
      <div
        style={{
          display: "flex",
          flex: 1,
          height: "calc(100vh - 100px)",
          position: "relative",
          overflow: "hidden",
        }}
      >
        <div
          id="workflow-editor-canvas"
          style={{
            flex: 1,
            height: "100%",
            width: "100%",
            position: "relative",
          }}
        >
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeDragStop={onNodeDragStop}
            onConnect={onConnect}
            isValidConnection={isValidConnection}
            onNodeClick={(_e, node) => setSelectedNodeId(node.id)}
            onPaneClick={() => setSelectedNodeId(null)}
            fitView
            style={{ width: "100%", height: "100%" }}
          />
        </div>

        {/* Right Drawer (D-4, D-5) */}
        <PropertyDrawer
          selectedNode={selectedNode}
          draft={draft}
          availableSkills={skills}
          availableModels={models}
          onUpdateNode={handleUpdateNode}
          onUpdateDraftSettings={handleUpdateDraftSettings}
          onClose={() => setSelectedNodeId(null)}
        />
      </div>

      {/* Problems Panel (D-19, D-20, D-21, D-22) */}
      <ProblemsPanel
        issues={validationIssues}
        onSelectNode={(nodeId) => setSelectedNodeId(nodeId)}
      />
    </div>
  );
};

export const WorkflowEditorView: React.FC<WorkflowEditorViewProps> = (
  props,
) => {
  return (
    <ReactFlowProvider>
      <WorkflowEditorInner {...props} />
    </ReactFlowProvider>
  );
};
