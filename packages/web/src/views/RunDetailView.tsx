import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type {
  DurableRunNodeRecord,
  DurableRunState,
  InboxResponse,
  RecordedInteraction,
  RunPreviewResult,
  StepEvent,
  WorkflowDefinition,
  WorkflowNodeItem,
} from "../types";

function findNodeDef(
  nodes: WorkflowNodeItem[] | undefined,
  targetPath: string | null,
): WorkflowNodeItem | undefined {
  if (!nodes || !targetPath) return undefined;
  const leafId = targetPath.split("/").pop() ?? targetPath;
  for (const n of nodes) {
    if (n.id === leafId || n.id === targetPath) return n;
    if (n.nodes) {
      const child = findNodeDef(n.nodes, targetPath);
      if (child) return child;
    }
  }
  return undefined;
}

function getGroupRounds(
  nodesState: Record<string, unknown>,
  groupId: string,
): number[] {
  const rounds = new Set<number>();
  const regex = new RegExp(`^${groupId}/(?:attempt-\\d+/)?round-(\\d+)`);
  for (const key of Object.keys(nodesState)) {
    const match = regex.exec(key);
    if (match?.[1]) {
      rounds.add(Number.parseInt(match[1], 10));
    }
  }
  if (rounds.size === 0) return [1];
  return Array.from(rounds).sort((a, b) => a - b);
}

function getForeachItems(
  nodesState: Record<string, unknown>,
  foreachId: string,
): number[] {
  const items = new Set<number>();
  const regex = new RegExp(`^${foreachId}/(?:attempt-\\d+/)?item-(\\d+)`);
  for (const key of Object.keys(nodesState)) {
    const match = regex.exec(key);
    if (match?.[1]) {
      items.add(Number.parseInt(match[1], 10));
    }
  }
  if (items.size === 0) return [0];
  return Array.from(items).sort((a, b) => a - b);
}

function findNodeRecord(
  nodesState: Record<string, DurableRunNodeRecord>,
  expectedPath: string,
): DurableRunNodeRecord | undefined {
  if (nodesState[expectedPath]) return nodesState[expectedPath];
  for (const [k, v] of Object.entries(nodesState)) {
    if (k.endsWith(`/${expectedPath}`) || k === expectedPath) return v;
  }
  return undefined;
}

interface RunDetailViewProps {
  runId: string;
  initialNodePath?: string;
  onBack: () => void;
}

