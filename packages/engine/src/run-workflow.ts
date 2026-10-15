import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { StepContext, StepResult, StepRunner } from "@aipilotagent/runner";
import type { TSchema } from "typebox";
import { Check } from "typebox/value";
import {
  checkCondition,
  type ReferenceScope,
  renderTask,
  resolveReference,
} from "./references.ts";
import type {
  AgentWorkflowNode,
  ApprovalRequest,
  NodeState,
  StateEvent,
  WorkflowContext,
  WorkflowDefinition,
  WorkflowNode,
  WorkflowResult,
} from "./types.ts";

interface NodeOutcome {
  state: NodeState;
  result?: StepResult;
}

interface Execution {
  runner: StepRunner;
  context: WorkflowContext;
  workflow: WorkflowDefinition;
  nodes: Record<string, NodeOutcome>;
  events: StateEvent[];
  stopped: boolean;
  running: number;
  writing: boolean;
  waiters: Array<() => void>;
}

function signalError(): Error {
  return new Error("run aborted");
}

async function interruptible<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw signalError();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signalError());
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

async function acquire(
  execution: Execution,
  writable: boolean,
  canStart: () => boolean,
): Promise<() => void> {
  while (true) {
    if (execution.context.signal.aborted) throw signalError();
    if (!canStart()) throw new Error("run stopped after failure");
    if (
      execution.running < execution.workflow.maxParallel &&
      (!writable || !execution.writing)
    ) {
      execution.running++;
      if (writable) execution.writing = true;
      return () => {
        execution.running--;
        if (writable) execution.writing = false;
        for (const waiter of execution.waiters.splice(0)) waiter();
      };
    }
    await interruptible(
      new Promise<void>((resolve) => execution.waiters.push(resolve)),
      execution.context.signal,
    );
  }
}

function emit(
  execution: Execution,
  path: string,
  state: NodeState,
  result?: StepResult,
): void {
  execution.nodes[path] = result === undefined ? { state } : { state, result };
  const event: StateEvent = { path, state };
  execution.events.push(event);
  execution.context.callbacks?.onState?.(event);
}

function failure(message: string): StepResult {
  return {
    status: "failed",
    outputs: {},
    usage: { inputTokens: 0, outputTokens: 0 },
    error: message,
  };
}

async function approval(
  execution: Execution,
  request: ApprovalRequest,
): Promise<{ approved: true } | { approved: false; feedback: string }> {
  if (!execution.context.callbacks?.approve)
    throw new Error(`approval callback required: ${request.path}`);
  const answer = await interruptible(
    execution.context.callbacks.approve(request),
    execution.context.signal,
  );
  if (!answer.approved && !answer.feedback?.trim()) {
    throw new Error("rejection requires feedback");
  }
  return answer;
}

async function validateOutputs(
  node: AgentWorkflowNode,
  result: StepResult,
): Promise<string | undefined> {
  if (
    result.status === "failed" &&
    !/ENOENT|output is not a regular file/i.test(result.error ?? "")
  ) {
    return result.error ?? "agent failed";
  }
  for (const file of node.definition.outputs) {
    const path = result.outputs[file];
    if (!path) return `missing output: ${file}`;
    try {
      if (!(await lstat(path)).isFile())
        return `output is not a regular file: ${file}`;
    } catch {
      return `missing output: ${file}`;
    }
    const schema = node.schemas?.[file];
    if (schema !== undefined) {
      try {
        const value: unknown = JSON.parse(await readFile(path, "utf8"));
        if (!Check(schema as TSchema, value))
          return `invalid JSON schema: ${file}`;
      } catch {
        return `invalid JSON output: ${file}`;
      }
    }
  }
  return undefined;
}

function outputPaths(
  node: AgentWorkflowNode,
  directory: string,
): Record<string, string> {
  return Object.fromEntries(
    node.definition.outputs.map((name) => [name, join(directory, "out", name)]),
  );
}

