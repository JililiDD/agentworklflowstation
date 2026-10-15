// biome-ignore-all lint/suspicious/noTemplateCurlyInString: These are literal workflow references, not JavaScript interpolation.
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { promisify } from "node:util";
import type {
  AgentNodeDefinition,
  CommandNodeDefinition,
  StepContext,
  StepResult,
  StepRunner,
} from "@aipilotagent/runner";
import {
  loadDurableRunState,
  resumeDurableWorkflow,
  startDurableWorkflow,
} from "./durable-run.ts";
import { loadWorkflow } from "./load-workflow.ts";
import type { WorkflowDefinition } from "./types.ts";

const execFile = promisify(execFileCallback);

let tempDir: string;
let repoDir: string;

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFile("git", args, { cwd, env: GIT_ENV });
  return stdout.trim();
}

const capabilities = { models: { "fake/small": ["off" as const] } };
const jsonSchema = {
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
};

const agent = (id: string, dependsOn: string[] = [], overrides = {}) => ({
  id,
  dependsOn,
  kind: "agent",
  definition: {
    kind: "agent",
    model: "fake/small",
    thinkingLevel: "off",
    task: id,
    interactive: false,
    outputs: ["result.json"],
  },
  schemas: { "result.json": jsonSchema },
  ...overrides,
});

const workflow = (
  nodes: unknown[],
  maxParallel = 2,
  budgetUsd?: number,
): Promise<WorkflowDefinition> =>
  loadWorkflow(
    JSON.stringify({
      nodes,
      maxParallel,
      inputs: ["topic"],
      ...(budgetUsd === undefined ? {} : { budgetUsd }),
    }),
    capabilities,
  );

const succeed = (outputs: Record<string, string> = {}): StepResult => ({
  status: "succeeded",
  outputs,
  usage: { inputTokens: 10, outputTokens: 10, costUsd: 0.01 },
});

class FakeRunner implements StepRunner {
  runs: string[] = [];
  onAgent?: (
    definition: AgentNodeDefinition,
    context: StepContext,
  ) => Promise<StepResult>;
  onCommand?: (
    definition: CommandNodeDefinition,
    context: StepContext,
  ) => Promise<StepResult>;

  async runAgent(
    definition: AgentNodeDefinition,
    context: StepContext,
  ): Promise<StepResult> {
    this.runs.push(definition.task);
    if (this.onAgent) return this.onAgent(definition, context);
    return this.write(context, { ok: true });
  }

  async runCommand(
    definition: CommandNodeDefinition,
    context: StepContext,
  ): Promise<StepResult> {
    this.runs.push(definition.command);
    if (this.onCommand) return this.onCommand(definition, context);
    return succeed({});
  }

  async continueAgent(
    _instruction: string,
    context: StepContext,
  ): Promise<StepResult> {
    return this.write(context, { ok: true });
  }

  async write(
    context: StepContext,
    value: unknown,
    costUsd = 0.01,
  ): Promise<StepResult> {
    const out = join(context.outputDir, "out");
    await mkdir(out, { recursive: true });
    const path = join(out, "result.json");
    await writeFile(path, JSON.stringify(value));
    return {
      status: "succeeded",
      outputs: { "result.json": path },
      usage: { inputTokens: 10, outputTokens: 10, costUsd },
    };
  }

  async dispose(): Promise<void> {}
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "engine-durable-test-"));
  repoDir = join(tempDir, "repo");
  await mkdir(repoDir, { recursive: true });
  await git(["init"], repoDir);
  await git(["config", "user.name", "test"], repoDir);
  await git(["config", "user.email", "test@example.com"], repoDir);
  await writeFile(join(repoDir, "README.md"), "# Target Repo\n");
  await git(["add", "README.md"], repoDir);
  await git(["commit", "-m", "initial commit"], repoDir);
});

afterEach(async () => {
  try {
    await rm(tempDir, { recursive: true, force: true });
  } catch {}
});