export const RunDetailView: React.FC<RunDetailViewProps> = ({
  runId,
  initialNodePath,
  onBack,
}) => {
  const [runState, setRunState] = useState<DurableRunState | null>(null);
  const [definition, setDefinition] = useState<WorkflowDefinition | null>(null);
  const [events, setEvents] = useState<unknown[]>([]);
  const [interactions, setInteractions] = useState<RecordedInteraction[]>([]);
  const [inbox, setInbox] = useState<InboxResponse>({
    questions: [],
    approvals: [],
  });
  const [selectedNodePath, setSelectedNodePath] = useState<string | null>(
    initialNodePath ?? null,
  );
  const [activeTab, setActiveTab] = useState<
    "questions" | "events" | "task" | "outputs" | "diff"
  >("task");

  // Interaction inputs
  const [answerText, setAnswerText] = useState("");
  const [isSecret, setIsSecret] = useState(false);
  const [rejectFeedback, setRejectFeedback] = useState("");
  const [actionLoading, setActionLoading] = useState(false);

  // Resume budget input
  const [newBudgetUsd, setNewBudgetUsd] = useState<number | undefined>(
    undefined,
  );

  // Preview content cache
  const [previewData, setPreviewData] = useState<RunPreviewResult | null>(null);
  const [selectedOutputFile, setSelectedOutputFile] = useState<string | null>(
    null,
  );

  // Group and Foreach container navigation
  const [groupRounds, setGroupRounds] = useState<Record<string, number>>({});
  const [foreachItems, setForeachItems] = useState<Record<string, number>>({});

  // Events auto-scroll
  const eventsContainerRef = useRef<HTMLDivElement>(null);
  const userScrolledUpRef = useRef(false);

  const loadRunData = useCallback(async () => {
    try {
      const [r, d, ev, inter, inb] = await Promise.all([
        api.getRun(runId),
        api.getRunDefinition(runId).catch(() => null),
        api.getRunEvents(runId).catch(() => []),
        api.getRunInteractions(runId).catch(() => []),
        api.getInbox().catch(() => ({ questions: [], approvals: [] })),
      ]);
      setRunState(r);
      setDefinition(d);
      setEvents(ev);
      setInteractions(inter);
      setInbox(inb);
    } catch (err) {
      console.error("Failed to load run:", err);
    }
  }, [runId]);

  const handleSendAnswer = useCallback(
    async (textToSend?: string, optionIdToSend?: string) => {
      if (!selectedNodePath) return;
      const finalTxt = textToSend ?? answerText;
      if (!finalTxt.trim() && !optionIdToSend) return;

      try {
        setActionLoading(true);
        await api.answerQuestion(runId, selectedNodePath, {
          text: finalTxt.trim(),
          optionId: optionIdToSend,
          secret: isSecret,
        });
        setAnswerText("");
        setIsSecret(false);
        await loadRunData();
      } catch (err) {
        alert(err instanceof Error ? err.message : String(err));
      } finally {
        setActionLoading(false);
      }
    },
    [selectedNodePath, answerText, isSecret, runId, loadRunData],
  );

  useEffect(() => {
    void loadRunData();

    // SSE connection for live updates
    const eventSource = new EventSource(
      `/api/runs/${encodeURIComponent(runId)}/events?stream=true`,
    );
    eventSource.onmessage = (e) => {
      try {
        const payload = JSON.parse(e.data) as { type: string };
        setEvents((prev) => [...prev, payload]);
        void loadRunData();
      } catch {
        // ignore
      }
    };

    const pollTimer = setInterval(() => {
      void loadRunData();
    }, 1000);

    return () => {
      eventSource.close();
      clearInterval(pollTimer);
    };
  }, [runId, loadRunData]);

  // Initial node selection if specified in props
  useEffect(() => {
    if (initialNodePath) {
      setSelectedNodePath(initialNodePath);
    }
  }, [initialNodePath]);

  // Auto-switch tab to question or approval when selected node needs attention
  useEffect(() => {
    if (!selectedNodePath) return;
    const hasQuestion = inbox.questions.some(
      (q) => q.runId === runId && q.nodePath === selectedNodePath,
    );
    if (hasQuestion) {
      setActiveTab("questions");
    }
  }, [selectedNodePath, inbox, runId]);

  // Load preview data when selected node or tab changes
  useEffect(() => {
    if (!selectedNodePath) {
      setPreviewData(null);
      return;
    }
    if (activeTab === "diff") {
      void api
        .getRunPreview(runId, { nodePath: selectedNodePath, kind: "diff" })
        .then(setPreviewData)
        .catch(() => setPreviewData(null));
    } else if (activeTab === "task") {
      void api
        .getRunPreview(runId, { nodePath: selectedNodePath, kind: "task" })
        .then(setPreviewData)
        .catch(() => setPreviewData(null));
    } else if (activeTab === "outputs" && selectedOutputFile) {
      void api
        .getRunPreview(runId, {
          nodePath: selectedNodePath,
          kind: "output",
          fileName: selectedOutputFile,
        })
        .then(setPreviewData)
        .catch(() => setPreviewData(null));
    }
  }, [runId, selectedNodePath, activeTab, selectedOutputFile]);

  // Auto-scroll events
  useEffect(() => {
    if (
      activeTab === "events" &&
      eventsContainerRef.current &&
      !userScrolledUpRef.current
    ) {
      eventsContainerRef.current.scrollTop =
        eventsContainerRef.current.scrollHeight;
    }
  }, [activeTab]);

  // Keyboard shortcut listener for question choices (1, 2, 3...)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Only when not focused in input/textarea
      if (
        document.activeElement?.tagName === "INPUT" ||
        document.activeElement?.tagName === "TEXTAREA"
      ) {
        return;
      }
      if (!selectedNodePath) return;
      const currentPendingQ = inbox.questions.find(
        (q) => q.runId === runId && q.nodePath === selectedNodePath,
      );
      if (!currentPendingQ) return;

      const num = Number.parseInt(e.key, 10);
      if (
        !Number.isNaN(num) &&
        num >= 1 &&
        num <= currentPendingQ.question.options.length
      ) {
        const option = currentPendingQ.question.options[num - 1];
        if (option) {
          e.preventDefault();
          void handleSendAnswer(option.label, option.id);
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [inbox, selectedNodePath, runId, handleSendAnswer]);

  const handleApprove = async (approved: boolean) => {
    if (!selectedNodePath) return;
    if (!approved && !rejectFeedback.trim()) {
      alert("Feedback is required when rejecting a node.");
      return;
    }

    try {
      setActionLoading(true);
      await api.handleApproval(runId, selectedNodePath, {
        approved,
        feedback: approved ? undefined : rejectFeedback.trim(),
      });
      setRejectFeedback("");
      await loadRunData();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setActionLoading(false);
    }
  };

  const handleStopRun = async () => {
    try {
      await api.stopRun(runId);
      await loadRunData();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  const handleResumeRun = async () => {
    try {
      await api.resumeRun(runId, { newBudgetUsd });
      await loadRunData();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  if (!runState) {
    return (
      <div className="view-container">
        <p className="quiet">Loading run details...</p>
      </div>
    );
  }

  // Calculate elapsed time
  const startMs = new Date(runState.createdAt).getTime();
  const endMs =
    runState.status === "running"
      ? Date.now()
      : new Date(runState.updatedAt).getTime();
  const totalSec = Math.max(0, Math.floor((endMs - startMs) / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const elapsedStr =
    h > 0
      ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
      : `${m}:${String(s).padStart(2, "0")}`;

  // Cost and budget
  const cost = runState.totalUsage.costUsd ?? 0;
  const budget = runState.budgetUsd;
  const costPercent =
    budget && budget > 0 ? Math.min(100, Math.round((cost / budget) * 100)) : 0;

  // Interventions count
  const interventionsCount = interactions.filter(
    (i) => i.answeredAt !== undefined,
  ).length;

  // Progress segments
  const nodeEntries = Object.entries(runState.nodes);
  const doneCount = nodeEntries.filter(
    ([_, n]) => n.state === "succeeded",
  ).length;
  const waitingCount = nodeEntries.filter(
    ([_, n]) =>
      n.state === "waiting_approval" ||
      inbox.questions.some((q) => q.runId === runId),
  ).length;
  const failedCount = nodeEntries.filter(
    ([_, n]) => n.state === "failed",
  ).length;
  const runningCount = nodeEntries.filter(
    ([_, n]) => n.state === "running",
  ).length;
  const pendingCount = Math.max(
    0,
    (definition?.nodes.length ?? nodeEntries.length) -
      doneCount -
      waitingCount -
      failedCount -
      runningCount,
  );

  // Selected node details
  const selectedNodeRecord = selectedNodePath
    ? (runState.nodes[selectedNodePath] ??
      findNodeRecord(runState.nodes, selectedNodePath))
    : undefined;
  const selectedNodeDef = findNodeDef(definition?.nodes, selectedNodePath);
  const currentPendingQuestion = selectedNodePath
    ? inbox.questions.find(
        (q) => q.runId === runId && q.nodePath === selectedNodePath,
      )
    : undefined;
  const currentPendingApproval = selectedNodePath
    ? inbox.approvals.find(
        (a) => a.runId === runId && a.nodePath === selectedNodePath,
      )
    : undefined;

  // Filter events for selected node
  const nodeEvents = events.filter((ev) => {
    if (!selectedNodePath) return false;
    const record = ev as { path?: string; type?: string };
    return (
      record.path === selectedNodePath ||
      (record.type === "step" && record.path === selectedNodePath)
    );
  });

  // Layout calculation for top-level cards and containers
  let curTop = 30;
  interface ChildLayout {
    node: WorkflowNodeItem;
    top: number;
    height: number;
    left: number;
    width: number;
  }
  interface LayoutItem {
    node: WorkflowNodeItem;
    top: number;
    height: number;
    left: number;
    width: number;
    children?: ChildLayout[];
  }
  const layouts: LayoutItem[] = [];

  for (const node of definition?.nodes ?? []) {
    if (node.kind === "group" || node.kind === "foreach") {
      const childCount = Math.max(1, node.nodes?.length ?? 1);
      const h = 54 + childCount * 140 + 16;
      const children: ChildLayout[] = (node.nodes ?? []).map((cn, cidx) => ({
        node: cn,
        top: 54 + cidx * 140,
        height: 120,
        left: 142,
        width: 236,
      }));
      layouts.push({
        node,
        top: curTop,
        height: h,
        left: 220,
        width: 520,
        children,
      });
      curTop += h + 40;
    } else {
      layouts.push({
        node,
        top: curTop,
        height: 120,
        left: 362,
        width: 236,
      });
      curTop += 160;
    }
  }

  const centerMap = new Map<
    string,
    { x: number; yTop: number; yBottom: number }
  >();
  for (const l of layouts) {
    centerMap.set(l.node.id, {
      x: l.left + l.width / 2,
      yTop: l.top,
      yBottom: l.top + l.height,
    });
    if (l.children) {
      for (const cl of l.children) {
        centerMap.set(cl.node.id, {
          x: l.left + cl.left + cl.width / 2,
          yTop: l.top + cl.top,
          yBottom: l.top + cl.top + cl.height,
        });
      }
    }
  }

  const worldHeight = Math.max(900, curTop + 60);

  const renderCard = (
    node: WorkflowNodeItem,
    nodePath: string,
    style: React.CSSProperties,
  ) => {
    const nodeRecord =
      runState.nodes[nodePath] ?? findNodeRecord(runState.nodes, nodePath);
    const isSelected = selectedNodePath === nodePath;
    const hasPendingQ = inbox.questions.some(
      (q) =>
        q.runId === runId &&
        (q.nodePath === nodePath || q.nodePath.endsWith(`/${node.id}`)),
    );
    const hasPendingAppr = inbox.approvals.some(
      (a) =>
        a.runId === runId &&
        (a.nodePath === nodePath || a.nodePath.endsWith(`/${node.id}`)),
    );

    let stateClass = "s-pend";
    let stateLabel = "Pending";
    if (nodeRecord?.state === "succeeded") {
      stateClass = "s-ok";
      stateLabel = "Succeeded";
    } else if (nodeRecord?.state === "running") {
      stateClass = "s-run";
      stateLabel = "Running...";
    } else if (nodeRecord?.state === "failed") {
      stateClass = "s-fail";
      stateLabel = "Failed";
    } else if (hasPendingQ) {
      stateClass = "s-wait";
      stateLabel = "Waiting for answer";
    } else if (hasPendingAppr) {
      stateClass = "s-wait";
      stateLabel = "Waiting for approval";
    }

    const costVal = nodeRecord?.result?.usage?.costUsd;

    return (
      <button
        key={nodePath}
        type="button"
        className={`card ${stateClass} ${isSelected ? "sel" : ""}`}
        style={{
          ...style,
          textAlign: "left",
        }}
        onClick={() => {
          setSelectedNodePath(nodePath);
          if (hasPendingQ) setActiveTab("questions");
        }}
      >
        <div className="head">
          <span>{node.id}</span>
          <div className="marks">
            {node.writable && <span title="Writable node">✎</span>}
            {node.definition &&
              "interactive" in node.definition &&
              node.definition.interactive && (
                <span title="Interactive node">💬</span>
              )}
            {node.approval && <span title="Requires approval">🛡</span>}
          </div>
        </div>

        <div className="model">
          <span className="id">
            {node.definition && "model" in node.definition
              ? `${node.definition.model} · ${node.definition.thinkingLevel}`
              : node.kind}
          </span>
        </div>

        <div className="task">
          {node.definition && "task" in node.definition
            ? node.definition.task
            : node.definition && "command" in node.definition
              ? `$ ${node.definition.command}`
              : node.kind}
        </div>

        <div className="state">
          <span>{stateLabel}</span>
          {costVal !== undefined && (
            <span className="dur">${costVal.toFixed(2)}</span>
          )}
        </div>
      </button>
    );
  };

  return (
    <div className="main">
      {/* Topbar */}
      <header className="topbar">
        <button
          className="btn"
          type="button"
          onClick={onBack}
          title="Back to Runs list"
        >
          ← Runs
        </button>
        <span className="title">
          <span className="up">{definition?.name ?? "Workflow"} /</span> {runId}
        </span>
        <span className="code quiet" title="Target repository and start commit">
          {runState.repoDir} at {runState.headCommit.slice(0, 7)}
        </span>

        {/* Status Badge */}
        <span
          className={`badge-status ${
            runState.status === "succeeded"
              ? "badge-succeeded"
              : runState.status === "running" || runState.status === "pending"
                ? waitingCount > 0
                  ? "badge-waiting"
                  : "badge-running"
                : runState.status === "failed" ||
                    runState.status === "budget_exceeded"
                  ? "badge-failed"
                  : "badge-waiting"
          }`}
        >
          {(runState.status === "running" || runState.status === "pending") &&
            (waitingCount > 0 ? "⏳ Waiting for input" : "● Running")}
          {runState.status === "succeeded" && "✓ Succeeded"}
          {runState.status === "failed" && "✕ Failed"}
          {runState.status === "aborted" && "⏹ Aborted"}
          {runState.status === "budget_exceeded" && "⚠ Budget Exceeded"}
        </span>

        <span className="grow" />

        {/* Control Buttons */}
        {(runState.status === "running" || runState.status === "pending") && (
          <button className="btn stop" type="button" onClick={handleStopRun}>
            Stop run
          </button>
        )}

        {(runState.status === "failed" ||
          runState.status === "aborted" ||
          runState.status === "budget_exceeded") && (
          <>
            {runState.status === "budget_exceeded" && (
              <div
                style={{ display: "flex", alignItems: "center", gap: "6px" }}
              >
                <span className="quiet" style={{ fontSize: "11px" }}>
                  New Budget:
                </span>
                <input
                  type="number"
                  step="0.1"
                  min="0"
                  placeholder="Increase budget"
                  value={newBudgetUsd ?? ""}
                  onChange={(e) =>
                    setNewBudgetUsd(
                      e.target.value
                        ? Number.parseFloat(e.target.value)
                        : undefined,
                    )
                  }
                  style={{ width: "90px", height: "26px", fontSize: "11.5px" }}
                />
              </div>
            )}
            <button
              className="btn primary"
              type="button"
              onClick={handleResumeRun}
            >
              Resume run
            </button>
          </>
        )}
      </header>

      {/* Runbar */}
      <div className="runbar">
        <div className="stat">
          <span className="k">Elapsed</span>
          <span className="v">{elapsedStr}</span>
        </div>
        <div className="stat">
          <span className="k">Cost</span>
          <span className="v">
            {runState.totalUsage.costUsd !== undefined ? (
              <>
                ${runState.totalUsage.costUsd.toFixed(2)}
                {budget !== undefined && (
                  <>
                    <span className="meter" title={`${costPercent}% of budget`}>
                      <i style={{ width: `${costPercent}%` }} />
                    </span>
                    <span className="k">of ${budget.toFixed(2)}</span>
                  </>
                )}
              </>
            ) : (
              <>
                <span title="Model catalog has no rate; cost unknown">
                  — (unknown)
                </span>
                {budget !== undefined && (
                  <span className="k" style={{ marginLeft: "4px" }}>
                    (budget ${budget.toFixed(2)})
                  </span>
                )}
              </>
            )}
          </span>
        </div>
        <div className="stat">
          <span className="k">You stepped in</span>
          <span className="v">{interventionsCount} times</span>
        </div>

        <div className="progress">
          <div className="progress-bar">
            {doneCount > 0 && (
              <i style={{ flex: doneCount, background: "var(--ok)" }} />
            )}
            {waitingCount > 0 && (
              <i style={{ flex: waitingCount, background: "var(--wait)" }} />
            )}
            {runningCount > 0 && (
              <i style={{ flex: runningCount, background: "var(--run)" }} />
            )}
            {failedCount > 0 && (
              <i style={{ flex: failedCount, background: "var(--fail)" }} />
            )}
            {pendingCount > 0 && (
              <i
                style={{ flex: pendingCount, background: "var(--line-strong)" }}
              />
            )}
          </div>
          <div className="progress-legend">
            {doneCount > 0 && <span className="t-ok">✓ {doneCount} done</span>}
            {waitingCount > 0 && (
              <span className="t-wait">⏳ {waitingCount} waiting</span>
            )}
            {runningCount > 0 && (
              <span className="t-run">● {runningCount} running</span>
            )}
            {failedCount > 0 && (
              <span className="t-fail">✕ {failedCount} failed</span>
            )}
          </div>
        </div>
      </div>

      {/* Work Canvas + Drawer */}
      <div className="work">
        <div className="canvas-col">
          <div className="canvas run">
            <span className="snapshot-badge">
              Read-only snapshot from run start
            </span>

            <div className="world" style={{ height: `${worldHeight}px` }}>
              {/* Dependency lines between cards */}
              <svg className="edges" aria-hidden="true">
                <defs>
                  <marker
                    id="arrow"
                    viewBox="0 0 10 10"
                    refX="6"
                    refY="5"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto-start-reverse"
                  >
                    <path d="M 0 1 L 8 5 L 0 9 z" fill="var(--edge)" />
                  </marker>
                </defs>
                {layouts.flatMap((layout) => {
                  const deps = layout.node.dependsOn ?? [];
                  const targetCenter = centerMap.get(layout.node.id);
                  if (!targetCenter) return [];
                  return deps.map((dep) => {
                    const fromCenter = centerMap.get(dep);
                    if (!fromCenter) return null;
                    return (
                      <g key={`edge-${dep}-${layout.node.id}`}>
                        <path
                          d={`M ${fromCenter.x} ${fromCenter.yBottom} L ${targetCenter.x} ${targetCenter.yTop}`}
                          fill="none"
                          stroke="var(--edge)"
                          strokeWidth="1.5"
                          markerEnd="url(#arrow)"
                        />
                      </g>
                    );
                  });
                })}
              </svg>

              {/* Node Cards & Containers */}
              {layouts.map((layout) => {
                const node = layout.node;

                if (node.kind === "group") {
                  const availableRounds = getGroupRounds(
                    runState.nodes,
                    node.id,
                  );
                  const selectedRound =
                    groupRounds[node.id] ??
                    availableRounds[availableRounds.length - 1] ??
                    1;
                  const roundIdx = Math.max(
                    0,
                    availableRounds.indexOf(selectedRound),
                  );

                  return (
                    <div
                      key={node.id}
                      className="frame"
                      style={{
                        position: "absolute",
                        left: `${layout.left}px`,
                        top: `${layout.top}px`,
                        width: `${layout.width}px`,
                        height: `${layout.height}px`,
                      }}
                    >
                      <div className="fh">
                        <span className="kind">
                          <span
                            style={{ fontSize: "14px", marginRight: "4px" }}
                          >
                            🔄
                          </span>
                          Repeat
                        </span>
                        <span className="name">{node.id}</span>
                        {node.until && (
                          <span className="rule" title={node.until.ref}>
                            until: {node.until.ref}
                          </span>
                        )}
                        <div style={{ marginLeft: "auto" }}>
                          <span className="stepper">
                            <button
                              type="button"
                              title="Previous round"
                              disabled={roundIdx <= 0}
                              onClick={() => {
                                const prevRound = availableRounds[roundIdx - 1];
                                if (prevRound !== undefined) {
                                  setGroupRounds((prev) => ({
                                    ...prev,
                                    [node.id]: prevRound,
                                  }));
                                }
                              }}
                            >
                              ‹
                            </button>
                            <b>
                              Round {selectedRound} of {availableRounds.length}
                            </b>
                            <button
                              type="button"
                              title="Next round"
                              disabled={roundIdx >= availableRounds.length - 1}
                              onClick={() => {
                                const nextRound = availableRounds[roundIdx + 1];
                                if (nextRound !== undefined) {
                                  setGroupRounds((prev) => ({
                                    ...prev,
                                    [node.id]: nextRound,
                                  }));
                                }
                              }}
                            >
                              ›
                            </button>
                          </span>
                        </div>
                      </div>

                      {layout.children?.map((cl) => {
                        const candidatePath =
                          Object.keys(runState.nodes).find(
                            (k) =>
                              k.includes(`${node.id}/`) &&
                              k.includes(`round-${selectedRound}`) &&
                              k.endsWith(`/${cl.node.id}`),
                          ) ??
                          `${node.id}/round-${selectedRound}/${cl.node.id}`;

                        return renderCard(cl.node, candidatePath, {
                          position: "absolute",
                          left: `${cl.left}px`,
                          top: `${cl.top}px`,
                        });
                      })}
                    </div>
                  );
                }

                if (node.kind === "foreach") {
                  const availableItems = getForeachItems(
                    runState.nodes,
                    node.id,
                  );
                  const selectedItem =
                    foreachItems[node.id] ??
                    availableItems[availableItems.length - 1] ??
                    0;
                  const itemIdx = Math.max(
                    0,
                    availableItems.indexOf(selectedItem),
                  );

                  return (
                    <div key={`stack-${node.id}`}>
                      <div
                        className="stack-layer far"
                        style={{
                          left: `${layout.left + 8}px`,
                          top: `${layout.top - 8}px`,
                          width: `${layout.width}px`,
                          height: `${layout.height}px`,
                        }}
                      />
                      <div
                        className="stack-layer"
                        style={{
                          left: `${layout.left + 4}px`,
                          top: `${layout.top - 4}px`,
                          width: `${layout.width}px`,
                          height: `${layout.height}px`,
                        }}
                      />
                      <div
                        className="frame"
                        style={{
                          position: "absolute",
                          left: `${layout.left}px`,
                          top: `${layout.top}px`,
                          width: `${layout.width}px`,
                          height: `${layout.height}px`,
                        }}
                      >
                        <div className="fh">
                          <span className="kind">
                            <span
                              style={{ fontSize: "14px", marginRight: "4px" }}
                            >
                              📚
                            </span>
                            Foreach
                          </span>
                          <span className="name">{node.id}</span>
                          {node.source && (
                            <span className="rule" title={node.source}>
                              source: {node.source}
                            </span>
                          )}
                          <div style={{ marginLeft: "auto" }}>
                            <span className="stepper">
                              <button
                                type="button"
                                title="Previous item"
                                disabled={itemIdx <= 0}
                                onClick={() => {
                                  const prevItem = availableItems[itemIdx - 1];
                                  if (prevItem !== undefined) {
                                    setForeachItems((prev) => ({
                                      ...prev,
                                      [node.id]: prevItem,
                                    }));
                                  }
                                }}
                              >
                                ‹
                              </button>
                              <b>
                                Item {selectedItem + 1} of{" "}
                                {availableItems.length}
                              </b>
                              <button
                                type="button"
                                title="Next item"
                                disabled={itemIdx >= availableItems.length - 1}
                                onClick={() => {
                                  const nextItem = availableItems[itemIdx + 1];
                                  if (nextItem !== undefined) {
                                    setForeachItems((prev) => ({
                                      ...prev,
                                      [node.id]: nextItem,
                                    }));
                                  }
                                }}
                              >
                                ›
                              </button>
                            </span>
                          </div>
                        </div>

                        {layout.children?.map((cl) => {
                          const candidatePath =
                            Object.keys(runState.nodes).find(
                              (k) =>
                                k.includes(`${node.id}/`) &&
                                k.includes(`item-${selectedItem}`) &&
                                k.endsWith(`/${cl.node.id}`),
                            ) ??
                            `${node.id}/item-${selectedItem}/${cl.node.id}`;

                          return renderCard(cl.node, candidatePath, {
                            position: "absolute",
                            left: `${cl.left}px`,
                            top: `${cl.top}px`,
                          });
                        })}
                      </div>
                    </div>
                  );
                }

                return renderCard(layout.node, layout.node.id, {
                  position: "absolute",
                  left: `${layout.left}px`,
                  top: `${layout.top}px`,
                });
              })}
            </div>
          </div>
        </div>

        {/* Right Drawer */}
        {selectedNodePath && (
          <aside className="drawer" aria-label="Node detail">
            <div className="dh">
              <b>{selectedNodePath}</b>
              <span className="quiet">{selectedNodeDef?.kind ?? "Node"}</span>
              <button
                className="close"
                type="button"
                title="Close drawer"
                onClick={() => setSelectedNodePath(null)}
              >
                ×
              </button>
            </div>

            <div className="ctx">
              {selectedNodeDef?.definition &&
                "model" in selectedNodeDef.definition && (
                  <span className="code">
                    {selectedNodeDef.definition.model}
                  </span>
                )}
              {selectedNodeRecord?.result?.usage?.costUsd !== undefined && (
                <span>
                  Cost:{" "}
                  <b>${selectedNodeRecord.result.usage.costUsd.toFixed(2)}</b>
                </span>
              )}
            </div>

            {/* Tab navigation */}
            <div className="tabs" role="tablist">
              <button
                className={`tab ${activeTab === "task" ? "on" : ""}`}
                type="button"
                onClick={() => setActiveTab("task")}
              >
                Task
              </button>
              <button
                className={`tab ${activeTab === "questions" ? "on" : ""}`}
                type="button"
                onClick={() => setActiveTab("questions")}
              >
                Questions {currentPendingQuestion && "•"}
              </button>
              <button
                className={`tab ${activeTab === "events" ? "on" : ""}`}
                type="button"
                onClick={() => setActiveTab("events")}
              >
                Events
              </button>
              <button
                className={`tab ${activeTab === "outputs" ? "on" : ""}`}
                type="button"
                onClick={() => setActiveTab("outputs")}
              >
                Outputs
              </button>
              {selectedNodeDef?.writable && (
                <button
                  className={`tab ${activeTab === "diff" ? "on" : ""}`}
                  type="button"
                  onClick={() => setActiveTab("diff")}
                >
                  Diff
                </button>
              )}
            </div>

            {/* Drawer Body */}
            <div className="dbody">
              {/* Task Tab */}
              {activeTab === "task" && (
                <div className="pane">
                  <span style={{ fontWeight: 600, fontSize: "12px" }}>
                    Task Definition
                  </span>
                  <div className="pre-box">
                    {previewData?.content ||
                      (selectedNodeDef?.definition &&
                      "task" in selectedNodeDef.definition
                        ? selectedNodeDef.definition.task
                        : selectedNodeDef?.definition &&
                            "command" in selectedNodeDef.definition
                          ? `$ ${selectedNodeDef.definition.command}`
                          : "No task content")}
                  </div>

                  {selectedNodeDef?.definition &&
                    "instructions" in selectedNodeDef.definition &&
                    selectedNodeDef.definition.instructions && (
                      <div style={{ marginTop: "10px" }}>
                        <span style={{ fontWeight: 600, fontSize: "12px" }}>
                          Instructions
                        </span>
                        <div className="pre-box">
                          {selectedNodeDef.definition.instructions}
                        </div>
                      </div>
                    )}

                  {selectedNodeRecord?.result?.error && (
                    <div className="alert-error" style={{ marginTop: "10px" }}>
                      <b>Node Failed:</b> {selectedNodeRecord.result.error}
                    </div>
                  )}
                </div>
              )}

              {/* Questions Tab */}
              {activeTab === "questions" && (
                <div className="pane">
                  <div className="transcript">
                    {/* Past interactions for this node */}
                    {interactions
                      .filter(
                        (i) =>
                          i.nodePath === selectedNodePath &&
                          i.type === "question",
                      )
                      .map((turn) => (
                        <div key={turn.id} className="turn">
                          <div className="who">
                            <b>{turn.nodePath}</b> asked at{" "}
                            {new Date(turn.createdAt).toLocaleTimeString()}
                          </div>
                          <div className="q">{turn.question?.prompt}</div>
                          {turn.answeredAt && (
                            <div className="a">
                              <b>You answered:</b>{" "}
                              {turn.answer?.text ?? turn.answer?.optionId}
                            </div>
                          )}
                        </div>
                      ))}

                    {/* Current Waiting Question */}
                    {currentPendingQuestion && (
                      <div className="turn now">
                        <div
                          className="who"
                          style={{ color: "var(--wait)", fontWeight: 600 }}
                        >
                          {currentPendingQuestion.nodePath} is waiting for your
                          answer:
                        </div>
                        <div className="q">
                          {currentPendingQuestion.question.prompt}
                        </div>

                        {currentPendingQuestion.question.options.length > 0 && (
                          <div className="choices">
                            {currentPendingQuestion.question.options.map(
                              (opt, i) => (
                                <button
                                  key={opt.id}
                                  className="choice-btn"
                                  type="button"
                                  disabled={actionLoading}
                                  onClick={() =>
                                    handleSendAnswer(opt.label, opt.id)
                                  }
                                >
                                  <kbd>{i + 1}</kbd>
                                  <span>{opt.label}</span>
                                </button>
                              ),
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Events Tab */}
              {activeTab === "events" && (
                <div
                  className="pane"
                  ref={eventsContainerRef}
                  style={{ maxHeight: "100%", overflowY: "auto" }}
                  onScroll={(e) => {
                    const el = e.currentTarget;
                    userScrolledUpRef.current =
                      el.scrollHeight - el.scrollTop - el.clientHeight > 40;
                  }}
                >
                  <div className="events">
                    {nodeEvents.length === 0 ? (
                      <p className="quiet">
                        No events recorded for this node yet.
                      </p>
                    ) : (
                      nodeEvents.map((rawEv) => {
                        const ev = rawEv as {
                          type?: string;
                          event?: StepEvent;
                          at?: string;
                        };
                        const stepEv = ev.event ?? (rawEv as StepEvent);
                        const time = stepEv.at
                          ? new Date(stepEv.at).toLocaleTimeString()
                          : "";
                        return (
                          <div
                            key={`${stepEv.at ?? ""}-${stepEv.type ?? ""}-${stepEv.summary ?? ""}`}
                            className="ev"
                          >
                            <span className="t">{time}</span>
                            <span className="s">
                              {stepEv.summary || JSON.stringify(stepEv)}
                            </span>
                            {stepEv.usage && (
                              <span className="m">
                                {stepEv.usage.inputTokens} in,{" "}
                                {stepEv.usage.outputTokens} out
                              </span>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              )}

              {/* Outputs Tab */}
              {activeTab === "outputs" && (
                <div className="pane">
                  <span style={{ fontWeight: 600, fontSize: "12px" }}>
                    Declared Outputs
                  </span>
                  {selectedNodeDef?.definition &&
                  "outputs" in selectedNodeDef.definition &&
                  selectedNodeDef.definition.outputs.length > 0 ? (
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: "6px",
                      }}
                    >
                      {selectedNodeDef.definition.outputs.map((fileName) => (
                        <div
                          key={fileName}
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            padding: "6px 10px",
                            background: "var(--sunken)",
                            borderRadius: "4px",
                          }}
                        >
                          <span className="code">{fileName}</span>
                          <button
                            className="btn"
                            type="button"
                            style={{ height: "24px", fontSize: "11px" }}
                            onClick={() => setSelectedOutputFile(fileName)}
                          >
                            Preview
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="quiet">No outputs declared for this node.</p>
                  )}

                  {selectedOutputFile && previewData && (
                    <div style={{ marginTop: "12px" }}>
                      <span style={{ fontWeight: 600, fontSize: "12px" }}>
                        Preview: {selectedOutputFile} ({previewData.size} bytes)
                      </span>
                      <div className="pre-box">
                        {previewData.content || "<Empty file>"}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Diff Tab */}
              {activeTab === "diff" && (
                <div className="pane">
                  <span style={{ fontWeight: 600, fontSize: "12px" }}>
                    Git Checkpoint Diff
                  </span>
                  <div className="pre-box">
                    {previewData?.content || "No diff recorded for this node."}
                  </div>
                </div>
              )}

              {/* Approval Box in Drawer if Waiting */}
              {currentPendingApproval && (
                <div
                  style={{
                    marginTop: "16px",
                    padding: "12px",
                    background: "var(--sunken)",
                    border: "1px solid var(--wait)",
                    borderRadius: "6px",
                  }}
                >
                  <span
                    style={{
                      fontWeight: 600,
                      color: "var(--wait)",
                      fontSize: "12px",
                    }}
                  >
                    Approval Required
                  </span>
                  <p style={{ margin: "6px 0", fontSize: "12px" }}>
                    {currentPendingApproval.request.reason === "group_exhausted"
                      ? "Group reached maximum round limit. Approve to succeed, or reject with feedback to run another round."
                      : "Node completed successfully. Manual approval required before continuing to downstream nodes."}
                  </p>

                  <div style={{ marginTop: "8px" }}>
                    <label
                      htmlFor="reject-feedback-input"
                      style={{
                        display: "block",
                        fontSize: "11px",
                        color: "var(--muted)",
                        marginBottom: "3px",
                      }}
                    >
                      Feedback (required if rejecting):
                    </label>
                    <textarea
                      id="reject-feedback-input"
                      placeholder="Explain what to fix or refine..."
                      value={rejectFeedback}
                      onChange={(e) => setRejectFeedback(e.target.value)}
                      style={{ width: "100%", height: "48px" }}
                    />
                  </div>

                  <div
                    style={{ display: "flex", gap: "8px", marginTop: "10px" }}
                  >
                    <button
                      className="btn primary"
                      type="button"
                      disabled={actionLoading}
                      onClick={() => handleApprove(true)}
                    >
                      Approve
                    </button>
                    <button
                      className="btn stop"
                      type="button"
                      disabled={actionLoading || !rejectFeedback.trim()}
                      onClick={() => handleApprove(false)}
                    >
                      Reject with Feedback
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Answer Composer (Bottom of Drawer when Question Active) */}
            {activeTab === "questions" && currentPendingQuestion && (
              <div className="composer">
                <textarea
                  placeholder="Type an answer, or press a number key for options..."
                  value={answerText}
                  onChange={(e) => setAnswerText(e.target.value)}
                />
                <div
                  style={{ display: "flex", alignItems: "center", gap: "6px" }}
                >
                  <label
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "5px",
                      cursor: "pointer",
                      fontSize: "11.5px",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={isSecret}
                      onChange={(e) => setIsSecret(e.target.checked)}
                    />
                    <span>Secret answer</span>
                  </label>
                  <span className="quiet" style={{ fontSize: "11px" }}>
                    (sent to session, masked in disk history)
                  </span>
                </div>
                <div className="foot">
                  <span>If platform restarts, node restarts.</span>
                  <span className="grow" />
                  <button
                    className="btn primary"
                    type="button"
                    disabled={actionLoading || !answerText.trim()}
                    onClick={() => handleSendAnswer()}
                  >
                    Send answer
                  </button>
                </div>
              </div>
            )}
          </aside>
        )}
      </div>
    </div>
  );
};
