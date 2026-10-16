import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  type DurableRunResult,
  type DurableRunState,
  loadDurableRunState,
  resumeDurableWorkflow,
  saveStateAtomic,
  startDurableWorkflow,
  validateRepository,
  type WorkflowCapabilities,
  type WorkflowDefinition,
} from "@aipilotagent/engine";
import type {
  Answer,
  Question,
  StepEvent,
  StepRunner,
} from "@aipilotagent/runner";
import {
  assertNoPathTraversal,
  ensureDir,
  getRunsDir,
  safeId,
} from "./storage.ts";
import { getWorkflow, validateWorkflow } from "./workflow-library.ts";

export type ServerEvent =
  | { type: "state"; runId: string; event: unknown }
  | { type: "step"; runId: string; path: string; event: StepEvent }
  | { type: "question"; runId: string; path: string; question: Question }
  | { type: "question_answered"; runId: string; path: string }
  | {
      type: "approval";
      runId: string;
      path: string;
      request: {
        path: string;
        reason: string;
        outputs: Record<string, string>;
      };
    }
  | {
      type: "approval_handled";
      runId: string;
      path: string;
      approved: boolean;
      feedback?: string;
    }
  | { type: "run_finished"; runId: string; status: string };

export interface PendingQuestion {
  nodePath: string;
  question: Question;
  resolve: (answer: Answer) => void;
  reject: (error: Error) => void;
  createdAt: string;
}

export interface PendingApproval {
  nodePath: string;
  request: { path: string; reason: string; outputs: Record<string, string> };
  resolve: (
    decision: { approved: true } | { approved: false; feedback: string },
  ) => void;
  reject: (error: Error) => void;
  createdAt: string;
}

export interface PendingQuestionInfo {
  runId: string;
  nodePath: string;
  question: Question;
  createdAt: string;
}

export interface PendingApprovalInfo {
  runId: string;
  nodePath: string;
  request: { path: string; reason: string; outputs: Record<string, string> };
  createdAt: string;
}

interface ActiveRun {
  runId: string;
  runDir: string;
  controller: AbortController;
  promise?: Promise<DurableRunResult>;
  subscribers: Set<(event: ServerEvent) => void>;
  pendingQuestions: Map<string, PendingQuestion>;
  pendingApprovals: Map<string, PendingApproval>;
}

export interface RunManagerOptions {
  dataDir: string;
  runner: StepRunner;
  capabilities?: WorkflowCapabilities;
}

export class RunManager {
  readonly dataDir: string;
  private runner: StepRunner;
  private capabilities: WorkflowCapabilities;
  private activeRuns = new Map<string, ActiveRun>();

  constructor(options: RunManagerOptions) {
    this.dataDir = resolve(options.dataDir);
    this.runner = options.runner;
    this.capabilities = options.capabilities ?? {
      models: {
        "anthropic/claude-haiku-5-5": ["off", "low"],
        "codexJ/gpt-6-luna": ["off", "low", "medium", "high"],
        "openai/gpt-5-mini": ["off", "low"],
        "fake/small": ["off", "low", "medium", "high"],
      },
    };
  }

