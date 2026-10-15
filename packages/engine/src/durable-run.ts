import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { StepResult, StepRunner, TokenUsage } from "@aipilotagent/runner";
import { runWorkflow } from "./run-workflow.ts";
import type {
  NodeState,
  StateEvent,
  WorkflowCallbacks,
  WorkflowContext,
  WorkflowDefinition,
  WorkflowStatus,
} from "./types.ts";
import { WorkflowFatalError } from "./types.ts";
import {
  createWorkspace,
  openWorkspace,
  validateRepository,
  type Workspace,
} from "./workspace.ts";

export interface DurableRunNodeRecord {
  state: NodeState;
  result?: StepResult;
  checkpointCommit?: string;
  diffPath?: string;
}

export interface DurableRunState {
  runId: string;
  repoDir: string;
  worktreeDir: string;
  branch: string;
  headCommit: string;
  lastCheckpointCommit?: string;
  status: WorkflowStatus;
  budgetUsd?: number;
  totalUsage: TokenUsage;
  nodes: Record<string, DurableRunNodeRecord>;
  events: StateEvent[];
  warnings: string[];
  createdAt: string;
  updatedAt: string;
}

export interface StartDurableWorkflowOptions {
  workflow: WorkflowDefinition;
  runner: StepRunner;
  repoDir: string;
  runDir: string;
  inputs: Record<string, string>;
  runId?: string;
  worktreeDir?: string;
  providerSecrets?: Record<string, string>;
  callbacks?: WorkflowCallbacks;
  signal?: AbortSignal;
  /** Test hook to simulate crash right after git checkpoint before state.json (AC-8) */
  simulateCrashAfterCheckpoint?: boolean;
}

export interface ResumeDurableWorkflowOptions {
  runDir: string;
  runner: StepRunner;
  newBudgetUsd?: number;
  providerSecrets?: Record<string, string>;
  callbacks?: WorkflowCallbacks;
  signal?: AbortSignal;
}

export interface DurableRunResult {
  state: DurableRunState;
  workspace: Workspace;
  warnings: string[];
}

