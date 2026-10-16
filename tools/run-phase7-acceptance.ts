import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DurableRunState } from "@aipilotagent/engine";
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

const DEV_REPO = "/mnt/storage/Projects/aipilot-acceptance-dev";
const NOVEL_REPO = "/mnt/storage/Projects/aipilot-acceptance-novel";
const DATA_DIR = "/tmp/aipilot-phase7-acceptance-data";

async function pollRunState(
  baseUrl: string,
  runId: string,
  onQuestion?: (path: string, q: unknown) => Promise<void>,
  timeoutMs = 180000,
): Promise<DurableRunState> {
  const start = Date.now();
  const answered = new Set<string>();

  while (Date.now() - start < timeoutMs) {
    let state: DurableRunState | undefined;
    try {
      const res = await fetch(
        `${baseUrl}/api/runs/${encodeURIComponent(runId)}`,
      );
      if (!res.ok) {
        console.warn(`getRun responded with status ${res.status}`);
      } else {
        state = await res.json();
      }
    } catch (err) {
      console.warn("fetch run failed (transient):", err);
    }

    // Check inbox for pending questions
    if (onQuestion) {
      try {
        const inbRes = await fetch(`${baseUrl}/api/inbox`);
        if (inbRes.ok) {
          const inbox = await inbRes.json();
          for (const q of inbox.questions) {
            if (q.runId === runId && !answered.has(q.nodePath)) {
              answered.add(q.nodePath);
              await onQuestion(q.nodePath, q.question);
            }
          }
        }
      } catch (err) {
        console.warn("fetch inbox failed (transient):", err);
      }
    }

    if (
      state &&
      (state.status === "succeeded" ||
        state.status === "failed" ||
        state.status === "aborted" ||
        state.status === "budget_exceeded")
    ) {
      return state;
    }

    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Run ${runId} timed out after ${timeoutMs}ms`);
}

async function runDevWorkflow(
  baseUrl: string,
): Promise<{ runId: string; finalState: DurableRunState }> {
  console.log("\n========================================================");
  console.log("Starting Phase 7 - aipilot Development Workflow Acceptance");
  console.log("Target Repo:", DEV_REPO);
  console.log("========================================================");

  const wfYaml = `
name: aipilot Development Real Acceptance
inputs:
  - featureRequest
maxParallel: 1
nodes:
  - id: specPlanner
    kind: agent
    definition:
      model: codexJ/gpt-6-luna
      thinkingLevel: low
      interactive: true
      task: "Interview user on requirement '\${inputs.featureRequest}'. Ask one question about function signature, then generate specification JSON and write it to \${outputs.spec.json} with feature name, details, and approved: true."
      outputs:
        - spec.json
    schemas:
      spec.json:
        type: object
        properties:
          feature:
            type: string
          approved:
            type: boolean
        required:
          - feature
          - approved
  - id: devBuilder
    kind: agent
    dependsOn:
      - specPlanner
    writable: true
    definition:
      model: codexJ/gpt-6-luna
      thinkingLevel: low
      task: 'Implement the approved feature "\${nodes.specPlanner.spec.json#/feature}" in the git repository. Use the write tool to write file src/pad-left.ts with an exported padLeft function and type definitions. Then use the write tool to write \${outputs.implementation.json} with { "files": ["src/pad-left.ts"], "ready": true }.'
      outputs:
        - implementation.json
    schemas:
      implementation.json:
        type: object
        properties:
          files:
            type: array
            items:
              type: string
          ready:
            type: boolean
        required:
          - files
          - ready
  - id: codeReviewer
    kind: agent
    dependsOn:
      - devBuilder
    writable: false
    definition:
      model: codexJ/gpt-6-luna
      thinkingLevel: low
      task: "Independently review the code changes made in '\${nodes.devBuilder.implementation.json#/files/0}'. Output review result to \${outputs.review.json} with passed (boolean) and notes (string)."
      outputs:
        - review.json
    schemas:
      review.json:
        type: object
        properties:
          passed:
            type: boolean
          notes:
            type: string
        required:
          - passed
  - id: gateReview
    kind: command
    dependsOn:
      - codeReviewer
    writable: false
    definition:
      kind: command
      command: "node -e 'const fs=require(\\"fs\\"); const r=JSON.parse(fs.readFileSync(process.argv[1], \\"utf8\\")); if (!r.passed) { console.error(\\"Review failed:\\", r.notes); process.exit(1); } console.log(\\"Code review verified passed.\\");' '\${nodes.codeReviewer.review.json}'"
      allowNonZeroExit: false
`;

  // 1. Save workflow
  const saveRes = await fetch(`${baseUrl}/api/workflows`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "dev-acceptance", yaml: wfYaml }),
  });
  assert.equal(saveRes.status, 201);

  // 2. Preflight validate
  const valRes = await fetch(`${baseUrl}/api/runs/validate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workflowId: "dev-acceptance",
      targetRepo: DEV_REPO,
      inputs: { featureRequest: "implement string padLeft utility" },
    }),
  });
  const val = await valRes.json();
  console.log("Preflight validation result:", val);
  assert.equal(val.valid, true);

  // 3. Start run
  const startRes = await fetch(`${baseUrl}/api/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workflowId: "dev-acceptance",
      targetRepo: DEV_REPO,
      inputs: { featureRequest: "implement string padLeft utility" },
    }),
  });
  assert.equal(startRes.status, 201);
  const { runId } = await startRes.json();
  console.log("Run started with ID:", runId);

  // 4. Poll and answer questions via API
  const finalState = await pollRunState(
    baseUrl,
    runId,
    async (nodePath, question) => {
      console.log(`[Interaction] Node ${nodePath} asked question:`, question);
      const answerBody = {
        text: "Please implement `padLeft(str: string, len: number, char?: string): string`. Export it as default and named export.",
      };
      console.log(`[Interaction] Sending preset answer to ${nodePath}...`);
      const ansRes = await fetch(
        `${baseUrl}/api/runs/${encodeURIComponent(runId)}/questions/${encodeURIComponent(nodePath)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(answerBody),
        },
      );
      assert.equal(ansRes.status, 200);
      console.log("[Interaction] Preset answer submitted successfully.");
    },
    240000,
  );

  console.log("Final State of Dev Run:", finalState.status);
  return { runId, finalState };
}

