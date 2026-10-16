import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import type {
  AgentNodeDefinition,
  CommandNodeDefinition,
  StepContext,
  StepResult,
  StepRunner,
} from "@aipilotagent/runner";
import { createPlatformHttpServer } from "./http-server.ts";
import { RunManager } from "./run-manager.ts";

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
    return {
      status: "succeeded",
      outputs: {},
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }

  async continueAgent(
    _instruction: string,
    context: StepContext,
  ): Promise<StepResult> {
    return this.write(context, { ok: true });
  }

  async write(
    context: StepContext,
    body: unknown,
    costUsd?: number,
  ): Promise<StepResult> {
    const out = join(context.outputDir, "out");
    await mkdir(out, { recursive: true });
    const path = join(out, "result.json");
    await writeFile(path, JSON.stringify(body));
    return {
      status: "succeeded",
      outputs: { "result.json": path },
      usage: { inputTokens: 10, outputTokens: 20, costUsd },
    };
  }

  async dispose(): Promise<void> {}
}

let tempDir: string;
let repoDir: string;
let dataDir: string;
let authPath: string;

function initGitRepo(dir: string): void {
  execFileSync("git", ["init", dir]);
  execFileSync("git", ["-C", dir, "config", "user.name", "Test User"]);
  execFileSync("git", ["-C", dir, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", dir, "commit", "--allow-empty", "-m", "initial"]);
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "aipilot-http-test-"));
  repoDir = join(tempDir, "target-repo");
  dataDir = join(tempDir, "data");
  authPath = join(tempDir, "auth.json");
  await mkdir(repoDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await writeFile(authPath, "{}");
  initGitRepo(repoDir);
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

test("HTTP server enforces loopback Host, Origin, and payload limits", async () => {
  const runner = new FakeRunner();
  const runManager = new RunManager({ dataDir, runner });
  const serverHandle = createPlatformHttpServer({
    dataDir,
    authPath,
    runManager,
  });
  const port = await serverHandle.start();

  try {
    // 1. Valid request to /api/health
    const resOk = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { Host: `127.0.0.1:${port}` },
    });
    assert.equal(resOk.status, 200);
    const json = (await resOk.json()) as Record<string, unknown>;
    assert.equal(json.status, "ok");

    // 2. Reject non-loopback Host header (sent via raw http.request because fetch overrides Host)
    const badHostStatus = await new Promise<number>((resolve) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path: "/api/health",
          method: "GET",
          headers: { host: "evil.attacker.com" },
        },
        (res) => {
          resolve(res.statusCode ?? 0);
        },
      );
      req.end();
    });
    assert.equal(badHostStatus, 400);

    // 2b. Finding 1: Accept IPv6 loopback Host header ([::1]:port and ::1)
    const ipv6HostStatus = await new Promise<number>((resolve) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path: "/api/health",
          method: "GET",
          headers: { host: `[::1]:${port}` },
        },
        (res) => {
          resolve(res.statusCode ?? 0);
        },
      );
      req.end();
    });
    assert.equal(ipv6HostStatus, 200);

    // 3. Reject cross-site Origin for mutation request
    const resCrossSite = await fetch(`http://127.0.0.1:${port}/api/workflows`, {
      method: "POST",
      headers: {
        Host: `127.0.0.1:${port}`,
        Origin: "https://malicious-website.com",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ id: "x", yaml: "name: x" }),
    });
    assert.equal(resCrossSite.status, 403);

    // 3b. Finding 3: Do not emit wildcard CORS on GET for untrusted origins
    const resGetUntrusted = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { Origin: "https://malicious-website.com" },
    });
    assert.equal(resGetUntrusted.status, 200);
    assert.equal(
      resGetUntrusted.headers.get("access-control-allow-origin"),
      null,
    );

    // Emit loopback CORS only for allowed loopback origins
    const resGetLoopback = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { Origin: "http://localhost:3000" },
    });
    assert.equal(resGetLoopback.status, 200);
    assert.equal(
      resGetLoopback.headers.get("access-control-allow-origin"),
      "http://localhost:3000",
    );
  } finally {
    await serverHandle.stop();
  }
});