async function executeLeaf(
  execution: Execution,
  node: WorkflowNode & { kind: "agent" | "command" },
  path: string,
  scope: ReferenceScope,
  attempt: number,
  canStart: () => boolean,
  markFailed: () => void,
  prior?: { text: string; outputs: Record<string, string> },
): Promise<StepResult> {
  const release = await acquire(execution, node.writable ?? false, canStart);
  emit(execution, path, "running");
  try {
    const directory = join(
      execution.context.outputDir,
      path,
      `attempt-${attempt}`,
    );
    await mkdir(directory, { recursive: true });
    const ask = execution.context.callbacks?.ask;
    const stepContext: StepContext = {
      workDir: execution.context.workDir,
      outputDir: directory,
      signal: execution.context.signal,
      callbacks: {
        onEvent: (event) =>
          execution.context.callbacks?.onStepEvent?.(path, event),
        ...(ask === undefined
          ? {}
          : { ask: (question) => ask(path, question) }),
      },
      ...(prior === undefined && scope.feedback === undefined
        ? {}
        : { feedback: prior ?? scope.feedback }),
    };
    if (node.kind === "command") {
      const result = await execution.runner.runCommand(
        node.definition,
        stepContext,
      );
      if (result.status === "failed") markFailed();
      return result;
    }
    const provider = node.definition.model.split("/")[0];
    if (provider === undefined) throw new Error("model provider is missing");
    stepContext.providerSecret = execution.context.providerSecrets?.[provider];
    const rendered: ReferenceScope = {
      ...scope,
      outputs: outputPaths(node, directory),
    };
    const task = await renderTask(node.definition.task, rendered);
    const instructions =
      node.definition.instructions === undefined
        ? undefined
        : await renderTask(node.definition.instructions, rendered);
    const feedback = prior ?? scope.feedback;
    const suffix =
      feedback === undefined
        ? ""
        : `\n\nRejection feedback: ${feedback.text}\nPrevious outputs: ${JSON.stringify(feedback.outputs)}`;
    const definition = {
      ...node.definition,
      task: `${task}${suffix}`,
      ...(instructions === undefined ? {} : { instructions }),
    };
    let result = await execution.runner.runAgent(definition, stepContext);
    let problem = await validateOutputs(node, result);
    for (
      let repair = 0;
      problem !== undefined && repair < 2 && !execution.context.signal.aborted;
      repair++
    ) {
      if (
        result.status === "failed" &&
        !/ENOENT|output is not a regular file|missing output/i.test(
          result.error ?? "",
        )
      )
        break;
      result = await execution.runner.continueAgent(
        `Correct the declared outputs under out/: ${problem}. Keep the existing task and output schema.`,
        stepContext,
      );
      problem = await validateOutputs(node, result);
    }
    const finalResult: StepResult =
      problem === undefined
        ? result
        : { ...result, status: "failed", error: problem };
    if (finalResult.status === "failed") markFailed();
    return finalResult;
  } catch (error) {
    if (!execution.context.signal.aborted) markFailed();
    throw error;
  } finally {
    release();
  }
}