export async function saveStateAtomic(
  runDir: string,
  state: DurableRunState,
): Promise<void> {
  const tempPath = join(
    runDir,
    `state.json.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`,
  );
  await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`);
  await rename(tempPath, join(runDir, "state.json"));
}

async function appendRunEvent(runDir: string, event: unknown): Promise<void> {
  await appendFile(join(runDir, "events.jsonl"), `${JSON.stringify(event)}\n`);
}

export async function loadDurableRunState(
  runDir: string,
): Promise<DurableRunState> {
  const text = await readFile(join(runDir, "state.json"), "utf8");
  return JSON.parse(text) as DurableRunState;
}

function checkDirContainment(runDir: string, repoDir: string): void {
  const normRun = resolve(runDir);
  const normRepo = resolve(repoDir);
  if (
    normRun === normRepo ||
    normRun.startsWith(normRepo + sep) ||
    normRepo.startsWith(normRun + sep)
  ) {
    throw new Error(
      `runDir (${normRun}) must be outside target repository (${normRepo})`,
    );
  }
}

export async function startDurableWorkflow(
  options: StartDurableWorkflowOptions,
): Promise<DurableRunResult> {
  const { workflow, runner, repoDir, runDir, inputs } = options;
  checkDirContainment(runDir, repoDir);
  const repoStatus = await validateRepository(repoDir);
  const warnings: string[] = [];
  if (repoStatus.hasUncommittedChanges) {
    warnings.push(
      "target repository has uncommitted changes which will not be included in the run",
    );
  }

  const runId =
    options.runId ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const worktreeDir = options.worktreeDir ?? join(runDir, "worktree");

  await mkdir(runDir, { recursive: true });
  await writeFile(
    join(runDir, "definition.json"),
    `${JSON.stringify(workflow, null, 2)}\n`,
  );
  await writeFile(
    join(runDir, "inputs.json"),
    `${JSON.stringify(inputs, null, 2)}\n`,
  );
  await writeFile(join(runDir, "events.jsonl"), "");

  const workspace = await createWorkspace({
    repoDir,
    worktreeDir,
    runId,
  });

  const state: DurableRunState = {
    runId,
    repoDir: resolve(repoDir),
    worktreeDir,
    branch: workspace.branch,
    headCommit: workspace.headCommit,
    lastCheckpointCommit: workspace.headCommit,
    status: "pending",
    ...(workflow.budgetUsd === undefined
      ? {}
      : { budgetUsd: workflow.budgetUsd }),
    totalUsage: { inputTokens: 0, outputTokens: 0 },
    nodes: {},
    events: [],
    warnings,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await saveStateAtomic(runDir, state);

  return runDurableLoop(workflow, runner, runDir, workspace, state, options);
}

export async function resumeDurableWorkflow(
  options: ResumeDurableWorkflowOptions,
): Promise<DurableRunResult> {
  const { runDir, runner } = options;
  const defText = await readFile(join(runDir, "definition.json"), "utf8");
  const inText = await readFile(join(runDir, "inputs.json"), "utf8");
  let workflow = JSON.parse(defText) as WorkflowDefinition;
  const inputs = JSON.parse(inText) as Record<string, string>;
  const state = await loadDurableRunState(runDir);

  if (options.newBudgetUsd !== undefined) {
    workflow = { ...workflow, budgetUsd: options.newBudgetUsd };
    state.budgetUsd = options.newBudgetUsd;
    await writeFile(
      join(runDir, "definition.json"),
      `${JSON.stringify(workflow, null, 2)}\n`,
    );
  }

  const workspace = await openWorkspace({
    repoDir: state.repoDir,
    worktreeDir: state.worktreeDir,
    runId: state.runId,
    headCommit: state.headCommit,
  });

  // AC-8: Crash recovery: reconstruct succeeded state from git checkpoints
  const checkpoints = await workspace.listCheckpoints();
  for (const chk of checkpoints) {
    if (chk.nodePath) {
      const existing = state.nodes[chk.nodePath];
      if (existing?.state !== "succeeded") {
        const recoveredOutputs: Record<string, string> = {
          ...existing?.result?.outputs,
        };
        try {
          const outDir = join(
            runDir,
            "nodes",
            chk.nodePath,
            "attempt-0",
            "out",
          );
          const entries = await readdir(outDir);
          for (const file of entries) {
            recoveredOutputs[file] = join(outDir, file);
          }
        } catch {
          // Output directory might not exist if node had no outputs
        }
        state.nodes[chk.nodePath] = {
          state: "succeeded",
          checkpointCommit: chk.commit,
          result: {
            status: "succeeded",
            outputs: recoveredOutputs,
            usage: existing?.result?.usage ?? {
              inputTokens: 0,
              outputTokens: 0,
            },
          },
        };
      }
    }
  }
  if (checkpoints.length > 0 && checkpoints[0]?.commit) {
    state.lastCheckpointCommit = checkpoints[0].commit;
  }

  // Task 3.2: Clean uncommitted modifications from interrupted attempt
  await workspace.restoreCheckpoint(
    state.lastCheckpointCommit || state.headCommit,
  );

  // AC-9: Reset incomplete/failed nodes so they start fresh
  for (const [id, record] of Object.entries(state.nodes)) {
    if (record.state !== "succeeded") {
      delete state.nodes[id];
    }
  }

  state.status = "pending";
  state.updatedAt = new Date().toISOString();
  await saveStateAtomic(runDir, state);

  return runDurableLoop(
    workflow,
    runner,
    runDir,
    workspace,
    state,
    {
      workflow,
      runner,
      repoDir: state.repoDir,
      runDir,
      inputs,
      providerSecrets: options.providerSecrets,
      callbacks: options.callbacks,
      signal: options.signal,
    },
    true,
  );
}

async function runDurableLoop(
  workflow: WorkflowDefinition,
  runner: StepRunner,
  runDir: string,
  workspace: Workspace,
  state: DurableRunState,
  options: StartDurableWorkflowOptions,
  isResume = false,
): Promise<DurableRunResult> {
  const signal = options.signal ?? new AbortController().signal;

  const resumedNodes: Record<
    string,
    { state: NodeState; result?: StepResult }
  > = {};
  if (isResume) {
    for (const [path, record] of Object.entries(state.nodes)) {
      if (record.state === "succeeded" && record.result) {
        resumedNodes[path] = {
          state: "succeeded",
          result: record.result,
        };
      }
    }
  }

  const context: WorkflowContext = {
    workDir: workspace.worktreeDir,
    outputDir: join(runDir, "nodes"),
    inputs: JSON.parse(await readFile(join(runDir, "inputs.json"), "utf8")),
    signal,
    providerSecrets: options.providerSecrets,
    resume: { nodes: resumedNodes },
    initialCost: isResume ? (state.totalUsage.costUsd ?? 0) : 0,
    callbacks: {
      onState: (event) => {
        state.events.push(event);
        const nodeRecord = state.nodes[event.path];
        if (nodeRecord) {
          nodeRecord.state = event.state;
        } else {
          state.nodes[event.path] = { state: event.state };
        }
        state.updatedAt = new Date().toISOString();
        void appendRunEvent(runDir, { type: "state", event });
        void saveStateAtomic(runDir, state);
        options.callbacks?.onState?.(event);
      },
      onStepEvent: (path, event) => {
        void appendRunEvent(runDir, { type: "step", path, event });
        options.callbacks?.onStepEvent?.(path, event);
      },
      ask: options.callbacks?.ask,
      approve: options.callbacks?.approve,
    },
    hooks: {
      onNodeResult: async (path, node, result) => {
        if (node.writable) {
          if (result.status === "succeeded") {
            const checkpoint = await workspace.commitCheckpoint(path);
            if (checkpoint.modified) {
              state.lastCheckpointCommit = checkpoint.commit;
              const diffPath = join(runDir, "nodes", path, "diff.patch");
              await mkdir(dirname(diffPath), { recursive: true });
              await writeFile(diffPath, checkpoint.diff);
              const nodeRecord = state.nodes[path] ?? { state: "succeeded" };
              nodeRecord.checkpointCommit = checkpoint.commit;
              nodeRecord.diffPath = diffPath;
              state.nodes[path] = nodeRecord;
              result.outputs = {
                ...result.outputs,
                "diff.patch": diffPath,
              };
            }
            if (options.simulateCrashAfterCheckpoint) {
              throw new WorkflowFatalError("simulated crash after checkpoint");
            }
          }
        } else {
          // AC-3: Check read-only node modifications
          const check = await workspace.checkReadOnly();
          if (check.modified) {
            result = {
              ...result,
              status: "failed",
              error: `read-only node modified workspace files: ${check.files.join(", ")}`,
              outputs: {},
            };
          }
        }

        if (result.usage) {
          state.totalUsage.inputTokens += result.usage.inputTokens;
          state.totalUsage.outputTokens += result.usage.outputTokens;
          if (result.usage.costUsd !== undefined) {
            state.totalUsage.costUsd =
              (state.totalUsage.costUsd ?? 0) + result.usage.costUsd;
          }
        }

        state.nodes[path] = {
          state: result.status === "succeeded" ? "succeeded" : "failed",
          result,
          checkpointCommit: state.nodes[path]?.checkpointCommit,
          diffPath: state.nodes[path]?.diffPath,
        };
        state.updatedAt = new Date().toISOString();
        await saveStateAtomic(runDir, state);
        return result;
      },
    },
  };

  const workflowResult = await runWorkflow(workflow, runner, context);
  state.status = workflowResult.status;
  state.updatedAt = new Date().toISOString();
  await saveStateAtomic(runDir, state);

  return {
    state,
    workspace,
    warnings: state.warnings,
  };
}