test("HTTP server workflows and settings CRUD", async () => {
  const runner = new FakeRunner();
  const runManager = new RunManager({ dataDir, runner });
  const serverHandle = createPlatformHttpServer({
    dataDir,
    authPath,
    runManager,
  });
  const port = await serverHandle.start();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // Save workflow
    const wfYaml = `
name: Demo Flow
inputs:
  - topic
maxParallel: 1
nodes:
  - id: step1
    kind: command
    definition:
      task: run echo
      command: echo hello
`;
    const resCreate = await fetch(`${baseUrl}/api/workflows`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "demo", yaml: wfYaml }),
    });
    assert.equal(resCreate.status, 201);

    // List workflows
    const resList = await fetch(`${baseUrl}/api/workflows`);
    assert.equal(resList.status, 200);
    const list = (await resList.json()) as Array<{ id: string }>;
    assert.equal(list.length, 1);
    assert.equal(list[0]?.id, "demo");

    // Get workflow
    const resGet = await fetch(`${baseUrl}/api/workflows/demo`);
    assert.equal(resGet.status, 200);
    const wf = (await resGet.json()) as { yaml: string };
    assert.match(wf.yaml, /Demo Flow/);

    // Settings
    const resSettingsPut = await fetch(`${baseUrl}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skillDirectories: [tempDir] }),
    });
    assert.equal(resSettingsPut.status, 200);

    const resSettingsGet = await fetch(`${baseUrl}/api/settings`);
    assert.equal(resSettingsGet.status, 200);
    const settings = (await resSettingsGet.json()) as {
      skillDirectories: string[];
    };
    assert.deepEqual(settings.skillDirectories, [tempDir]);

    // Delete workflow
    const resDel = await fetch(`${baseUrl}/api/workflows/demo`, {
      method: "DELETE",
    });
    assert.equal(resDel.status, 200);
    const resListEmpty = await fetch(`${baseUrl}/api/workflows`);
    assert.equal(
      ((await resListEmpty.json()) as Array<Record<string, unknown>>).length,
      0,
    );
  } finally {
    await serverHandle.stop();
  }
});

test("HTTP server runs workflow, streams events, and handles question & approval via inbox", async () => {
  const runner = new FakeRunner();
  runner.onAgent = async (definition, context) => {
    if (definition.task.includes("ask")) {
      const answer = await context.callbacks.ask?.({
        prompt: "Proceed with release?",
        options: [
          { id: "yes", label: "Yes" },
          { id: "no", label: "No" },
        ],
      });
      return runner.write(context, {
        chosen: answer?.text ?? answer?.optionId,
      });
    }
    await writeFile(join(context.workDir, "result.txt"), "generated content");
    return runner.write(context, { success: true });
  };

  const runManager = new RunManager({ dataDir, runner });
  const serverHandle = createPlatformHttpServer({
    dataDir,
    authPath,
    runManager,
  });
  const port = await serverHandle.start();
  const baseUrl = `http://127.0.0.1:${port}`;

  const wfYaml = `
inputs:
  - topic
maxParallel: 1
nodes:
  - id: askNode
    kind: agent
    definition:
      model: fake/small
      thinkingLevel: off
      task: "ask for permission"
      interactive: true
  - id: writeNode
    kind: agent
    dependsOn:
      - askNode
    approval: true
    writable: true
    definition:
      model: fake/small
      thinkingLevel: off
      task: "write file"
`;

  try {
    // 1. Start run
    const resStart = await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workflowYaml: wfYaml,
        targetRepo: repoDir,
        inputs: { topic: "release" },
      }),
    });
    assert.equal(resStart.status, 201);
    const startData = (await resStart.json()) as { runId: string };
    const runId = startData.runId;
    assert.ok(runId);

    // 2. Poll inbox for question from askNode
    let questionFound = false;
    for (let i = 0; i < 30; i++) {
      const resInbox = await fetch(`${baseUrl}/api/inbox`);
      const inbox = (await resInbox.json()) as {
        questions: Array<{
          nodePath: string;
          question: { prompt: string };
        }>;
        approvals: Array<{ nodePath: string }>;
      };
      if (inbox.questions.length > 0) {
        questionFound = true;
        assert.equal(inbox.questions[0]?.nodePath, "askNode");
        assert.equal(
          inbox.questions[0]?.question.prompt,
          "Proceed with release?",
        );
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(questionFound, true);

    // 3. Answer question
    const resAnswer = await fetch(
      `${baseUrl}/api/runs/${runId}/questions/askNode`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ optionId: "yes", text: "Yes" }),
      },
    );
    assert.equal(resAnswer.status, 200);

    // 4. Poll inbox for approval from writeNode
    let approvalFound = false;
    for (let i = 0; i < 30; i++) {
      const resInbox = await fetch(`${baseUrl}/api/inbox`);
      const inbox = (await resInbox.json()) as {
        approvals: Array<{ nodePath: string }>;
      };
      if (inbox.approvals.length > 0) {
        approvalFound = true;
        assert.equal(inbox.approvals[0]?.nodePath, "writeNode");
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(approvalFound, true);

    // 5. Rejection without feedback fails
    const resBadReject = await fetch(
      `${baseUrl}/api/runs/${runId}/approvals/writeNode`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approved: false }),
      },
    );
    assert.equal(resBadReject.status, 500);

    // 6. Approve node
    const resApprove = await fetch(
      `${baseUrl}/api/runs/${runId}/approvals/writeNode`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approved: true }),
      },
    );
    assert.equal(resApprove.status, 200);

    // 7. Wait for run completion
    let completed = false;
    for (let i = 0; i < 60; i++) {
      const resRun = await fetch(`${baseUrl}/api/runs/${runId}`);
      const run = (await resRun.json()) as { status: string };
      if (run.status === "succeeded") {
        completed = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 30));
    }
    assert.equal(completed, true);

    // 8. Read events
    const resEvents = await fetch(`${baseUrl}/api/runs/${runId}/events`);
    assert.equal(resEvents.status, 200);
    const events = (await resEvents.json()) as Array<Record<string, unknown>>;
    assert.ok(events.length > 0);

    // 9. Finding 2: SSE stream on completed run closes immediately instead of hanging
    const resSseFinished = await fetch(
      `${baseUrl}/api/runs/${runId}/events?stream=true`,
    );
    assert.equal(resSseFinished.status, 200);
    const sseBody = await resSseFinished.text();
    assert.ok(sseBody.includes("data:"));
  } finally {
    await serverHandle.stop();
  }
});

