import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {
  AgentNodeDefinition,
  CommandNodeDefinition,
  StepContext,
  StepResult,
  StepRunner,
} from "@aipilotagent/runner";
import {
  AuthManager,
  createPlatformHttpServer,
  RunManager,
} from "@aipilotagent/service";

export class FakeRunner implements StepRunner {
  runs: string[] = [];
  onAgent?: (def: AgentNodeDefinition, ctx: StepContext) => Promise<StepResult>;
  onCommand?: (
    def: CommandNodeDefinition,
    ctx: StepContext,
  ) => Promise<StepResult>;

  async runAgent(
    def: AgentNodeDefinition,
    ctx: StepContext,
  ): Promise<StepResult> {
    this.runs.push(def.task);
    if (this.onAgent) return this.onAgent(def, ctx);
    return this.write(ctx, { ok: true });
  }

  async runCommand(
    def: CommandNodeDefinition,
    ctx: StepContext,
  ): Promise<StepResult> {
    this.runs.push(def.command);
    if (this.onCommand) return this.onCommand(def, ctx);
    return {
      status: "succeeded",
      outputs: {},
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }

  async continueAgent(
    _instruction: string,
    ctx: StepContext,
  ): Promise<StepResult> {
    return this.write(ctx, { ok: true });
  }

  async write(
    ctx: StepContext,
    body: unknown,
    costUsd = 0.05,
    fileName = "result.json",
  ): Promise<StepResult> {
    const out = join(ctx.outputDir, "out");
    await mkdir(out, { recursive: true });
    const path = join(out, fileName);
    await writeFile(
      path,
      typeof body === "string" ? body : JSON.stringify(body),
    );
    return {
      status: "succeeded",
      outputs: { [fileName]: path },
      usage: { inputTokens: 10, outputTokens: 20, costUsd },
    };
  }

  async dispose(): Promise<void> {}
}

export interface TestServerFixture {
  baseUrl: string;
  dataDir: string;
  authPath: string;
  repoDir: string;
  skillsDir: string;
  runner: FakeRunner;
  cleanup: () => Promise<void>;
}

export async function createTestServerFixture(): Promise<TestServerFixture> {
  const tempDir = await mkdtemp(join(tmpdir(), "aipilot-web-e2e-"));
  const dataDir = join(tempDir, "data");
  const authPath = join(tempDir, "auth.json");
  const repoDir = join(tempDir, "repo");
  const skillsDir = join(tempDir, "skills");

  await mkdir(dataDir, { recursive: true });
  await mkdir(repoDir, { recursive: true });
  await mkdir(skillsDir, { recursive: true });

  // Init git repo
  spawnSync("git", ["init"], { cwd: repoDir });
  spawnSync("git", ["config", "user.email", "test@example.com"], {
    cwd: repoDir,
  });
  spawnSync("git", ["config", "user.name", "Test User"], { cwd: repoDir });
  await writeFile(join(repoDir, "README.md"), "# Target Repo\n");
  spawnSync("git", ["add", "README.md"], { cwd: repoDir });
  spawnSync("git", ["commit", "-m", "init commit"], { cwd: repoDir });

  // Write sample skill
  const sampleSkillDir = join(skillsDir, "test-expert");
  await mkdir(sampleSkillDir, { recursive: true });
  await writeFile(
    join(sampleSkillDir, "SKILL.md"),
    "---\nname: test-expert\ndescription: Expert skill for testing\n---\n# Skill body\n",
  );

  // Write sample workflow
  const workflowsDir = join(dataDir, "workflows");
  await mkdir(workflowsDir, { recursive: true });
  const wfYaml = `
name: Sample Review Workflow
inputs:
  - topic
maxParallel: 1
budgetUsd: 15.00
nodes:
  - id: askNode
    kind: agent
    definition:
      model: fake/small
      thinkingLevel: off
      task: "Interview user on {{inputs.topic}}"
      interactive: true
      outputs:
        - summary.txt
  - id: approveNode
    kind: agent
    dependsOn:
      - askNode
    approval: true
    writable: true
    definition:
      model: fake/small
      thinkingLevel: off
      task: "Draft solution"
      outputs:
        - draft.txt
`;
  await writeFile(join(workflowsDir, "sample-review.yaml"), wfYaml, "utf8");

  // Create initial auth.json
  await writeFile(authPath, JSON.stringify({}), "utf8");

  const runner = new FakeRunner();
  const runManager = new RunManager({ dataDir, runner });
  const authManager = new AuthManager({ authPath });

  const staticDir = resolve(import.meta.dirname, "../dist");

  const serverHandle = createPlatformHttpServer({
    dataDir,
    authPath,
    staticDir,
    runManager,
    authManager,
  });

  const port = await serverHandle.start();
  const baseUrl = `http://127.0.0.1:${port}`;

  const cleanup = async () => {
    await serverHandle.stop();
    await rm(tempDir, { recursive: true, force: true });
  };

  return {
    baseUrl,
    dataDir,
    authPath,
    repoDir,
    skillsDir,
    runner,
    cleanup,
  };
}