async function runNovelWorkflow(
  baseUrl: string,
): Promise<{ runId: string; finalState: DurableRunState }> {
  console.log("\n========================================================");
  console.log("Starting Phase 7 - Novel Writing Workflow Acceptance");
  console.log("Target Repo:", NOVEL_REPO);
  console.log("========================================================");

  const wfYaml = `
name: Novel Writing Real Acceptance
inputs:
  - novelTheme
maxParallel: 1
nodes:
  - id: outlinePlanner
    kind: agent
    definition:
      model: codexJ/gpt-6-luna
      thinkingLevel: low
      task: "Create a structured 2-chapter outline based on '\${inputs.novelTheme}'. Generate 2 chapters as a JSON array and write it to \${outputs.outline.json}, each item with chapterNumber (1, 2), title (string), and summary (string)."
      outputs:
        - outline.json
    schemas:
      outline.json:
        type: array
        items:
          type: object
          properties:
            chapterNumber:
              type: number
            title:
              type: string
            summary:
              type: string
          required:
            - chapterNumber
            - title
            - summary
  - id: chaptersForeach
    kind: foreach
    dependsOn:
      - outlinePlanner
    source: "\${nodes.outlinePlanner.outline.json}"
    nodes:
      - id: writeChapter
        kind: agent
        writable: true
        definition:
          model: codexJ/gpt-6-luna
          thinkingLevel: low
          task: 'Draft Chapter \${item.chapterNumber}: "\${item.title}" based on summary "\${item.summary}". Use the write tool to write narrative story text to chapters/chapter-\${item.chapterNumber}.txt in the target repository. Then use the write tool to write \${outputs.chapter.json} with { "chapterNumber": \${item.chapterNumber}, "wordCount": 150 }.'
          outputs:
            - chapter.json
        schemas:
          chapter.json:
            type: object
            properties:
              chapterNumber:
                type: number
              wordCount:
                type: number
            required:
              - chapterNumber
      - id: verifyChapter
        kind: command
        dependsOn:
          - writeChapter
        writable: false
        definition:
          kind: command
          command: "node -e 'const fs=require(\\"fs\\"); const c=process.argv[1]; const p=\\"chapters/chapter-\\" + c + \\".txt\\"; if (!fs.existsSync(p) || fs.statSync(p).size === 0) { console.error(\\"Missing chapter:\\", p); process.exit(1); } console.log(\\"Verified chapter file:\\", p);' '\${item.chapterNumber}'"
          allowNonZeroExit: false
`;

  // 1. Save workflow
  const saveRes = await fetch(`${baseUrl}/api/workflows`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "novel-acceptance", yaml: wfYaml }),
  });
  assert.equal(saveRes.status, 201);

  // 2. Preflight validate
  const valRes = await fetch(`${baseUrl}/api/runs/validate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workflowId: "novel-acceptance",
      targetRepo: NOVEL_REPO,
      inputs: {
        novelTheme:
          "Rainy cyberpunk detective investigating an illegal memory shard",
      },
    }),
  });
  const val = await valRes.json();
  console.log("Preflight validation result:", val);
  assert.equal(val.valid, true);

  // 3. Start run
  const startRes = await fetch(`${baseUrl}/api/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workflowId: "novel-acceptance",
      targetRepo: NOVEL_REPO,
      inputs: {
        novelTheme:
          "Rainy cyberpunk detective investigating an illegal memory shard",
      },
    }),
  });
  assert.equal(startRes.status, 201);
  const { runId } = await startRes.json();
  console.log("Novel Run started with ID:", runId);

  // 4. Poll to completion
  const finalState = await pollRunState(baseUrl, runId, undefined, 240000);
  console.log("Final State of Novel Run:", finalState.status);
  return { runId, finalState };
}