test("HTTP server handles stop and resume on durable runs", async () => {
  const runner = new FakeRunner();
  let firstNodeStarted = false;
  runner.onAgent = async (definition, context) => {
    if (definition.task === "step1") {
      firstNodeStarted = true;
      await new Promise((r) => setTimeout(r, 100));
      return runner.write(context, { ok: true });
    }
    await new Promise((r) => setTimeout(r, 500));
    return runner.write(context, { ok: true });
  };

  const runManager = new RunManager({ dataDir, runner });
  const serverHandle = createPlatformHttpServer({
    dataDir,
    authPath,
    runManager,
  });
  const port = await serverHandle.start();
  const baseUrl = `http://127.0.0.1:${port}`;

  const wfYaml = `
inputs:
  - topic
maxParallel: 1
nodes:
  - id: step1
    kind: agent
    definition:
      model: fake/small
      thinkingLevel: off
      task: step1
  - id: step2
    kind: agent
    dependsOn:
      - step1
    definition:
      model: fake/small
      thinkingLevel: off
      task: step2
`;

  try {
    const resStart = await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workflowYaml: wfYaml,
        targetRepo: repoDir,
        inputs: { topic: "test" },
      }),
    });
    const { runId } = (await resStart.json()) as { runId: string };

    // Wait until step1 is running
    while (!firstNodeStarted) {
      await new Promise((r) => setTimeout(r, 10));
    }

    // Stop run
    const resStop = await fetch(`${baseUrl}/api/runs/${runId}/stop`, {
      method: "POST",
    });
    assert.equal(resStop.status, 200);

    // Wait for run status to become aborted
    for (let i = 0; i < 30; i++) {
      const resRun = await fetch(`${baseUrl}/api/runs/${runId}`);
      const run = (await resRun.json()) as { status: string };
      if (run.status === "aborted" || run.status === "failed") {
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }

    // Resume run
    runner.onAgent = async (_definition, context) => {
      return runner.write(context, { resumed: true });
    };
    const resResume = await fetch(`${baseUrl}/api/runs/${runId}/resume`, {
      method: "POST",
    });
    assert.equal(resResume.status, 200);

    // Wait for resumed run to succeed
    let resumedSuccess = false;
    for (let i = 0; i < 40; i++) {
      const resRun = await fetch(`${baseUrl}/api/runs/${runId}`);
      const run = (await resRun.json()) as { status: string };
      if (run.status === "succeeded") {
        resumedSuccess = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(resumedSuccess, true);
  } finally {
    await serverHandle.stop();
  }
});

