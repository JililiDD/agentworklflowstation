// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Literal workflow references.
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  createAgentRunner,
  createFakeSessionAdapter,
  createPiSessionAdapter,
  type StepRunner,
} from "@aipilotagent/runner";
import {
  loadWorkflow,
  startDurableWorkflow,
} from "../packages/engine/src/index.ts";

const execFile = promisify(execFileCallback);

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFile("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "demo",
      GIT_AUTHOR_EMAIL: "demo@aipilot.local",
      GIT_COMMITTER_NAME: "demo",
      GIT_COMMITTER_EMAIL: "demo@aipilot.local",
    },
  });
  return stdout.trim();
}

const isReal =
  process.argv.includes("--real") ||
  process.argv.includes("--luna") ||
  process.argv.some((arg) => arg.startsWith("--model"));
const modelIndex = process.argv.indexOf("--model");
const customModel =
  modelIndex !== -1 ? process.argv[modelIndex + 1] : undefined;
const useLuna =
  process.argv.includes("--luna") || customModel?.includes("luna");
const defaultRealModel = useLuna
  ? "codexJ/gpt-6-luna"
  : "anthropic/claude-haiku-5-5";
const model = isReal ? (customModel ?? defaultRealModel) : "fake/small";
const thinkingLevel = (useLuna ? "low" : "off") as const;

console.log(
  `Starting durable workflow (${isReal ? `REAL model: ${model}` : "demo runner"})...`,
);

const baseDir = await mkdtemp(join(tmpdir(), "aipilot-durable-demo-"));
const repoDir = join(baseDir, "target-repo");
const runDir = join(baseDir, "run-output");

await mkdir(repoDir, { recursive: true });
await git(["init"], repoDir);
await git(["config", "user.name", "demo"], repoDir);
await git(["config", "user.email", "demo@aipilot.local"], repoDir);
await writeFile(
  join(repoDir, "hello.txt"),
  "Hello from the target repository!\n",
);
await git(["add", "hello.txt"], repoDir);
await git(["commit", "-m", "initial commit on main"], repoDir);

const definition = await loadWorkflow(
  JSON.stringify({
    inputs: ["project"],
    maxParallel: 1,
    nodes: [
      {
        id: "writer",
        kind: "agent",
        dependsOn: [],
        writable: true,
        definition: {
          kind: "agent",
          model,
          thinkingLevel,
          task: "Create a file named welcome.md in the project directory welcoming ${inputs.project}. Write a summary to ${outputs.result.json} with an ok boolean.",
          interactive: false,
          outputs: ["result.json"],
        },
        schemas: {
          "result.json": {
            type: "object",
            properties: { ok: { type: "boolean" } },
            required: ["ok"],
          },
        },
      },
      {
        id: "reader",
        kind: "agent",
        dependsOn: ["writer"],
        writable: false,
        when: [{ ref: "${nodes.writer.result.json#/ok}", equals: true }],
        definition: {
          kind: "agent",
          model,
          thinkingLevel,
          task: "Read welcome.md created by writer and check ${nodes.writer.result.json#/ok}. Write verification to ${outputs.audit.json} with verified boolean.",
          interactive: false,
          outputs: ["audit.json"],
        },
        schemas: {
          "audit.json": {
            type: "object",
            properties: { verified: { type: "boolean" } },
            required: ["verified"],
          },
        },
      },
    ],
  }),
  {
    models: {
      [model]: ["off", "low", "medium", "high"],
    },
  },
);

let runner: StepRunner;
if (isReal) {
  const adapter = createPiSessionAdapter();
  runner = createAgentRunner(adapter);
} else {
  const adapter = createFakeSessionAdapter();
  adapter.onPrompt = async (workDir, text) => {
    if (text.includes("Create a file named welcome.md")) {
      const match = /\/[^\s]*attempt-\d+\/out\/result\.json/.exec(text);
      if (match) {
        const outPath = match[0];
        await mkdir(join(outPath, ".."), { recursive: true });
        await writeFile(outPath, JSON.stringify({ ok: true }));
      }
      await writeFile(
        join(workDir, "welcome.md"),
        "# Welcome to aiworflowstation\n",
      );
    } else if (text.includes("audit.json")) {
      const match = /\/[^\s]*attempt-\d+\/out\/audit\.json/.exec(text);
      if (match) {
        const outPath = match[0];
        await mkdir(join(outPath, ".."), { recursive: true });
        await writeFile(outPath, JSON.stringify({ verified: true }));
      }
    }
  };
  runner = createAgentRunner(adapter);
}

try {
  const { state, workspace } = await startDurableWorkflow({
    workflow: definition,
    runner,
    repoDir,
    runDir,
    inputs: { project: "aiworflowstation" },
    callbacks: {
      onState: (event) =>
        console.log(`[state] ${event.path} -> ${event.state}`),
      onStepEvent: (path, event) =>
        console.log(`[step] ${path}: ${event.type} - ${event.summary}`),
    },
  });

  console.log(`\nWorkflow finished: ${state.status}`);
  console.log(`Branch: ${state.branch}`);
  console.log(`Checkpoints:`);
  for (const [id, node] of Object.entries(state.nodes)) {
    console.log(
      `  - ${id}: state=${node.state}, commit=${node.checkpointCommit ?? "none"}`,
    );
    if (node.diffPath) {
      console.log(`    diff:\n${await readFile(node.diffPath, "utf8")}`);
    }
  }

  const log = await git(["log", "--oneline"], workspace.worktreeDir);
  console.log(`\nWorktree Git Log:\n${log}`);
} finally {
  await runner.dispose();
}