async function main(): Promise<void> {
  const authPath = getDefaultAuthPath();
  const sessionAdapter = createPiSessionAdapter({ authPath });
  const runner = createAgentRunner(sessionAdapter);
  const runManager = new RunManager({
    dataDir: DATA_DIR,
    runner,
  });
  const authManager = new AuthManager({ authPath });

  const server = createPlatformHttpServer({
    dataDir: DATA_DIR,
    authPath,
    runManager,
    authManager,
    port: 0,
  });

  const port = await server.start();
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`Phase 7 Acceptance Server listening at ${baseUrl}`);

  try {
    const devOutcome = await runDevWorkflow(baseUrl);
    const novelOutcome = await runNovelWorkflow(baseUrl);

    console.log("\n========================================================");
    console.log("Phase 7 Real Model Acceptance Summary");
    console.log("========================================================");
    console.log(
      "Dev Run ID:",
      devOutcome.runId,
      "Status:",
      devOutcome.finalState.status,
    );
    console.log(
      "Novel Run ID:",
      novelOutcome.runId,
      "Status:",
      novelOutcome.finalState.status,
    );

    assert.equal(devOutcome.finalState.status, "succeeded");
    assert.equal(novelOutcome.finalState.status, "succeeded");

    // Collect evidence details
    const devInteractionsRes = await fetch(
      `${baseUrl}/api/runs/${encodeURIComponent(devOutcome.runId)}/interactions`,
    );
    const devInteractions = await devInteractionsRes.json();

    const devReviewJson = await readFile(
      devOutcome.finalState.nodes.codeReviewer.result.outputs["review.json"],
      "utf8",
    );
    const devSpecJson = await readFile(
      devOutcome.finalState.nodes.specPlanner.result.outputs["spec.json"],
      "utf8",
    );
    const devDiffPatch = await readFile(
      devOutcome.finalState.nodes.devBuilder.result.outputs["diff.patch"],
      "utf8",
    );

    const novelOutline = await readFile(
      novelOutcome.finalState.nodes.outlinePlanner.result.outputs[
        "outline.json"
      ],
      "utf8",
    );
    const chapter1 = await readFile(
      join(NOVEL_REPO, "chapters", "chapter-1.txt"),
      "utf8",
    ).catch(() =>
      readFile(
        join(novelOutcome.finalState.worktreeDir, "chapters", "chapter-1.txt"),
        "utf8",
      ),
    );
    const chapter2 = await readFile(
      join(NOVEL_REPO, "chapters", "chapter-2.txt"),
      "utf8",
    ).catch(() =>
      readFile(
        join(novelOutcome.finalState.worktreeDir, "chapters", "chapter-2.txt"),
        "utf8",
      ),
    );

    const evidence = {
      timestamp: new Date().toISOString(),
      modelsUsed: ["codexJ/gpt-6-luna"],
      devWorkflow: {
        runId: devOutcome.runId,
        targetRepo: DEV_REPO,
        headCommit: devOutcome.finalState.headCommit,
        lastCheckpointCommit: devOutcome.finalState.lastCheckpointCommit,
        status: devOutcome.finalState.status,
        totalUsage: devOutcome.finalState.totalUsage,
        interactionsCount: devInteractions.length,
        interactions: devInteractions,
        spec: JSON.parse(devSpecJson),
        codeReview: JSON.parse(devReviewJson),
        diffPatchSummary: devDiffPatch.slice(0, 500),
      },
      novelWorkflow: {
        runId: novelOutcome.runId,
        targetRepo: NOVEL_REPO,
        headCommit: novelOutcome.finalState.headCommit,
        lastCheckpointCommit: novelOutcome.finalState.lastCheckpointCommit,
        status: novelOutcome.finalState.status,
        totalUsage: novelOutcome.finalState.totalUsage,
        outline: JSON.parse(novelOutline),
        chapter1Summary: {
          path: "chapters/chapter-1.txt",
          length: chapter1.length,
          preview: chapter1.slice(0, 200),
        },
        chapter2Summary: {
          path: "chapters/chapter-2.txt",
          length: chapter2.length,
          preview: chapter2.slice(0, 200),
        },
      },
    };

    const evidencePath = join(
      process.cwd(),
      "docs/aipilot/acceptance-evidence-phase7.json",
    );
    const { writeFile: writeEvidenceFile } = await import("node:fs/promises");
    await writeEvidenceFile(
      evidencePath,
      `${JSON.stringify(evidence, null, 2)}\n`,
      "utf8",
    );
    console.log(`Saved comprehensive evidence to ${evidencePath}`);

    console.log(
      "\nAll Phase 7 Acceptance Criteria (AC-89, AC-90, AC-82) Verified!",
    );
  } catch (err) {
    console.error("Error during acceptance run:", err);
    throw err;
  } finally {
    await server.stop();
    try {
      await runner.dispose();
    } catch (e) {
      console.warn("Runner dispose warning (ignored on exit):", e);
    }
  }
}

main().catch((err) => {
  console.error("Phase 7 Acceptance failed:", err);
  process.exit(1);
});