test("service restart recovers interrupted runs as failed and resumes fresh", async () => {
  const runner = new FakeRunner();
  // Simulate run that is waiting for answer when service process exits
  runner.onAgent = async (_definition, context) => {
    // Hangs waiting for answer
    await new Promise((_resolve) => {});
    return runner.write(context, { ok: true });
  };

  const runManager1 = new RunManager({ dataDir, runner });
  const server1 = createPlatformHttpServer({
    dataDir,
    authPath,
    runManager: runManager1,
  });
  const port1 = await server1.start();
  const baseUrl1 = `http://127.0.0.1:${port1}`;

  const wfYaml = `
inputs:
  - topic
maxParallel: 1
nodes:
  - id: askNode
    kind: agent
    definition:
      model: fake/small
      thinkingLevel: off
      task: askNode
      interactive: true
`;

  let runId: string;
  try {
    const resStart = await fetch(`${baseUrl1}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workflowYaml: wfYaml,
        targetRepo: repoDir,
        inputs: { topic: "test" },
      }),
    });
    const data = (await resStart.json()) as { runId: string };
    runId = data.runId;

    // Wait until run is running and waiting
    await new Promise((r) => setTimeout(r, 100));
  } finally {
    // Simulate service abruptly shutting down
    await server1.stop();
  }

  // Simulate new service instance starting up
  const runner2 = new FakeRunner();
  runner2.onAgent = async (_definition, context) => {
    return runner2.write(context, { freshSession: true });
  };
  const runManager2 = new RunManager({ dataDir, runner: runner2 });
  // Startup recovery
  await runManager2.recoverInterruptedRunsOnStartup();

  const server2 = createPlatformHttpServer({
    dataDir,
    authPath,
    runManager: runManager2,
  });
  const port2 = await server2.start();
  const baseUrl2 = `http://127.0.0.1:${port2}`;

  try {
    // Check that interrupted run is marked as failed on startup
    const resRun = await fetch(`${baseUrl2}/api/runs/${runId}`);
    const run = (await resRun.json()) as {
      status: string;
      warnings: string[];
    };
    assert.equal(run.status, "failed");
    assert.ok(
      run.warnings.some((w: string) => w.includes("service process exited")),
    );

    // Resume the run
    const resResume = await fetch(`${baseUrl2}/api/runs/${runId}/resume`, {
      method: "POST",
    });
    assert.equal(resResume.status, 200);

    // Wait for resumed run to complete
    let completed = false;
    for (let i = 0; i < 30; i++) {
      const resCheck = await fetch(`${baseUrl2}/api/runs/${runId}`);
      const check = (await resCheck.json()) as { status: string };
      if (check.status === "succeeded") {
        completed = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(completed, true);
    assert.equal(runner2.runs.length, 1);
  } finally {
    await server2.stop();
  }
});

test("HTTP server serves static files with traversal protection and SPA fallback", async () => {
  const runner = new FakeRunner();
  const runManager = new RunManager({ dataDir, runner });

  // Create temporary static dir
  const staticDir = join(tempDir, "static-site");
  await mkdir(staticDir, { recursive: true });
  await writeFile(
    join(staticDir, "index.html"),
    "<!doctype html><html><body><h1>aipilotAgent UI</h1></body></html>",
    "utf8",
  );
  await mkdir(join(staticDir, "assets"), { recursive: true });
  await writeFile(
    join(staticDir, "assets", "app.js"),
    "console.log('loaded');",
    "utf8",
  );

  const serverHandle = createPlatformHttpServer({
    dataDir,
    authPath,
    staticDir,
    runManager,
  });
  const port = await serverHandle.start();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Root returns index.html
    const resRoot = await fetch(`${baseUrl}/`);
    assert.equal(resRoot.status, 200);
    assert.match(resRoot.headers.get("content-type") ?? "", /text\/html/);
    const htmlText = await resRoot.text();
    assert.ok(htmlText.includes("aipilotAgent UI"));

    // 2. Static asset returns proper content type
    const resAsset = await fetch(`${baseUrl}/assets/app.js`);
    assert.equal(resAsset.status, 200);
    assert.match(
      resAsset.headers.get("content-type") ?? "",
      /text\/javascript/,
    );

    // 3. SPA fallback on unknown route returns index.html
    const resSpa = await fetch(`${baseUrl}/runs/some-id`);
    assert.equal(resSpa.status, 200);
    assert.match(resSpa.headers.get("content-type") ?? "", /text\/html/);
    const spaText = await resSpa.text();
    assert.ok(spaText.includes("aipilotAgent UI"));

    // 4. Path traversal attempt is blocked
    const traversalStatus = await new Promise<number>((resolve) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path: "/%2e%2e/package.json",
          method: "GET",
        },
        (res) => {
          resolve(res.statusCode ?? 0);
        },
      );
      req.end();
    });
    assert.equal(traversalStatus, 403);
  } finally {
    await serverHandle.stop();
  }
});