test("rejects runDir inside repoDir and warns on uncommitted changes", async () => {
  const runner = new FakeRunner();
  const wf = await workflow([agent("a")]);

  // Inside repoDir rejection
  await assert.rejects(
    () =>
      startDurableWorkflow({
        workflow: wf,
        runner,
        repoDir,
        runDir: join(repoDir, "nested-run"),
        inputs: { topic: "test" },
      }),
    /runDir .* must be outside target repository/,
  );

  // Uncommitted changes warning
  await writeFile(join(repoDir, "dirty.txt"), "uncommitted");
  const runDir = join(tempDir, "run-warn");
  const { warnings } = await startDurableWorkflow({
    workflow: wf,
    runner,
    repoDir,
    runDir,
    inputs: { topic: "test" },
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /uncommitted changes/);
});

test("read-only node modifying files fails and has changes reverted", async () => {
  const runner = new FakeRunner();
  runner.onAgent = async (_definition, context) => {
    // Illegally write to workDir in read-only node
    await writeFile(
      join(context.workDir, "illegal.txt"),
      "should not be allowed",
    );
    return runner.write(context, { ok: true });
  };

  const wf = await workflow([agent("readonlyNode")]);
  const runDir = join(tempDir, "run-ro");
  const { state } = await startDurableWorkflow({
    workflow: wf,
    runner,
    repoDir,
    runDir,
    inputs: { topic: "test" },
  });

  assert.equal(state.status, "failed");
  assert.equal(state.nodes.readonlyNode?.state, "failed");
  assert.match(
    state.nodes.readonlyNode?.result?.error ?? "",
    /read-only node modified workspace files: illegal\.txt/,
  );

  // Verify workspace was reverted clean
  const status = await git(["status", "--porcelain"], state.worktreeDir);
  assert.equal(status, "");
});

test("writable node commits checkpoint and saves diff.patch", async () => {
  const runner = new FakeRunner();
  runner.onAgent = async (_definition, context) => {
    await writeFile(join(context.workDir, "code.ts"), "const x = 42;\n");
    return runner.write(context, { ok: true });
  };

  const node = agent("writerNode", [], { writable: true });
  const wf = await workflow([node]);
  const runDir = join(tempDir, "run-write");
  const { state, workspace } = await startDurableWorkflow({
    workflow: wf,
    runner,
    repoDir,
    runDir,
    inputs: { topic: "test" },
  });

  assert.equal(state.status, "succeeded");
  assert.equal(state.nodes.writerNode?.state, "succeeded");
  assert.ok(state.nodes.writerNode?.checkpointCommit);
  assert.ok(state.nodes.writerNode?.diffPath);

  const diffContent = await readFile(state.nodes.writerNode.diffPath, "utf8");
  assert.ok(diffContent.includes("+const x = 42;"));

  const checkpoints = await workspace.listCheckpoints();
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0]?.nodePath, "writerNode");
});

test("crash between git checkpoint and state save is recovered on resume", async () => {
  const runner = new FakeRunner();
  runner.onAgent = async (_definition, context) => {
    await writeFile(join(context.workDir, "patch.txt"), "fixed");
    return runner.write(context, { ok: true });
  };

  const node1 = agent("node1", [], { writable: true });
  const node2 = agent("node2", ["node1"]);
  const wf = await workflow([node1, node2]);
  const runDir = join(tempDir, "run-crash");

  // First run simulates crash right after node1 commits git checkpoint
  await assert.rejects(
    () =>
      startDurableWorkflow({
        workflow: wf,
        runner,
        repoDir,
        runDir,
        inputs: { topic: "test" },
        simulateCrashAfterCheckpoint: true,
      }),
    /simulated crash after checkpoint/,
  );

  // In state.json, node1 was not saved as succeeded
  const crashedState = await loadDurableRunState(runDir);
  assert.notEqual(crashedState.nodes.node1?.state, "succeeded");

  // Resume the run: crash recovery must identify git checkpoint and restore node1
  runner.runs = [];
  const { state } = await resumeDurableWorkflow({
    runDir,
    runner,
  });

  assert.equal(state.status, "succeeded");
  assert.equal(state.nodes.node1?.state, "succeeded");
  assert.equal(state.nodes.node2?.state, "succeeded");
  // node1 was recovered and NOT re-run; only node2 ran
  assert.deepEqual(runner.runs, ["node2"]);
});