async function manifest(
  directory: string,
  contents: unknown,
): Promise<StepResult> {
  const path = join(directory, "manifest.json");
  await mkdir(directory, { recursive: true });
  await writeFile(path, `${JSON.stringify(contents, null, 2)}\n`);
  return {
    status: "succeeded",
    outputs: { "manifest.json": path },
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

async function executeGroup(
  execution: Execution,
  node: WorkflowNode & { kind: "group" },
  path: string,
  scope: ReferenceScope,
  attempt: number,
): Promise<StepResult> {
  let previous = new Map<string, Record<string, string>>();
  let feedback = scope.feedback;
  let round = 0;
  const directory = join(
    execution.context.outputDir,
    path,
    `attempt-${attempt}`,
  );
  while (!execution.context.signal.aborted) {
    round++;
    const current = await runGraph(
      execution,
      node.nodes,
      `${path}/attempt-${attempt}/round-${round}`,
      { ...scope, previous, feedback },
    );
    if (current === undefined) return failure("group child failed");
    const files = Object.fromEntries(current);
    const done = await checkCondition(node.until, {
      ...scope,
      nodes: new Map([...scope.nodes, ...current]),
      previous,
    });
    if (done) return manifest(directory, { round, outputs: files });
    previous = current;
    if (round < node.maxRounds) continue;
    if (node.onExhausted === "fail") return failure("group exhausted");
    emit(execution, path, "waiting_approval");
    const snapshot = await manifest(directory, { round, outputs: files });
    const answer = await approval(execution, {
      path,
      reason: "group_exhausted",
      outputs: snapshot.outputs,
    });
    if (answer.approved) return snapshot;
    feedback = { text: answer.feedback, outputs: snapshot.outputs };
    emit(execution, path, "running");
    // A rejection grants one more round. The next exhaustion may be reviewed again.
  }
  return failure("group interrupted");
}

async function executeForeach(
  execution: Execution,
  node: WorkflowNode & { kind: "foreach" },
  path: string,
  scope: ReferenceScope,
  attempt: number,
): Promise<StepResult> {
  const source = await resolveReference(node.source, scope);
  const items: unknown =
    typeof source === "string"
      ? JSON.parse(await readFile(source, "utf8"))
      : source;
  if (!Array.isArray(items)) return failure("foreach source is not an array");
  const entries: unknown[] = [];
  for (let index = 0; index < items.length; index++) {
    if (execution.context.signal.aborted) return failure("foreach interrupted");
    const current = await runGraph(
      execution,
      node.nodes,
      `${path}/attempt-${attempt}/item-${index}`,
      {
        ...scope,
        item: items[index],
        previous: new Map(),
        feedback: scope.feedback,
      },
    );
    if (current === undefined) return failure(`foreach item ${index} failed`);
    entries.push({ index, outputs: Object.fromEntries(current) });
  }
  return manifest(
    join(execution.context.outputDir, path, `attempt-${attempt}`),
    entries,
  );
}

async function executeNode(
  execution: Execution,
  node: WorkflowNode,
  path: string,
  scope: ReferenceScope,
  canStart: () => boolean,
  markFailed: () => void,
): Promise<NodeOutcome> {
  try {
    for (const rule of node.when ?? []) {
      if (!(await checkCondition(rule, scope))) {
        emit(execution, path, "skipped");
        return { state: "skipped" };
      }
    }
    let attempt = 0;
    let prior: { text: string; outputs: Record<string, string> } | undefined;
    while (!execution.context.signal.aborted) {
      if (node.kind === "group" || node.kind === "foreach")
        emit(execution, path, "running");
      const result =
        node.kind === "agent" || node.kind === "command"
          ? await executeLeaf(
              execution,
              node,
              path,
              scope,
              attempt,
              canStart,
              markFailed,
              prior,
            )
          : node.kind === "group"
            ? await executeGroup(
                execution,
                node,
                path,
                { ...scope, feedback: prior ?? scope.feedback },
                attempt,
              )
            : await executeForeach(
                execution,
                node,
                path,
                { ...scope, feedback: prior ?? scope.feedback },
                attempt,
              );
      if (result.status === "failed") {
        if (execution.context.signal.aborted) break;
        markFailed();
        emit(execution, path, "failed", result);
        return { state: "failed", result };
      }
      if (!node.approval) {
        emit(execution, path, "succeeded", result);
        return { state: "succeeded", result };
      }
      emit(execution, path, "waiting_approval", result);
      const answer = await approval(execution, {
        path,
        reason: "node",
        outputs: result.outputs,
      });
      if (answer.approved) {
        emit(execution, path, "succeeded", result);
        return { state: "succeeded", result };
      }
      prior = { text: answer.feedback, outputs: result.outputs };
      attempt++;
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "run stopped after failure"
    ) {
      return { state: "pending" };
    }
    if (!execution.context.signal.aborted) {
      markFailed();
      const result = failure(
        error instanceof Error ? error.message : String(error),
      );
      emit(execution, path, "failed", result);
      return { state: "failed", result };
    }
  }
  emit(execution, path, "aborted");
  return { state: "aborted" };
}

async function runGraph(
  execution: Execution,
  nodes: WorkflowNode[],
  prefix: string,
  scope: ReferenceScope,
): Promise<Map<string, Record<string, string>> | undefined> {
  const isTopLevel = prefix === "";
  let graphFailed = false;
  const canStart = () => (isTopLevel ? !execution.stopped : !graphFailed);
  const markFailed = () => {
    graphFailed = true;
    execution.stopped = true;
  };
  const pending = new Map(nodes.map((node) => [node.id, node]));
  const settled = new Map<string, NodeOutcome>();
  const active = new Map<string, Promise<void>>();
  const files = new Map<string, Record<string, string>>();
  for (const node of nodes)
    emit(execution, `${prefix}/${node.id}`.replace(/^\//, ""), "pending");
  while (pending.size > 0 || active.size > 0) {
    let progressed = false;
    if (
      !execution.context.signal.aborted &&
      (isTopLevel ? !execution.stopped : !graphFailed)
    ) {
      for (const [id, node] of pending) {
        if (!node.dependsOn.every((dependency) => settled.has(dependency)))
          continue;
        if (
          node.dependsOn.length > 0 &&
          node.dependsOn.every(
            (dependency) => settled.get(dependency)?.state === "skipped",
          )
        ) {
          emit(execution, `${prefix}/${id}`.replace(/^\//, ""), "skipped");
          settled.set(id, { state: "skipped" });
          pending.delete(id);
          progressed = true;
          continue;
        }
        if (
          node.dependsOn.some(
            (dependency) =>
              settled.get(dependency)?.state !== "succeeded" &&
              settled.get(dependency)?.state !== "skipped",
          )
        )
          continue;
        pending.delete(id);
        progressed = true;
        const path = `${prefix}/${id}`.replace(/^\//, "");
        const visible = new Map([...scope.nodes, ...files]);
        const promise = executeNode(
          execution,
          node,
          path,
          {
            ...scope,
            nodes: visible,
          },
          canStart,
          markFailed,
        )
          .then((outcome) => {
            settled.set(id, outcome);
            if (outcome.result?.status === "succeeded")
              files.set(id, outcome.result.outputs);
            if (outcome.state === "failed") markFailed();
          })
          .finally(() => {
            active.delete(id);
            for (const waiter of execution.waiters.splice(0)) waiter();
          });
        active.set(id, promise);
      }
    }
    if (active.size === 0) {
      if (progressed) continue;
      if (!execution.context.signal.aborted && pending.size > 0) {
        if (isTopLevel) execution.stopped = true;
        else graphFailed = true;
      }
      break;
    }
    await Promise.race(active.values());
  }
  await Promise.all(active.values());
  if (
    execution.context.signal.aborted ||
    (isTopLevel ? execution.stopped : graphFailed) ||
    pending.size > 0
  )
    return undefined;
  return files;
}

export async function runWorkflow(
  workflow: WorkflowDefinition,
  runner: StepRunner,
  context: WorkflowContext,
): Promise<WorkflowResult> {
  for (const input of workflow.inputs) {
    if (typeof context.inputs[input] !== "string")
      throw new Error(`missing workflow input: ${input}`);
  }
  const execution: Execution = {
    runner,
    context,
    workflow,
    nodes: {},
    events: [],
    stopped: false,
    running: 0,
    writing: false,
    waiters: [],
  };
  await mkdir(context.outputDir, { recursive: true });
  const scope: ReferenceScope = {
    inputs: context.inputs,
    nodes: new Map(),
    previous: new Map(),
  };
  await runGraph(execution, workflow.nodes, "", scope);
  return {
    status: context.signal.aborted
      ? "aborted"
      : execution.stopped
        ? "failed"
        : "succeeded",
    nodes: execution.nodes,
    events: execution.events,
  };
}