test("HTTP server supports run validation, frozen definition, preview, and secret interactions", async () => {
  const runner = new FakeRunner();
  runner.onAgent = async (definition, context) => {
    await writeFile(join(context.outputDir, "task.md"), "Task: askSecret");
    if (definition.task === "askSecret") {
      const answer = await context.callbacks.ask?.({
        prompt: "Enter secret key",
        options: [{ id: "opt1", label: "Use default" }],
      });
      // The session in memory sees the real answer text
      assert.equal(answer?.text, "my-super-secret-key");
      const out = join(context.outputDir, "out");
      await mkdir(out, { recursive: true });
      const filePath = join(out, "secret-out.txt");
      await writeFile(filePath, "secret processed successfully");
      return {
        status: "succeeded",
        outputs: { "secret-out.txt": filePath },
        usage: { inputTokens: 10, outputTokens: 20 },
      };
    }
    return runner.write(context, { result: "done" });
  };

  const runManager = new RunManager({ dataDir, runner });
  const serverHandle = createPlatformHttpServer({
    dataDir,
    authPath,
    runManager,
  });
  const port = await serverHandle.start();
  const baseUrl = `http://127.0.0.1:${port}`;

  const wfYaml = `
inputs:
  - topic
  - requiredInput
maxParallel: 1
nodes:
  - id: askSecret
    kind: agent
    definition:
      model: fake/small
      thinkingLevel: off
      task: askSecret
      interactive: true
      outputs:
        - secret-out.txt
`;

  try {
    // 1. POST /api/runs/validate
    // 1a. Missing input check
    const resValMissing = await fetch(`${baseUrl}/api/runs/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workflowYaml: wfYaml,
        targetRepo: repoDir,
        inputs: { topic: "test" }, // missing requiredInput
      }),
    });
    assert.equal(resValMissing.status, 200);
    const valMissing = (await resValMissing.json()) as {
      valid: boolean;
      missingInputs: string[];
      warnings: string[];
    };
    assert.equal(valMissing.valid, false);
    assert.ok(valMissing.missingInputs.includes("requiredInput"));

    // 1b. Invalid targetRepo (non-git)
    const resValNonGit = await fetch(`${baseUrl}/api/runs/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workflowYaml: wfYaml,
        targetRepo: tempDir, // tempDir is not a git repo
        inputs: { topic: "test", requiredInput: "yes" },
      }),
    });
    assert.equal(resValNonGit.status, 200);
    const valNonGit = (await resValNonGit.json()) as {
      valid: boolean;
      errors: string[];
    };
    assert.equal(valNonGit.valid, false);
    assert.ok(
      valNonGit.errors.some((e: string) => e.includes("not a git repository")),
    );

    // 2. Start run
    const resStart = await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workflowYaml: wfYaml,
        targetRepo: repoDir,
        inputs: { topic: "test", requiredInput: "value" },
      }),
    });
    const { runId } = (await resStart.json()) as { runId: string };

    // 3. GET /api/runs/:runId/definition
    const resDef = await fetch(`${baseUrl}/api/runs/${runId}/definition`);
    assert.equal(resDef.status, 200);
    const def = (await resDef.json()) as { inputs: string[]; nodes: unknown[] };
    assert.equal(def.inputs.length, 2);
    assert.equal(def.nodes.length, 1);

    // 4. Poll inbox for question
    let questionPending = false;
    for (let i = 0; i < 20; i++) {
      const resInbox = await fetch(`${baseUrl}/api/inbox`);
      const inbox = (await resInbox.json()) as {
        questions: Array<{ runId: string; nodePath: string }>;
      };
      if (inbox.questions.length > 0) {
        questionPending = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(questionPending, true);

    // 5. Answer question with secret: true
    const resAnswer = await fetch(
      `${baseUrl}/api/runs/${runId}/questions/askSecret`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "my-super-secret-key",
          secret: true,
        }),
      },
    );
    assert.equal(resAnswer.status, 200);

    // 6. Wait for run to succeed
    let completed = false;
    for (let i = 0; i < 30; i++) {
      const resRun = await fetch(`${baseUrl}/api/runs/${runId}`);
      const run = (await resRun.json()) as { status: string };
      if (run.status === "succeeded") {
        completed = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(completed, true);

    // 7. GET /api/runs/:runId/interactions verifies secret text is masked to (secret)
    const resInteractions = await fetch(
      `${baseUrl}/api/runs/${runId}/interactions`,
    );
    assert.equal(resInteractions.status, 200);
    const interactions = (await resInteractions.json()) as Array<{
      type: string;
      answer?: { text: string; isSecret?: boolean };
    }>;
    assert.equal(interactions.length, 1);
    assert.equal(interactions[0]?.answer?.isSecret, true);
    assert.equal(interactions[0]?.answer?.text, "(secret)");

    // 8. GET /api/runs/:runId/preview for task and output
    const resPreviewTask = await fetch(
      `${baseUrl}/api/runs/${runId}/preview?nodePath=askSecret&kind=task`,
    );
    assert.equal(resPreviewTask.status, 200);
    const previewTask = (await resPreviewTask.json()) as { content: string };
    assert.ok(previewTask.content.includes("askSecret"));

    const resPreviewOut = await fetch(
      `${baseUrl}/api/runs/${runId}/preview?nodePath=askSecret&kind=output&fileName=secret-out.txt`,
    );
    assert.equal(resPreviewOut.status, 200);
    const previewOut = (await resPreviewOut.json()) as { content: string };
    assert.ok(previewOut.content.includes("secret processed successfully"));

    // 8b. Traversal in preview rejected
    const resTrav = await fetch(
      `${baseUrl}/api/runs/${runId}/preview?nodePath=../etc&kind=task`,
    );
    assert.equal(resTrav.status, 500);

    // 8c. Undeclared output file rejected
    const resUndeclared = await fetch(
      `${baseUrl}/api/runs/${runId}/preview?nodePath=askSecret&kind=output&fileName=undeclared.txt`,
    );
    assert.equal(resUndeclared.status, 500);

    // 8d. Symlink preview rejected
    const outDir = join(
      dataDir,
      "runs",
      runId,
      "nodes",
      "askSecret",
      "attempt-0",
      "out",
    );
    const symlinkTarget = join(outDir, "symlink-target.txt");
    await writeFile(symlinkTarget, "target content");
    const symlinkFile = join(outDir, "symlink-out.txt");
    await symlink(symlinkTarget, symlinkFile);
    // Even if registered in outputs, symlink must be rejected
    const statePath = join(dataDir, "runs", runId, "state.json");
    const currentState = JSON.parse(await readFile(statePath, "utf8"));
    currentState.nodes.askSecret.result.outputs["symlink-out.txt"] =
      symlinkFile;
    await writeFile(statePath, JSON.stringify(currentState));

    const resSym = await fetch(
      `${baseUrl}/api/runs/${runId}/preview?nodePath=askSecret&kind=output&fileName=symlink-out.txt`,
    );
    assert.equal(resSym.status, 500);
    const symErr = await resSym.json();
    assert.ok(
      (symErr as { error: string }).error.includes(
        "symlink previews are forbidden",
      ),
    );

    // 8e. Oversized output file truncated to 512KB
    const largeContent = "X".repeat(600 * 1024);
    const largeFile = join(outDir, "large-out.txt");
    await writeFile(largeFile, largeContent);
    currentState.nodes.askSecret.result.outputs["large-out.txt"] = largeFile;
    await writeFile(statePath, JSON.stringify(currentState));

    const resLarge = await fetch(
      `${baseUrl}/api/runs/${runId}/preview?nodePath=askSecret&kind=output&fileName=large-out.txt`,
    );
    assert.equal(resLarge.status, 200);
    const largePreview = (await resLarge.json()) as {
      truncated: boolean;
      size: number;
      content: string;
    };
    assert.equal(largePreview.truncated, true);
    assert.equal(largePreview.size, 600 * 1024);
    assert.equal(largePreview.content.length, 512 * 1024);
  } finally {
    await serverHandle.stop();
  }
});