  async startRun(options: {
    workflowId?: string;
    workflowYaml?: string;
    targetRepo: string;
    inputs: Record<string, string>;
    runId?: string;
    budgetUsd?: number;
  }): Promise<{ runId: string; state: DurableRunState; warnings: string[] }> {
    let workflowDef: WorkflowDefinition;
    if (options.workflowYaml) {
      workflowDef = await validateWorkflow(
        options.workflowYaml,
        this.capabilities,
      );
    } else if (options.workflowId) {
      const item = await getWorkflow(this.dataDir, options.workflowId);
      workflowDef = await validateWorkflow(item.yaml, this.capabilities);
    } else {
      throw new Error("either workflowId or workflowYaml is required");
    }

    if (options.budgetUsd !== undefined) {
      if (typeof options.budgetUsd !== "number" || options.budgetUsd < 0) {
        throw new Error("budgetUsd must be a non-negative number");
      }
      workflowDef.budgetUsd = options.budgetUsd;
    }

    const repoStatus = await validateRepository(options.targetRepo);
    const warnings: string[] = [];
    if (repoStatus.hasUncommittedChanges) {
      warnings.push(
        "target repository has uncommitted changes which will not be included in the run",
      );
    }

    const runId =
      options.runId ??
      `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    safeId(runId, "run ID");

    const runsDir = getRunsDir(this.dataDir);
    await ensureDir(runsDir);
    const runDir = join(runsDir, runId);
    assertNoPathTraversal(runsDir, runDir);

    const controller = new AbortController();
    const subscribers = new Set<(event: ServerEvent) => void>();
    const pendingQuestions = new Map<string, PendingQuestion>();
    const pendingApprovals = new Map<string, PendingApproval>();

    const broadcast = (event: ServerEvent) => {
      for (const sub of subscribers) {
        try {
          sub(event);
        } catch {
          // Ignore subscriber error
        }
      }
    };

    const activeRun: ActiveRun = {
      runId,
      runDir,
      controller,
      subscribers,
      pendingQuestions,
      pendingApprovals,
    };
    this.activeRuns.set(runId, activeRun);

    // Start durable workflow
    activeRun.promise = startDurableWorkflow({
      workflow: workflowDef,
      runner: this.runner,
      repoDir: options.targetRepo,
      runDir,
      inputs: options.inputs,
      runId,
      signal: controller.signal,
      callbacks: {
        onState: (event) => {
          broadcast({ type: "state", runId, event });
        },
        onStepEvent: (path, event) => {
          broadcast({ type: "step", runId, path, event });
        },
        ask: (path, question) => {
          if (controller.signal.aborted) {
            throw new Error("run aborted");
          }
          return new Promise<Answer>((resolve, reject) => {
            pendingQuestions.set(path, {
              nodePath: path,
              question,
              resolve,
              reject,
              createdAt: new Date().toISOString(),
            });
            broadcast({ type: "question", runId, path, question });
          });
        },
        approve: (request) => {
          if (controller.signal.aborted) {
            throw new Error("run aborted");
          }
          return new Promise<
            { approved: true } | { approved: false; feedback: string }
          >((resolve, reject) => {
            pendingApprovals.set(request.path, {
              nodePath: request.path,
              request,
              resolve,
              reject,
              createdAt: new Date().toISOString(),
            });
            broadcast({ type: "approval", runId, path: request.path, request });
          });
        },
      },
    });

    // Handle completion in background
    void activeRun.promise
      .then((res) => {
        broadcast({ type: "run_finished", runId, status: res.state.status });
      })
      .catch((_err) => {
        broadcast({
          type: "run_finished",
          runId,
          status: controller.signal.aborted ? "aborted" : "failed",
        });
      })
      .finally(() => {
        this.activeRuns.delete(runId);
      });

    // Wait briefly for state.json to exist on disk
    let state: DurableRunState | undefined;
    for (let i = 0; i < 20; i++) {
      try {
        state = await loadDurableRunState(runDir);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    const resolvedState = state ?? (await loadDurableRunState(runDir));

    return {
      runId,
      state: resolvedState,
      warnings,
    };
  }

  async listRuns(): Promise<DurableRunState[]> {
    const runsDir = getRunsDir(this.dataDir);
    await ensureDir(runsDir);
    const entries = await readdir(runsDir, { withFileTypes: true });
    const states: DurableRunState[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const runDir = join(runsDir, entry.name);
      try {
        const state = await loadDurableRunState(runDir);
        states.push(state);
      } catch {
        // Skip unreadable run dir
      }
    }

    states.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
    return states;
  }

  async getRun(runId: string): Promise<DurableRunState> {
    const cleanId = safeId(runId, "run ID");
    const runsDir = getRunsDir(this.dataDir);
    const runDir = join(runsDir, cleanId);
    assertNoPathTraversal(runsDir, runDir);
    return loadDurableRunState(runDir);
  }

  async getRunEvents(runId: string, fromIndex = 0): Promise<unknown[]> {
    const cleanId = safeId(runId, "run ID");
    const runsDir = getRunsDir(this.dataDir);
    const runDir = join(runsDir, cleanId);
    assertNoPathTraversal(runsDir, runDir);

    try {
      const text = await readFile(join(runDir, "events.jsonl"), "utf8");
      const lines = text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      const events: unknown[] = [];
      for (const line of lines.slice(fromIndex)) {
        try {
          events.push(JSON.parse(line));
        } catch {
          // ignore corrupted lines
        }
      }
      return events;
    } catch {
      return [];
    }
  }

  subscribeEvents(
    runId: string,
    listener: (event: ServerEvent) => void,
  ): () => void {
    const active = this.activeRuns.get(runId);
    if (!active) {
      // Return a no-op unsubscribe if run is not active
      return () => {};
    }
    active.subscribers.add(listener);
    return () => {
      active.subscribers.delete(listener);
    };
  }

  async answerQuestion(
    runId: string,
    nodePath: string,
    answer: Answer,
  ): Promise<void> {
    const active = this.activeRuns.get(runId);
    if (!active) {
      throw new Error(`run is not active: ${runId}`);
    }
    const pending = active.pendingQuestions.get(nodePath);
    if (!pending) {
      throw new Error(
        `no pending question for node ${nodePath} in run ${runId}`,
      );
    }

    if (
      (!answer.text || answer.text.trim().length === 0) &&
      (!answer.optionId || answer.optionId.trim().length === 0)
    ) {
      throw new Error("answer must provide either text or optionId");
    }

    active.pendingQuestions.delete(nodePath);
    pending.resolve(answer);

    for (const sub of active.subscribers) {
      try {
        sub({ type: "question_answered", runId, path: nodePath });
      } catch {
        // ignore
      }
    }
  }

  async handleApproval(
    runId: string,
    nodePath: string,
    decision: { approved: boolean; feedback?: string },
  ): Promise<void> {
    const active = this.activeRuns.get(runId);
    if (!active) {
      throw new Error(`run is not active: ${runId}`);
    }
    const pending = active.pendingApprovals.get(nodePath);
    if (!pending) {
      throw new Error(
        `no pending approval for node ${nodePath} in run ${runId}`,
      );
    }

    if (!decision.approved) {
      if (!decision.feedback || decision.feedback.trim().length === 0) {
        throw new Error("rejection requires non-empty feedback");
      }
      active.pendingApprovals.delete(nodePath);
      pending.resolve({ approved: false, feedback: decision.feedback.trim() });
    } else {
      active.pendingApprovals.delete(nodePath);
      pending.resolve({ approved: true });
    }

    for (const sub of active.subscribers) {
      try {
        sub({
          type: "approval_handled",
          runId,
          path: nodePath,
          approved: decision.approved,
          feedback: decision.feedback,
        });
      } catch {
        // ignore
      }
    }
  }

  async stopRun(runId: string): Promise<void> {
    const active = this.activeRuns.get(runId);
    if (!active) {
      throw new Error(`run is not active: ${runId}`);
    }
    active.controller.abort();
    for (const pending of active.pendingQuestions.values()) {
      pending.reject(new Error("run stopped"));
    }
    active.pendingQuestions.clear();
    for (const pending of active.pendingApprovals.values()) {
      pending.reject(new Error("run stopped"));
    }
    active.pendingApprovals.clear();
    try {
      await active.promise;
    } catch {
      // Expected to reject on abort
    }
  }

  async stopAllRuns(): Promise<void> {
    const activeIds = Array.from(this.activeRuns.keys());
    await Promise.all(
      activeIds.map((id) =>
        this.stopRun(id).catch(() => {
          // Ignore errors on shutdown
        }),
      ),
    );
  }

  async resumeRun(
    runId: string,
    options?: { newBudgetUsd?: number },
  ): Promise<{ runId: string; state: DurableRunState }> {
    const cleanId = safeId(runId, "run ID");
    if (this.activeRuns.has(cleanId)) {
      throw new Error(`run is already active: ${cleanId}`);
    }
    const runsDir = getRunsDir(this.dataDir);
    const runDir = join(runsDir, cleanId);
    assertNoPathTraversal(runsDir, runDir);

    const controller = new AbortController();
    const subscribers = new Set<(event: ServerEvent) => void>();
    const pendingQuestions = new Map<string, PendingQuestion>();
    const pendingApprovals = new Map<string, PendingApproval>();

    const broadcast = (event: ServerEvent) => {
      for (const sub of subscribers) {
        try {
          sub(event);
        } catch {
          // Ignore
        }
      }
    };

    const activeRun: ActiveRun = {
      runId: cleanId,
      runDir,
      controller,
      subscribers,
      pendingQuestions,
      pendingApprovals,
    };
    this.activeRuns.set(cleanId, activeRun);

    activeRun.promise = resumeDurableWorkflow({
      runDir,
      runner: this.runner,
      newBudgetUsd: options?.newBudgetUsd,
      signal: controller.signal,
      callbacks: {
        onState: (event) => {
          broadcast({ type: "state", runId: cleanId, event });
        },
        onStepEvent: (path, event) => {
          broadcast({ type: "step", runId: cleanId, path, event });
        },
        ask: (path, question) => {
          if (controller.signal.aborted) {
            throw new Error("run aborted");
          }
          return new Promise<Answer>((resolve, reject) => {
            pendingQuestions.set(path, {
              nodePath: path,
              question,
              resolve,
              reject,
              createdAt: new Date().toISOString(),
            });
            broadcast({ type: "question", runId: cleanId, path, question });
          });
        },
        approve: (request) => {
          if (controller.signal.aborted) {
            throw new Error("run aborted");
          }
          return new Promise<
            { approved: true } | { approved: false; feedback: string }
          >((resolve, reject) => {
            pendingApprovals.set(request.path, {
              nodePath: request.path,
              request,
              resolve,
              reject,
              createdAt: new Date().toISOString(),
            });
            broadcast({
              type: "approval",
              runId: cleanId,
              path: request.path,
              request,
            });
          });
        },
      },
    });

    void activeRun.promise
      .then((res) => {
        broadcast({
          type: "run_finished",
          runId: cleanId,
          status: res.state.status,
        });
      })
      .catch((_err) => {
        broadcast({
          type: "run_finished",
          runId: cleanId,
          status: controller.signal.aborted ? "aborted" : "failed",
        });
      })
      .finally(() => {
        this.activeRuns.delete(cleanId);
      });

    // Read current state
    const state = await loadDurableRunState(runDir);
    return {
      runId: cleanId,
      state,
    };
  }

  async getInbox(): Promise<{
    questions: PendingQuestionInfo[];
    approvals: PendingApprovalInfo[];
  }> {
    const questions: PendingQuestionInfo[] = [];
    const approvals: PendingApprovalInfo[] = [];

    for (const [runId, active] of this.activeRuns.entries()) {
      for (const [nodePath, q] of active.pendingQuestions.entries()) {
        questions.push({
          runId,
          nodePath,
          question: q.question,
          createdAt: q.createdAt,
        });
      }
      for (const [nodePath, a] of active.pendingApprovals.entries()) {
        approvals.push({
          runId,
          nodePath,
          request: a.request,
          createdAt: a.createdAt,
        });
      }
    }

    return { questions, approvals };
  }

  async recoverInterruptedRunsOnStartup(): Promise<void> {
    const runsDir = getRunsDir(this.dataDir);
    await ensureDir(runsDir);
    const entries = await readdir(runsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const runDir = join(runsDir, entry.name);
      try {
        const state = await loadDurableRunState(runDir);
        if (state.status === "running" || state.status === "pending") {
          // AC-9: Service stopped while run was in progress or waiting for answer.
          // Mark run as failed so it can be cleanly resumed from checkpoints.
          state.status = "failed";
          state.warnings.push(
            "service process exited while run was in progress; incomplete nodes will start fresh upon resume",
          );
          state.updatedAt = new Date().toISOString();
          await saveStateAtomic(runDir, state);
        }
      } catch {
        // Skip
      }
    }
  }
}