test("budget exceeded aborts active nodes and resume allows increasing budget", async () => {
  const runner = new FakeRunner();
  // Budget is $0.05. node1 costs $0.03, node2 costs $0.04 -> total $0.07 (exceeds $0.05)
  runner.onAgent = async (definition, context) => {
    if (definition.task === "node1") {
      return runner.write(context, { ok: true }, 0.03);
    }
    if (definition.task === "node2") {
      return runner.write(context, { ok: true }, 0.04);
    }
    return runner.write(context, { ok: true }, 0.01);
  };

  const node1 = agent("node1");
  const node2 = agent("node2", ["node1"]);
  const node3 = agent("node3", ["node2"]);
  const wf = await workflow([node1, node2, node3], 2, 0.05);

  const runDir = join(tempDir, "run-budget");
  const { state: budgetState } = await startDurableWorkflow({
    workflow: wf,
    runner,
    repoDir,
    runDir,
    inputs: { topic: "test" },
  });

  assert.equal(budgetState.status, "budget_exceeded");
  assert.equal(budgetState.nodes.node1?.state, "succeeded");
  assert.equal(budgetState.nodes.node2?.state, "aborted");
  assert.equal(budgetState.nodes.node3?.state, "pending");

  // Resume with higher budget: $0.15
  runner.runs = [];
  const { state: resumedState } = await resumeDurableWorkflow({
    runDir,
    runner,
    newBudgetUsd: 0.15,
  });

  assert.equal(resumedState.status, "succeeded");
  assert.equal(resumedState.budgetUsd, 0.15);
  assert.equal(resumedState.nodes.node1?.state, "succeeded");
  assert.equal(resumedState.nodes.node2?.state, "succeeded");
  assert.equal(resumedState.nodes.node3?.state, "succeeded");
  // node1 did not rerun
  assert.deepEqual(runner.runs, ["node2", "node3"]);
});

test("cumulative budget limit is preserved across resumes", async () => {
  const runner = new FakeRunner();
  runner.onAgent = async (definition, context) => {
    if (definition.task === "step1") {
      return runner.write(context, { ok: true }, 0.06);
    }
    if (definition.task === "step2") {
      return runner.write(context, { ok: true }, 0.05);
    }
    return runner.write(context, { ok: true }, 0.01);
  };

  const step1 = agent("step1");
  const step2 = agent("step2", ["step1"]);
  const wf = await workflow([step1, step2], 1, 0.1);

  const runDir = join(tempDir, "run-cumulative-budget");
  // Run step1 only, then simulate process exit before step2
  let calls = 0;
  runner.onAgent = async (_definition, context) => {
    calls++;
    if (calls === 1) {
      return runner.write(context, { ok: true }, 0.06);
    }
    throw new Error("process exited before step2");
  };

  const { state: state1 } = await startDurableWorkflow({
    workflow: wf,
    runner,
    repoDir,
    runDir,
    inputs: { topic: "test" },
  });
  assert.equal(state1.status, "failed");
  assert.equal(state1.nodes.step1?.state, "succeeded");
  assert.equal(state1.totalUsage.costUsd, 0.06);

  // Resume without increasing budget (budget is $0.10)
  // step1 already spent $0.06. step2 costs $0.05 -> total $0.11 > $0.10!
  runner.onAgent = async (_definition, context) => {
    return runner.write(context, { ok: true }, 0.05);
  };
  const { state: state2 } = await resumeDurableWorkflow({
    runDir,
    runner,
  });
  // Must be budget_exceeded because cumulative cost ($0.11) > budget ($0.10)
  assert.equal(state2.status, "budget_exceeded");
  assert.equal(state2.nodes.step1?.state, "succeeded");
  assert.equal(state2.nodes.step2?.state, "aborted");

  // Resume with higher budget: $0.20 (step1 was $0.06, step2 failed attempt was $0.05, step2 retry is $0.05 -> total $0.16 <= $0.20)
  const { state: state3 } = await resumeDurableWorkflow({
    runDir,
    runner,
    newBudgetUsd: 0.2,
  });
  assert.equal(state3.status, "succeeded");
  assert.equal(state3.nodes.step1?.state, "succeeded");
  assert.equal(state3.nodes.step2?.state, "succeeded");
});

