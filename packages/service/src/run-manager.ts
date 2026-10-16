import { constants } from "node:fs";
import { open, readdir, readFile, realpath } from "node:fs/promises";
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
  writeFileAtomic,
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

export interface RecordedInteraction {
  id: string;
  type: "question" | "approval";
  nodePath: string;
  createdAt: string;
  question?: Question;
  approvalRequest?: {
    path: string;
    reason: string;
    outputs: Record<string, string>;
  };
  answeredAt?: string;
  answer?: {
    text: string;
    optionId?: string;
    isSecret?: boolean;
  };
  approvalDecision?: {
    approved: boolean;
    feedback?: string;
  };
}

export interface RunSetupValidation {
  valid: boolean;
  warnings: string[];
  errors: string[];
  missingInputs: string[];
  workflow?: WorkflowDefinition;
}

export interface RunPreviewResult {
  content: string;
  truncated: boolean;
  size: number;
  fileName?: string;
  kind: "diff" | "output" | "task";
}

async function loadInteractions(
  runDir: string,
): Promise<RecordedInteraction[]> {
  const p = join(runDir, "interactions.json");
  try {
    const text = await readFile(p, "utf8");
    return JSON.parse(text) as RecordedInteraction[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function saveInteractions(
  runDir: string,
  list: RecordedInteraction[],
): Promise<void> {
  const p = join(runDir, "interactions.json");
  await writeFileAtomic(p, `${JSON.stringify(list, null, 2)}\n`);
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
  private interactionWrites = new Map<string, Promise<void>>();

  private updateInteractions(
    runDir: string,
    change: (list: RecordedInteraction[]) => void,
  ): Promise<void> {
    const previous = this.interactionWrites.get(runDir) ?? Promise.resolve();
    const next = previous.then(async () => {
      const list = await loadInteractions(runDir);
      change(list);
      await saveInteractions(runDir, list);
    });
    this.interactionWrites.set(runDir, next);
    void next
      .finally(() => {
        if (this.interactionWrites.get(runDir) === next) {
          this.interactionWrites.delete(runDir);
        }
      })
      .catch(() => {});
    return next;
  }

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
        ask: async (path, question) => {
          if (controller.signal.aborted) throw new Error("run aborted");
          const item: RecordedInteraction = {
            id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            type: "question",
            nodePath: path,
            createdAt: new Date().toISOString(),
            question,
          };
          await this.updateInteractions(runDir, (list) => {
            list.push(item);
          });
          if (controller.signal.aborted) throw new Error("run aborted");
          return new Promise<Answer>((resolve, reject) => {
            pendingQuestions.set(path, {
              nodePath: path,
              question,
              resolve,
              reject,
              createdAt: item.createdAt,
            });
            broadcast({ type: "question", runId, path, question });
          });
        },
        approve: async (request) => {
          if (controller.signal.aborted) throw new Error("run aborted");
          const item: RecordedInteraction = {
            id: `appr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            type: "approval",
            nodePath: request.path,
            createdAt: new Date().toISOString(),
            approvalRequest: request,
          };
          await this.updateInteractions(runDir, (list) => {
            list.push(item);
          });
          if (controller.signal.aborted) throw new Error("run aborted");
          return new Promise<
            { approved: true } | { approved: false; feedback: string }
          >((resolve, reject) => {
            pendingApprovals.set(request.path, {
              nodePath: request.path,
              request,
              resolve,
              reject,
              createdAt: item.createdAt,
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
    options?: { secret?: boolean },
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

    // Persist before delivering to the runner. Secret text must never enter the record.
    await this.updateInteractions(active.runDir, (list) => {
      const item = list
        .slice()
        .reverse()
        .find(
          (i) =>
            i.type === "question" && i.nodePath === nodePath && !i.answeredAt,
        );
      if (item) {
        item.answeredAt = new Date().toISOString();
        if (options?.secret) {
          item.answer = {
            text: "(secret)",
            optionId: answer.optionId,
            isSecret: true,
          };
        } else {
          item.answer = {
            text: answer.text,
            optionId: answer.optionId,
            isSecret: false,
          };
        }
      }
    });
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

    if (!decision.approved && !decision.feedback?.trim()) {
      throw new Error("rejection requires non-empty feedback");
    }
    const recordedDecision = decision.approved
      ? { approved: true }
      : { approved: false, feedback: decision.feedback?.trim() };
    await this.updateInteractions(active.runDir, (list) => {
      const item = list
        .slice()
        .reverse()
        .find(
          (i) =>
            i.type === "approval" &&
            i.nodePath === nodePath &&
            !i.approvalDecision,
        );
      if (item) {
        item.answeredAt = new Date().toISOString();
        item.approvalDecision = recordedDecision;
      }
    });
    active.pendingApprovals.delete(nodePath);
    if (recordedDecision.approved) pending.resolve({ approved: true });
    else
      pending.resolve({
        approved: false,
        feedback: recordedDecision.feedback ?? "",
      });

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
        ask: async (path, question) => {
          if (controller.signal.aborted) throw new Error("run aborted");
          const item: RecordedInteraction = {
            id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            type: "question",
            nodePath: path,
            createdAt: new Date().toISOString(),
            question,
          };
          await this.updateInteractions(runDir, (list) => {
            list.push(item);
          });
          if (controller.signal.aborted) throw new Error("run aborted");
          return new Promise<Answer>((resolve, reject) => {
            pendingQuestions.set(path, {
              nodePath: path,
              question,
              resolve,
              reject,
              createdAt: item.createdAt,
            });
            broadcast({ type: "question", runId: cleanId, path, question });
          });
        },
        approve: async (request) => {
          if (controller.signal.aborted) throw new Error("run aborted");
          const item: RecordedInteraction = {
            id: `appr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            type: "approval",
            nodePath: request.path,
            createdAt: new Date().toISOString(),
            approvalRequest: request,
          };
          await this.updateInteractions(runDir, (list) => {
            list.push(item);
          });
          if (controller.signal.aborted) throw new Error("run aborted");
          return new Promise<
            { approved: true } | { approved: false; feedback: string }
          >((resolve, reject) => {
            pendingApprovals.set(request.path, {
              nodePath: request.path,
              request,
              resolve,
              reject,
              createdAt: item.createdAt,
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

  async getRunInteractions(runId: string): Promise<RecordedInteraction[]> {
    const cleanId = safeId(runId, "run ID");
    const runsDir = getRunsDir(this.dataDir);
    const runDir = join(runsDir, cleanId);
    assertNoPathTraversal(runsDir, runDir);
    return loadInteractions(runDir);
  }

  async getRunDefinition(runId: string): Promise<WorkflowDefinition> {
    const cleanId = safeId(runId, "run ID");
    const runsDir = getRunsDir(this.dataDir);
    const runDir = join(runsDir, cleanId);
    assertNoPathTraversal(runsDir, runDir);
    const defPath = join(runDir, "definition.json");
    const text = await readFile(defPath, "utf8");
    return JSON.parse(text) as WorkflowDefinition;
  }

  async getRunPreview(
    runId: string,
    options: {
      nodePath: string;
      kind: "diff" | "output" | "task";
      fileName?: string;
    },
  ): Promise<RunPreviewResult> {
    const cleanId = safeId(runId, "run ID");
    const runsDir = getRunsDir(this.dataDir);
    const runDir = join(runsDir, cleanId);
    assertNoPathTraversal(runsDir, runDir);

    const cleanNodePath = options.nodePath;
    if (
      !cleanNodePath
        ?.split("/")
        .every((segment) =>
          /^(?:[a-zA-Z0-9_-]+|attempt-\d+|round-\d+|item-\d+)$/.test(segment),
        )
    ) {
      throw new Error("invalid nodePath");
    }

    const nodesDir = join(runDir, "nodes");
    const nodeDir = join(nodesDir, cleanNodePath);
    assertNoPathTraversal(nodesDir, nodeDir);

    const state = await loadDurableRunState(runDir);
    const nodeRecord = state.nodes[cleanNodePath];
    if (!nodeRecord) throw new Error("unknown node path");

    let targetFile: string;
    if (options.kind === "diff") {
      if (!nodeRecord.diffPath) throw new Error("diff not available");
      targetFile = nodeRecord.diffPath;
      if (resolve(targetFile) !== resolve(nodeDir, "diff.patch")) {
        throw new Error("invalid diff path");
      }
    } else if (options.kind === "task") {
      // Task text is produced in the latest attempt directory by the runner.
      const entries = await readdir(nodeDir, { withFileTypes: true });
      const attempts = entries
        .filter(
          (entry) => entry.isDirectory() && /^attempt-\d+$/.test(entry.name),
        )
        .sort((a, b) => Number(b.name.slice(8)) - Number(a.name.slice(8)));
      const latestAttempt = attempts[0];
      if (!latestAttempt) throw new Error("task not available");
      targetFile = join(nodeDir, latestAttempt.name, "task.md");
    } else if (options.kind === "output") {
      const fileName = options.fileName;
      if (
        !fileName ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(fileName) ||
        fileName.includes("..")
      ) {
        throw new Error("invalid file name");
      }
      targetFile = nodeRecord.result?.outputs[fileName] ?? "";
      if (
        !targetFile ||
        !resolve(targetFile).startsWith(`${resolve(nodeDir)}/`) ||
        !targetFile.split("/").includes("out")
      ) {
        throw new Error("output not declared for node");
      }
    } else {
      throw new Error("unsupported preview kind");
    }

    assertNoPathTraversal(nodeDir, targetFile);
    // Reject symlinks in every component, including intermediate directories.
    if ((await realpath(targetFile)) !== resolve(targetFile)) {
      throw new Error("symlink previews are forbidden");
    }
    const file = await open(
      targetFile,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const s = await file.stat();
      if (!s.isFile()) throw new Error("preview is not a regular file");
      const MAX_PREVIEW = 512 * 1024;
      const buffer = Buffer.alloc(MAX_PREVIEW + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      return {
        content: buffer
          .subarray(0, Math.min(bytesRead, MAX_PREVIEW))
          .toString("utf8"),
        truncated: s.size > MAX_PREVIEW,
        size: s.size,
        fileName: options.fileName,
        kind: options.kind,
      };
    } finally {
      await file.close();
    }
  }

  async validateRunSetup(options: {
    targetRepo: string;
    workflowId?: string;
    workflowYaml?: string;
    inputs?: Record<string, string>;
  }): Promise<RunSetupValidation> {
    const warnings: string[] = [];
    const errors: string[] = [];
    const missingInputs: string[] = [];
    let workflowDef: WorkflowDefinition | undefined;

    // 1. Repo validation
    try {
      const repoStatus = await validateRepository(options.targetRepo);
      if (repoStatus.hasUncommittedChanges) {
        warnings.push(
          "target repository has uncommitted changes which will not be included in the run",
        );
      }
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }

    // 2. Workflow validation
    try {
      if (options.workflowYaml) {
        workflowDef = await validateWorkflow(
          options.workflowYaml,
          this.capabilities,
        );
      } else if (options.workflowId) {
        const item = await getWorkflow(this.dataDir, options.workflowId);
        workflowDef = await validateWorkflow(item.yaml, this.capabilities);
      } else {
        errors.push("either workflowId or workflowYaml is required");
      }
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }

    // 3. Inputs check
    if (workflowDef) {
      const provided = options.inputs ?? {};
      for (const inputName of workflowDef.inputs) {
        if (!provided[inputName] || provided[inputName].trim().length === 0) {
          missingInputs.push(inputName);
        }
      }
      if (missingInputs.length > 0) {
        warnings.push(
          `missing required workflow inputs: ${missingInputs.join(", ")}`,
        );
      }
    }

    return {
      valid: errors.length === 0 && missingInputs.length === 0,
      warnings,
      errors,
      missingInputs,
      workflow: workflowDef,
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
