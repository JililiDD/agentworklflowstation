// biome-ignore-all lint/suspicious/noTemplateCurlyInString: These are literal workflow references, not JavaScript interpolation.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type {
  AgentNodeDefinition,
  CommandNodeDefinition,
  StepContext,
  StepResult,
  StepRunner,
} from "@aipilotagent/runner";
import { loadWorkflow } from "./load-workflow.ts";
import { runWorkflow } from "./run-workflow.ts";

const capabilities = { models: { "fake/small": ["off" as const] } };
const jsonSchema = {
  type: "object",
  properties: { ready: { type: "boolean" } },
  required: ["ready"],
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
const workflow = (nodes: unknown[], maxParallel = 2) =>
  loadWorkflow(
    JSON.stringify({ nodes, maxParallel, inputs: ["topic"] }),
    capabilities,
  );
const succeed = (outputs: Record<string, string>): StepResult => ({
  status: "succeeded",
  outputs,
  usage: { inputTokens: 0, outputTokens: 0 },
});

class FakeRunner implements StepRunner {
  runs: string[] = [];
  corrections: string[] = [];
  onAgent?: (
    definition: AgentNodeDefinition,
    context: StepContext,
  ) => Promise<StepResult>;
  onCommand?: (
    definition: CommandNodeDefinition,
    context: StepContext,
  ) => Promise<StepResult>;
  onContinue?: (
    instruction: string,
    context: StepContext,
  ) => Promise<StepResult>;

  async runAgent(
    definition: AgentNodeDefinition,
    context: StepContext,
  ): Promise<StepResult> {
    this.runs.push(definition.task);
    if (this.onAgent) return this.onAgent(definition, context);
    return this.write(context, { ready: true });
  }
  async runCommand(
    definition: CommandNodeDefinition,
    context: StepContext,
  ): Promise<StepResult> {
    this.runs.push(definition.command);
    return this.onCommand ? this.onCommand(definition, context) : succeed({});
  }
  async continueAgent(
    instruction: string,
    context: StepContext,
  ): Promise<StepResult> {
    this.corrections.push(instruction);
    return this.onContinue
      ? this.onContinue(instruction, context)
      : this.write(context, { ready: true });
  }
  async write(context: StepContext, value: unknown): Promise<StepResult> {
    const out = join(context.outputDir, "out");
    await mkdir(out, { recursive: true });
    const path = join(out, "result.json");
    await writeFile(path, JSON.stringify(value));
    return succeed({ "result.json": path });
  }
  async dispose(): Promise<void> {}
}

async function run(
  nodes: unknown[],
  runner: FakeRunner,
  options: {
    maxParallel?: number;
    signal?: AbortSignal;
    approve?: NonNullable<
      Parameters<typeof runWorkflow>[2]["callbacks"]
    >["approve"];
    onState?: NonNullable<
      Parameters<typeof runWorkflow>[2]["callbacks"]
    >["onState"];
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "engine-run-"));
  const definition = await workflow(nodes, options.maxParallel);
  const result = await runWorkflow(definition, runner, {
    outputDir: root,
    workDir: root,
    inputs: { topic: "demo" },
    signal: options.signal ?? new AbortController().signal,
    callbacks: { approve: options.approve, onState: options.onState },
  });
  return { result, root };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("resolves inputs, output path, ancestor JSON fields and serializes dependent nodes", async () => {
  const runner = new FakeRunner();
  const first = agent("first", [], {
    definition: {
      ...agent("first").definition,
      task: "${inputs.topic} ${outputs.result.json}",
    },
  });
  const second = agent("second", ["first"], {
    definition: {
      ...agent("second").definition,
      task: "${nodes.first.result.json#/ready}",
    },
    when: [{ ref: "${nodes.first.result.json#/ready}", equals: true }],
  });
  const { result } = await run([first, second], runner);
  assert.equal(result.status, "succeeded");
  assert.match(runner.runs[0] ?? "", /^demo .*attempt-0\/out\/result.json$/);
  assert.deepEqual(runner.runs.slice(1), ["true"]);
  assert.deepEqual(
    result.events
      .filter((event) => event.path === "second")
      .map((event) => event.state),
    ["pending", "running", "succeeded"],
  );
});

test("conditions and all-skipped propagation do not execute skipped nodes", async () => {
  const runner = new FakeRunner();
  const skipped = agent("skipped", ["first"], {
    when: [{ ref: "${nodes.first.result.json#/ready}", equals: false }],
  });
  const dependent = agent("dependent", ["skipped"]);
  const { result } = await run([dependent, skipped, agent("first")], runner);
  assert.equal(result.status, "succeeded");
  assert.equal(result.nodes.skipped?.state, "skipped");
  assert.equal(result.nodes.dependent?.state, "skipped");
  assert.deepEqual(runner.runs, ["first"]);
});

test("enforces maxParallel and one writable node while permitting a read-only peer", async () => {
  const runner = new FakeRunner();
  const starts: string[] = [];
  const held = deferred<void>();
  runner.onAgent = async (definition, context) => {
    starts.push(definition.task);
    if (definition.task === "writerA") await held.promise;
    return runner.write(context, { ready: true });
  };
  const started = deferred<void>();
  const pending = run(
    [
      agent("writerA", [], { writable: true }),
      agent("writerB", [], { writable: true }),
      agent("reader"),
    ],
    runner,
    {
      maxParallel: 2,
      onState: ({ path, state }) => {
        if (path === "writerA" && state === "running") started.resolve();
      },
    },
  );
  await started.promise;
  for (let i = 0; i < 10 && !starts.includes("reader"); i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(starts.sort(), ["reader", "writerA"]);
  held.resolve();
  assert.equal((await pending).result.status, "succeeded");
  assert.equal(starts.length, 3);
});

test("approval pauses only its branch; rejection reruns with feedback and prior outputs", async () => {
  const runner = new FakeRunner();
  const approvals: string[] = [];
  const independent = deferred<void>();
  runner.onAgent = async (definition, context) => {
    if (definition.task === "independent") independent.resolve();
    if (context.feedback) assert.equal(context.feedback.text, "revise");
    return runner.write(context, { ready: true });
  };
  const release = deferred<void>();
  const pending = run(
    [
      agent("review", [], { approval: true }),
      agent("after", ["review"]),
      agent("independent"),
    ],
    runner,
    {
      approve: async ({ path, outputs }) => {
        approvals.push(path);
        if (approvals.length === 1) {
          assert.ok(outputs["result.json"]);
          await independent.promise;
          return { approved: false, feedback: "revise" };
        }
        await release.promise;
        return { approved: true };
      },
    },
  );
  await independent.promise;
  assert.ok(!runner.runs.includes("after"));
  release.resolve();
  const { result } = await pending;
  assert.equal(result.status, "succeeded");
  assert.equal(approvals.length, 2);
  assert.ok(
    runner.runs.some((task) => task.includes("Rejection feedback: revise")),
  );
  assert.deepEqual(runner.runs.slice(-1), ["after"]);
});

test("failure prevents new nodes while an already started sibling finishes", async () => {
  const runner = new FakeRunner();
  const held = deferred<void>();
  const waiting = deferred<void>();
  runner.onAgent = async (definition, context) => {
    if (definition.task === "slow") {
      waiting.resolve();
      await held.promise;
    }
    if (definition.task === "bad")
      return { ...succeed({}), status: "failed", error: "API failure" };
    return runner.write(context, { ready: true });
  };
  const pending = run(
    [agent("slow"), agent("bad"), agent("late", ["bad"])],
    runner,
  );
  await waiting.promise;
  held.resolve();
  const { result } = await pending;
  assert.equal(result.status, "failed");
  assert.equal(result.nodes.slow?.state, "succeeded");
  assert.equal(result.nodes.late?.state, "pending");
  assert.ok(!runner.runs.includes("late"));
});

test("abort interrupts running nodes and pending approval", async () => {
  const controller = new AbortController();
  const runner = new FakeRunner();
  const started = deferred<void>();
  runner.onAgent = async (_definition, context) =>
    new Promise<StepResult>((_resolve, reject) => {
      context.signal.addEventListener(
        "abort",
        () => reject(new Error("aborted")),
        { once: true },
      );
      started.resolve();
    });
  const pending = run([agent("hanging")], runner, {
    signal: controller.signal,
  });
  await started.promise;
  controller.abort();
  assert.equal((await pending).result.status, "aborted");

  const another = new AbortController();
  const approving = deferred<void>();
  const runApproval = run(
    [agent("review", [], { approval: true })],
    new FakeRunner(),
    {
      signal: another.signal,
      approve: async () => {
        approving.resolve();
        return new Promise(() => {});
      },
    },
  );
  await approving.promise;
  another.abort();
  assert.equal((await runApproval).result.status, "aborted");
});

test("missing and invalid JSON outputs receive two same-session repairs then fail", async () => {
  const runner = new FakeRunner();
  runner.onAgent = async () => ({
    ...succeed({}),
    status: "failed",
    error: "ENOENT",
  });
  runner.onContinue = async (_instruction, context) =>
    runner.write(context, { ready: "wrong" });
  const { result } = await run([agent("fix")], runner);
  assert.equal(result.status, "failed");
  assert.equal(runner.corrections.length, 2);
  assert.match(result.nodes.fix?.result?.error ?? "", /schema/);
  runner.corrections.length = 0;
  runner.onContinue = async (_instruction, context) =>
    runner.write(context, { ready: true });
  assert.equal((await run([agent("fix")], runner)).result.status, "succeeded");
  assert.equal(runner.corrections.length, 1);
});

test("group reruns full graph, reads prior round, succeeds or enters exhausted approval", async () => {
  const runner = new FakeRunner();
  runner.onAgent = async (definition, context) =>
    runner.write(context, { ready: definition.task.includes("round-1") });
  const child = agent("child", [], {
    definition: {
      ...agent("child").definition,
      task: "${previous.child.result.json}",
    },
  });
  const group = {
    id: "group",
    kind: "group",
    dependsOn: [],
    nodes: [child],
    until: { ref: "${nodes.child.result.json#/ready}", equals: true },
    maxRounds: 2,
    onExhausted: "fail",
  };
  const { result } = await run([group], runner);
  assert.equal(result.status, "succeeded");
  assert.equal(runner.runs[0], "");
  assert.match(runner.runs[1] ?? "", /round-1\/child/);
  runner.onAgent = async (_definition, context) =>
    runner.write(context, { ready: false });
  const failures = await run([{ ...group, maxRounds: 1 }], runner);
  assert.equal(failures.result.status, "failed");
  const approvals: string[] = [];
  const accepted = await run(
    [{ ...group, maxRounds: 1, onExhausted: "approve" }],
    runner,
    {
      approve: async (request) => {
        approvals.push(request.reason);
        return approvals.length === 1
          ? { approved: false, feedback: "more" }
          : { approved: true };
      },
    },
  );
  assert.equal(accepted.result.status, "succeeded");
  assert.deepEqual(approvals, ["group_exhausted", "group_exhausted"]);
  assert.ok(
    runner.runs.some((task) => task.includes("Rejection feedback: more")),
  );
});

test("foreach is ordered, has an empty-list success and JSON manifest, and stops after failure", async () => {
  const runner = new FakeRunner();
  runner.onAgent = async (definition, context) =>
    runner.write(
      context,
      definition.task === "source"
        ? [{ name: "a" }, { name: "b" }, { name: "c" }]
        : { ready: true },
    );
  const source = agent("source", [], {
    schemas: { "result.json": { type: "array", items: { type: "object" } } },
  });
  const each = {
    id: "each",
    dependsOn: ["source"],
    kind: "foreach",
    source: "${nodes.source.result.json}",
    nodes: [
      agent("item", [], {
        definition: { ...agent("item").definition, task: "${item.name}" },
      }),
    ],
  };
  const consumer = agent("consumer", ["each"], {
    definition: {
      ...agent("consumer").definition,
      task: "got-${nodes.each.manifest.json#/1/index}",
    },
  });
  const { result } = await run([source, each, consumer], runner);
  assert.deepEqual(runner.runs, ["source", "a", "b", "c", "got-1"]);
  const path = result.nodes.each?.result?.outputs["manifest.json"];
  assert.ok(path);
  const manifestData = JSON.parse(await readFile(path, "utf8")) as Array<{
    index: number;
    outputs: Record<string, string>;
  }>;
  assert.deepEqual(
    manifestData.map((entry) => entry.index),
    [0, 1, 2],
  );
  assert.equal(result.status, "succeeded");
  runner.runs.length = 0;
  runner.onAgent = async (definition, context) =>
    runner.write(context, definition.task === "source" ? [] : { ready: true });
  assert.equal((await run([source, each], runner)).result.status, "succeeded");
  assert.deepEqual(runner.runs, ["source"]);
  runner.runs.length = 0;
  runner.onAgent = async (definition, context) => {
    if (definition.task === "source")
      return runner.write(context, [
        { name: "a" },
        { name: "b" },
        { name: "c" },
      ]);
    if (definition.task === "b")
      return { ...succeed({}), status: "failed", error: "failed" };
    return runner.write(context, { ready: true });
  };
  assert.equal((await run([source, each], runner)).result.status, "failed");
  assert.deepEqual(runner.runs, ["source", "a", "b"]);
});

test("foreach rejects a non-array source and alternates group/foreach nesting", async () => {
  const runner = new FakeRunner();
  const source = agent("source", [], { schemas: { "result.json": {} } });
  const inner = {
    id: "inner",
    kind: "group",
    dependsOn: [],
    nodes: [
      agent("child", [], {
        definition: { ...agent("child").definition, task: "${item.name}" },
      }),
    ],
    until: { ref: "${nodes.child.result.json#/ready}", equals: true },
    maxRounds: 2,
    onExhausted: "fail",
  };
  const each = {
    id: "each",
    dependsOn: ["source"],
    kind: "foreach",
    source: "${nodes.source.result.json}",
    nodes: [inner],
  };
  assert.equal((await run([source, each], runner)).result.status, "failed");
  runner.onAgent = async (definition, context) =>
    runner.write(
      context,
      definition.task === "source" ? [{ name: "nested" }] : { ready: true },
    );
  const outer = {
    id: "outer",
    kind: "group",
    dependsOn: ["source"],
    nodes: [{ ...each, dependsOn: [] }],
    until: { ref: "${nodes.each.manifest.json#/0/index}", equals: 0 },
    maxRounds: 2,
    onExhausted: "fail",
  };
  const { result } = await run([source, outer], runner);
  assert.equal(result.status, "succeeded");
  assert.ok(runner.runs.includes("nested"));
});

test("failure prevents capacity-waiting independent nodes from starting", async () => {
  const runner = new FakeRunner();
  const badStarted = deferred<void>();
  const held = deferred<void>();
  runner.onAgent = async (definition, context) => {
    if (definition.task === "bad") {
      badStarted.resolve();
      await held.promise;
      return { ...succeed({}), status: "failed", error: "fail" };
    }
    return runner.write(context, { ready: true });
  };
  const pending = run([agent("bad"), agent("queued")], runner, {
    maxParallel: 1,
  });
  await badStarted.promise;
  held.resolve();
  const { result } = await pending;
  assert.equal(result.status, "failed");
  assert.equal(result.nodes.bad?.state, "failed");
  assert.equal(result.nodes.queued?.state, "pending");
  assert.ok(!runner.runs.includes("queued"));
});

test("already-running container finishes its children when a sibling fails", async () => {
  const runner = new FakeRunner();
  const containerStarted = deferred<void>();
  const containerHeld = deferred<void>();
  runner.onAgent = async (definition, context) => {
    if (definition.task === "c1") {
      containerStarted.resolve();
      await containerHeld.promise;
      return runner.write(context, { ready: true });
    }
    if (definition.task === "c2") {
      return runner.write(context, { ready: true });
    }
    if (definition.task === "bad") {
      await containerStarted.promise;
      return { ...succeed({}), status: "failed", error: "sibling error" };
    }
    return runner.write(context, { ready: true });
  };
  const group = {
    id: "group",
    kind: "group",
    dependsOn: [],
    nodes: [agent("c1"), agent("c2", ["c1"])],
    until: { ref: "${nodes.c2.result.json#/ready}", equals: true },
    maxRounds: 1,
    onExhausted: "fail",
  };
  const pending = run([group, agent("bad")], runner, { maxParallel: 2 });
  await containerStarted.promise;
  containerHeld.resolve();
  const { result } = await pending;
  assert.equal(result.status, "failed");
  assert.equal(result.nodes.bad?.state, "failed");
  assert.equal(result.nodes.group?.state, "succeeded");
  assert.ok(runner.runs.includes("c1"));
  assert.ok(runner.runs.includes("c2"));
});

test("rejection of an approved group node reruns its children with feedback", async () => {
  const runner = new FakeRunner();
  let reviews = 0;
  runner.onAgent = async (_definition, context) => {
    return runner.write(context, { ready: true });
  };
  const child = agent("inner", [], {
    definition: {
      ...agent("inner").definition,
      task: "${outputs.result.json}",
    },
  });
  const group = {
    id: "reviewGroup",
    kind: "group",
    dependsOn: [],
    approval: true,
    nodes: [child],
    until: { ref: "${nodes.inner.result.json#/ready}", equals: true },
    maxRounds: 1,
    onExhausted: "fail",
  };
  const { result } = await run([group], runner, {
    approve: async ({ outputs }) => {
      reviews++;
      if (reviews === 1) {
        assert.ok(outputs["manifest.json"]);
        return { approved: false, feedback: "revise container" };
      }
      return { approved: true };
    },
  });
  assert.equal(result.status, "succeeded");
  assert.equal(reviews, 2);
  assert.ok(
    runner.runs.some((task) =>
      task.includes("Rejection feedback: revise container"),
    ),
  );
});

test("missing declared schema-free output file triggers repair and fails if absent", async () => {
  const runner = new FakeRunner();
  const nodeDef = agent("plain", [], {
    definition: {
      ...agent("plain").definition,
      outputs: ["notes.txt"],
    },
    schemas: undefined,
  });
  runner.onAgent = async (_definition, context) => {
    return succeed({
      "notes.txt": join(context.outputDir, "out", "notes.txt"),
    });
  };
  runner.onContinue = async (_instruction, context) => {
    return succeed({
      "notes.txt": join(context.outputDir, "out", "notes.txt"),
    });
  };
  const { result } = await run([nodeDef], runner);
  assert.equal(result.status, "failed");
  assert.equal(runner.corrections.length, 2);
  assert.match(
    result.nodes.plain?.result?.error ?? "",
    /missing output: notes.txt/,
  );
});