test("unknown model cost under configured budget fails with unverifiable budget", async () => {
  const runner = new FakeRunner();
  runner.onAgent = async (_definition, context) => {
    const out = join(context.outputDir, "out");
    await mkdir(out, { recursive: true });
    const path = join(out, "result.json");
    await writeFile(path, JSON.stringify({ ok: true }));
    return {
      status: "succeeded",
      outputs: { "result.json": path },
      usage: { inputTokens: 50, outputTokens: 50 }, // costUsd is undefined!
    };
  };

  const wf = await workflow([agent("a")], 1, 10.0);
  const runDir = join(tempDir, "run-unverifiable");
  const { state } = await startDurableWorkflow({
    workflow: wf,
    runner,
    repoDir,
    runDir,
    inputs: { topic: "test" },
  });

  assert.equal(state.status, "failed");
  assert.match(
    state.nodes.a?.result?.error ?? "",
    /cannot verify budget: model catalog has no pricing rates/,
  );
});

test("resume skips already succeeded nodes and foreach items", async () => {
  const runner = new FakeRunner();
  let calls = 0;
  runner.onAgent = async (definition, context) => {
    calls++;
    if (definition.task === "failFirstTime" && calls === 3) {
      return {
        status: "failed",
        outputs: {},
        usage: { inputTokens: 0, outputTokens: 0 },
        error: "deliberate crash",
      };
    }
    return runner.write(context, { ok: true });
  };

  const sourceNode = agent("source", [], {
    definition: {
      ...agent("source").definition,
      outputs: ["items.json"],
    },
    schemas: {
      "items.json": {
        type: "array",
        items: {
          type: "object",
          properties: { id: { type: "string" } },
        },
      },
    },
  });

  const eachChild = agent("child", [], {
    definition: {
      ...agent("child").definition,
      task: "${item.id}",
    },
  });

  const foreachNode = {
    id: "each",
    kind: "foreach",
    dependsOn: ["source"],
    source: "${nodes.source.items.json}",
    nodes: [eachChild],
  };

  runner.write = async (context, value) => {
    const out = join(context.outputDir, "out");
    await mkdir(out, { recursive: true });
    if (context.outputDir.includes("source")) {
      const path = join(out, "items.json");
      await writeFile(
        path,
        JSON.stringify([
          { id: "item0" },
          { id: "failFirstTime" },
          { id: "item2" },
        ]),
      );
      return succeed({ "items.json": path });
    }
    const path = join(out, "result.json");
    await writeFile(path, JSON.stringify(value));
    return succeed({ "result.json": path });
  };

  const wf = await workflow([sourceNode, foreachNode]);
  const runDir = join(tempDir, "run-resume-each");

  // First run fails on item 1 (failFirstTime)
  const { state: state1 } = await startDurableWorkflow({
    workflow: wf,
    runner,
    repoDir,
    runDir,
    inputs: { topic: "test" },
  });

  assert.equal(state1.status, "failed");
  assert.equal(state1.nodes.source?.state, "succeeded");
  assert.equal(state1.nodes["each/attempt-0/item-0/child"]?.state, "succeeded");
  assert.equal(state1.nodes["each/attempt-0/item-1/child"]?.state, "failed");

  // Resume: source and item 0 should not rerun
  runner.runs = [];
  const { state: state2 } = await resumeDurableWorkflow({
    runDir,
    runner,
  });

  assert.equal(state2.status, "succeeded");
  assert.equal(state2.nodes.each?.state, "succeeded");
  // Only item 1 (which failed before) and item 2 (which hadn't run) ran
  assert.ok(!runner.runs.includes("source"));
  assert.ok(!runner.runs.includes("item0"));
  assert.ok(runner.runs.includes("failFirstTime"));
  assert.ok(runner.runs.includes("item2"));
});

test("preserves worktree and branch on disk after run ends", async () => {
  const runner = new FakeRunner();
  runner.onAgent = async (_definition, context) => {
    await writeFile(join(context.workDir, "result.txt"), "done\n");
    return runner.write(context, { ok: true });
  };

  const wf = await workflow([agent("a", [], { writable: true })]);
  const runDir = join(tempDir, "run-preserve");
  const { state } = await startDurableWorkflow({
    workflow: wf,
    runner,
    repoDir,
    runDir,
    inputs: { topic: "test" },
  });

  assert.equal(state.status, "succeeded");

  // Verify worktree directory and branch still exist on disk
  const content = await readFile(join(state.worktreeDir, "result.txt"), "utf8");
  assert.equal(content, "done\n");

  const branches = await git(["branch"], repoDir);
  assert.ok(branches.includes(state.branch));
});
