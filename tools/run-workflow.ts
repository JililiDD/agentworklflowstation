// biome-ignore-all lint/suspicious/noTemplateCurlyInString: The example contains a literal workflow reference.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentNodeDefinition,
  CommandNodeDefinition,
  StepContext,
  StepResult,
  StepRunner,
} from "@aipilotagent/runner";
import { loadWorkflow, runWorkflow } from "../packages/engine/src/index.ts";

class DemoRunner implements StepRunner {
  async runAgent(
    definition: AgentNodeDefinition,
    context: StepContext,
  ): Promise<StepResult> {
    if (context.signal.aborted) throw new Error("aborted");
    const directory = join(context.outputDir, "out");
    await mkdir(directory, { recursive: true });
    const path = join(directory, "result.json");
    await writeFile(
      path,
      JSON.stringify({
        ready: definition.task === "seed" || definition.task === "true",
      }),
    );
    return {
      status: "succeeded",
      outputs: { "result.json": path },
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }
  async runCommand(
    _definition: CommandNodeDefinition,
    _context: StepContext,
  ): Promise<StepResult> {
    throw new Error("the demo has no command node");
  }
  async continueAgent(
    _instruction: string,
    _context: StepContext,
  ): Promise<StepResult> {
    throw new Error("the demo does not need corrections");
  }
  async dispose(): Promise<void> {}
}

const node = (id: string, dependsOn: string[], task: string) => ({
  id,
  kind: "agent",
  dependsOn,
  definition: {
    kind: "agent",
    model: "fake/small",
    thinkingLevel: "off",
    task,
    interactive: false,
    outputs: ["result.json"],
  },
  schemas: {
    "result.json": {
      type: "object",
      properties: { ready: { type: "boolean" } },
      required: ["ready"],
    },
  },
});
const definition = await loadWorkflow(
  JSON.stringify({
    inputs: [],
    maxParallel: 2,
    nodes: [
      node("seed", [], "seed"),
      node("finish", ["seed"], "${nodes.seed.result.json#/ready}"),
    ],
  }),
  { models: { "fake/small": ["off"] } },
);
const directory = await mkdtemp(join(tmpdir(), "engine-demo-"));
const runner = new DemoRunner();
try {
  const result = await runWorkflow(definition, runner, {
    workDir: directory,
    outputDir: directory,
    inputs: {},
    signal: new AbortController().signal,
    callbacks: {
      onState: (event) => console.log(`${event.path}: ${event.state}`),
    },
  });
  console.log(`workflow: ${result.status}`);
  if (result.status !== "succeeded") process.exitCode = 1;
} finally {
  await runner.dispose();
}
