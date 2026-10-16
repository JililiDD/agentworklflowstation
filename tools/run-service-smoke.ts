import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentRunner,
  createPiSessionAdapter,
} from "@aipilotagent/runner";
import {
  AuthManager,
  createPlatformHttpServer,
  getDefaultAuthPath,
  RunManager,
} from "@aipilotagent/service";

function initGitRepo(dir: string): void {
  execFileSync("git", ["init", dir]);
  execFileSync("git", ["-C", dir, "config", "user.name", "Smoke User"]);
  execFileSync("git", ["-C", dir, "config", "user.email", "smoke@example.com"]);
  execFileSync("git", [
    "-C",
    dir,
    "commit",
    "--allow-empty",
    "-m",
    "initial commit",
  ]);
}

async function main(): Promise<void> {
  const isReal =
    process.argv.includes("--real") || process.argv.includes("--luna");
  const model = isReal ? "codexJ/gpt-6-luna" : "fake/small";
  const authPath = getDefaultAuthPath();

  console.log(
    `Starting service smoke test (${isReal ? `REAL model: ${model}` : "demo"})...`,
  );

  const tempDir = await mkdtemp(join(tmpdir(), "aipilot-service-smoke-"));
  const repoDir = join(tempDir, "target-repo");
  const dataDir = join(tempDir, "data");
  await mkdir(repoDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  initGitRepo(repoDir);

  const sessionAdapter = createPiSessionAdapter({ authPath });
  const runner = createAgentRunner(sessionAdapter);
  const runManager = new RunManager({
    dataDir,
    runner,
  });
  const authManager = new AuthManager({ authPath });

  const server = createPlatformHttpServer({
    dataDir,
    authPath,
    runManager,
    authManager,
    port: 0,
  });

  const port = await server.start();
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`HTTP server listening at ${baseUrl}`);

  try {
    // 1. Check health
    const resHealth = await fetch(`${baseUrl}/api/health`);
    assert.equal(resHealth.status, 200);

    // 2. Check auth providers (non-sensitive)
    const resAuth = await fetch(`${baseUrl}/api/auth/providers`);
    assert.equal(resAuth.status, 200);
    const providers = (await resAuth.json()) as Array<{
      providerId: string;
      type: string;
    }>;
    console.log(
      `Available configured providers: ${providers.map((p) => p.providerId).join(", ")}`,
    );

    // 3. Define and save workflow
    const wfYaml = `
name: Smoke Service Workflow
inputs:
  - projectName
maxParallel: 1
nodes:
  - id: smokeWriter
    kind: agent
    writable: true
    definition:
      model: ${model}
      thinkingLevel: ${model.includes("luna") ? "low" : "off"}
      task: "Create a markdown file named smoke.md in the project directory with header # Smoke Test: \${inputs.projectName}. Write status to \${outputs.result.json} with an ok boolean."
      outputs:
        - result.json
    schemas:
      result.json:
        type: object
        properties:
          ok:
            type: boolean
        required:
          - ok
`;

    const resSave = await fetch(`${baseUrl}/api/workflows`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "smoke-flow", yaml: wfYaml }),
    });
    assert.equal(resSave.status, 201);
    console.log("Workflow saved successfully.");

    // 4. Start run via HTTP API
    const resStart = await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workflowId: "smoke-flow",
        targetRepo: repoDir,
        inputs: { projectName: "aiworflowstation" },
      }),
    });
    assert.equal(resStart.status, 201);
    const { runId } = (await resStart.json()) as { runId: string };
    console.log(`Run started with ID: ${runId}`);

    // 5. Poll run until completed
    let finalStatus = "pending";
    for (let i = 0; i < 60; i++) {
      const resRun = await fetch(`${baseUrl}/api/runs/${runId}`);
      const run = (await resRun.json()) as { status: string };
      finalStatus = run.status;
      if (
        finalStatus === "succeeded" ||
        finalStatus === "failed" ||
        finalStatus === "aborted" ||
        finalStatus === "budget_exceeded"
      ) {
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }

    console.log(`Run completed with status: ${finalStatus}`);
    if (finalStatus !== "succeeded") {
      const resRun = await fetch(`${baseUrl}/api/runs/${runId}`);
      const runData = await resRun.json();
      console.error("Run failure details:", JSON.stringify(runData, null, 2));
    }
    assert.equal(finalStatus, "succeeded");

    // 6. Inspect events
    const resEvents = await fetch(`${baseUrl}/api/runs/${runId}/events`);
    const events = (await resEvents.json()) as Array<Record<string, unknown>>;
    console.log(`Recorded ${events.length} run events.`);

    console.log("Smoke test PASSED successfully!");
  } finally {
    await server.stop();
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("Smoke test failed:", err);
  process.exit(1);
});
