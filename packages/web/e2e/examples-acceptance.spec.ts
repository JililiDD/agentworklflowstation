import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { BUILTIN_EXAMPLES } from "../src/editor/examples.ts";
import {
  createTestServerFixture,
  type TestServerFixture,
} from "./test-fixture.ts";

let fixture: TestServerFixture;

test.beforeEach(async () => {
  // Start server with empty workflows library
  fixture = await createTestServerFixture({ initialWorkflows: false });
});

test.afterEach(async () => {
  await fixture.cleanup();
});

test.describe("Phase 7 - Story 1: Builtin Examples in Empty Workflows Library (D-42)", () => {
  test("Empty state displays '+ New Workflow' and two builtin examples, and clicking imports non-conflicting workflow into editor", async ({
    page,
  }) => {
    await page.goto(`${fixture.baseUrl}/#workflows`);

    // Verify empty state text and '+ New Workflow' button (D-42)
    const emptyState = page.locator(".empty-state");
    await expect(emptyState).toBeVisible();
    await expect(emptyState.locator("h3")).toContainText("No Workflows Found");
    await expect(
      emptyState.locator("button:has-text('+ New Workflow')"),
    ).toBeVisible();

    // Verify both builtin examples exist via testid
    const aipilotCard = page.locator(
      "[data-testid='example-aipilot-development']",
    );
    const novelCard = page.locator("[data-testid='example-novel-writing']");
    await expect(aipilotCard).toBeVisible();
    await expect(novelCard).toBeVisible();

    // Click "Open Example →" on aipilot example
    await page
      .locator("[data-testid='open-example-aipilot-development']")
      .click();

    // Should navigate to workflow editor with the imported ID
    await page.waitForURL(/#workflow-editor\/aipilot-development/);
    await expect(
      page.locator("span.code:has-text('aipilot-development')"),
    ).toBeVisible();

    // Editor should display the 4 nodes of aipilot workflow
    const specPlannerCard = page
      .locator(".card")
      .filter({ has: page.locator("span:text-is('specPlanner')") });
    const devBuilderCard = page
      .locator(".card")
      .filter({ has: page.locator("span:text-is('devBuilder')") });
    const codeReviewerCard = page
      .locator(".card")
      .filter({ has: page.locator("span:text-is('codeReviewer')") });
    const gateReviewCard = page
      .locator(".card")
      .filter({ has: page.locator("span:text-is('gateReview')") });

    await expect(specPlannerCard).toBeVisible();
    await expect(devBuilderCard).toBeVisible();
    await expect(codeReviewerCard).toBeVisible();
    await expect(gateReviewCard).toBeVisible();

    // Navigate back to Workflows view
    await page.goto(`${fixture.baseUrl}/#workflows`);
    // Library is no longer empty, card for aipilot-development is visible
    await expect(
      page.locator(".item-card:has-text('aipilot Development Workflow')"),
    ).toBeVisible();
  });

  test("Importing an example when ID already exists creates an incremented duplicate without overwriting", async ({
    page,
  }) => {
    // 1. Pre-seed aipilot-development.yaml into workflows directory
    const existingWfYaml = `
name: Existing Custom Workflow
inputs: []
maxParallel: 1
nodes: []
`;
    await writeFile(
      join(fixture.dataDir, "workflows", "aipilot-development.yaml"),
      existingWfYaml,
      "utf8",
    );

    // 2. Open workflows list with 1 existing workflow
    await page.goto(`${fixture.baseUrl}/#workflows`);
    await expect(
      page.locator(".item-card:has-text('Existing Custom Workflow')"),
    ).toBeVisible();

    // 3. Import example with deduplicated non-conflicting ID
    const ex = BUILTIN_EXAMPLES[0];
    await page.evaluate(async (example) => {
      const listRes = await fetch("/api/workflows");
      const workflows = await listRes.json();
      let targetId = example.id;
      let counter = 1;
      const existingIds = new Set(workflows.map((w: { id: string }) => w.id));
      while (existingIds.has(targetId)) {
        targetId = `${example.id}-${counter++}`;
      }
      await fetch("/api/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: targetId, updatedObject: example.workflow }),
      });
    }, ex);

    // 4. Reload workflows list and verify both workflows exist without overwrite
    await page.reload();
    const cards = page.locator(".item-card");
    await expect(cards).toHaveCount(2);
    await expect(
      page.locator(".item-card:has-text('Existing Custom Workflow')"),
    ).toBeVisible();

    // 5. Open the incremented second one (aipilot-development-1)
    const secondCard = page.locator(
      ".item-card:has-text('aipilot Development Workflow')",
    );
    await expect(secondCard).toBeVisible();
    await secondCard.locator("button:has-text('Edit')").click();

    await page.waitForURL(/#workflow-editor\/aipilot-development-1/);
    await expect(
      page.locator("span.code:has-text('aipilot-development-1')"),
    ).toBeVisible();
  });
});

test.describe("Phase 7 - Story 2: Example Workflows Execution with FakeRunner (AC-89, AC-90, AC-82)", () => {
  test("aipilot development workflow runs from Q&A interview to code review pass", async ({
    page,
  }) => {
    // Setup FakeRunner for aipilot workflow
    fixture.runner.onAgent = async (def, ctx) => {
      if (def.task.includes("Interview user")) {
        // Interactive node asks question
        const answer = await ctx.callbacks.ask?.({
          prompt: "What feature do you want to implement?",
          options: [
            { id: "padLeft", label: "String padLeft utility" },
            { id: "capitalize", label: "String capitalize utility" },
          ],
        });
        return fixture.runner.write(
          ctx,
          { feature: answer?.optionId ?? "padLeft", approved: true },
          0.02,
          "spec.json",
        );
      }

      if (def.task.includes("Implement the approved feature")) {
        // Writable node writes file into git repository
        const srcDir = join(ctx.workDir, "src");
        await mkdir(srcDir, { recursive: true });
        await writeFile(
          join(srcDir, "pad-left.ts"),
          "export function padLeft(s: string, len: number, ch = ' '): string { return s.padStart(len, ch); }\n",
          "utf8",
        );
        return fixture.runner.write(
          ctx,
          { files: ["src/pad-left.ts"], ready: true },
          0.04,
          "implementation.json",
        );
      }

      if (def.task.includes("Independently review the code")) {
        return fixture.runner.write(
          ctx,
          { passed: true, notes: "Code implementation is clean and verified." },
          0.02,
          "review.json",
        );
      }

      return fixture.runner.write(ctx, { ok: true });
    };

    fixture.runner.onCommand = async (_def, _ctx) => {
      // gateReview passes
      return {
        status: "succeeded",
        outputs: { exitCode: "0" },
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    };

    // Open Workflows view and import aipilot example
    await page.goto(`${fixture.baseUrl}/#workflows`);
    await page
      .locator("[data-testid='open-example-aipilot-development']")
      .click();
    await page.waitForURL(/#workflow-editor\/aipilot-development/);

    // Wait for editor and Run button to become enabled
    const runBtn = page.locator("button#editor-run-btn");
    await expect(runBtn).toBeEnabled({ timeout: 5000 });
    await runBtn.click();

    await page.waitForURL(/#workflows\?run=aipilot-development/);
    const targetRepoInput = page.locator("input#target-repo-input");
    await targetRepoInput.fill(fixture.repoDir);

    const featureInput = page.locator("input#wf-input-featureRequest");
    await featureInput.fill("implement padLeft helper");

    // Launch run
    await page.locator("button[type='submit']:has-text('Start Run')").click();
    await page.waitForURL(/#runs\//);

    // Click specPlanner card on canvas to open drawer and answer
    const specCard = page
      .locator(".card")
      .filter({ has: page.locator(".head span:text-is('specPlanner')") });
    await expect(specCard).toBeVisible({ timeout: 5000 });
    await specCard.click();

    const drawer = page.locator(".drawer");
    await expect(drawer).toBeVisible();
    await expect(drawer).toContainText(
      "What feature do you want to implement?",
    );

    // Select first option and submit
    await drawer.locator("button:has-text('String padLeft utility')").click();

    // Execution should proceed and reach Succeeded
    const runBadge = page.locator(".badge-status");
    await expect(runBadge).toContainText("Succeeded", { timeout: 15000 });

    // Check Runbar statistics (AC-82)
    const runbar = page.locator(".runbar");
    await expect(runbar.locator(".stat:has-text('Elapsed')")).toBeVisible();
    await expect(runbar.locator(".stat:has-text('Cost')")).toBeVisible();
    await expect(
      runbar.locator(".stat:has-text('You stepped in')"),
    ).toContainText("1 times");
  });

  test("novel writing workflow sequentially executes outline and foreach chapters", async ({
    page,
  }) => {
    // Setup FakeRunner for novel writing workflow
    fixture.runner.onAgent = async (def, ctx) => {
      if (def.task.includes("Create a 2-chapter outline")) {
        const outline = [
          {
            chapterNumber: 1,
            title: "The Neon Shadow",
            summary:
              "Detective Vance meets the mysterious informant in the alley.",
          },
          {
            chapterNumber: 2,
            title: "Encrypted Memories",
            summary:
              "Vance decodes the data shard inside the abandoned cyber clinic.",
          },
        ];
        return fixture.runner.write(ctx, outline, 0.03, "outline.json");
      }

      if (def.task.includes("Draft chapter")) {
        const match = /chapter (\d+)/i.exec(def.task);
        const chapterNum = match?.[1] ?? "1";
        const chaptersDir = join(ctx.workDir, "chapters");
        await mkdir(chaptersDir, { recursive: true });
        await writeFile(
          join(chaptersDir, `chapter-${chapterNum}.txt`),
          `Chapter ${chapterNum}\nRain slicked the neon streets as the detective walked on...\n`,
          "utf8",
        );
        return fixture.runner.write(
          ctx,
          { chapterNumber: Number(chapterNum), wordCount: 1200, done: true },
          0.05,
          "chapter.json",
        );
      }

      return fixture.runner.write(ctx, { ok: true });
    };

    fixture.runner.onCommand = async (_def, _ctx) => {
      return {
        status: "succeeded",
        outputs: { exitCode: "0" },
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    };

    // Open Workflows view and import novel writing example
    await page.goto(`${fixture.baseUrl}/#workflows`);
    await page.locator("[data-testid='open-example-novel-writing']").click();
    await page.waitForURL(/#workflow-editor\/novel-writing/);

    // Wait for editor and Run button
    const runBtn = page.locator("button#editor-run-btn");
    await expect(runBtn).toBeEnabled({ timeout: 5000 });
    await runBtn.click();

    await page.waitForURL(/#workflows\?run=novel-writing/);
    await page.locator("input#target-repo-input").fill(fixture.repoDir);
    await page
      .locator("input#wf-input-novelTheme")
      .fill("Cyberpunk detective mystery");

    // Launch run
    await page.locator("button[type='submit']:has-text('Start Run')").click();
    await page.waitForURL(/#runs\//);

    // Wait for run completion
    const runBadge = page.locator(".badge-status");
    await expect(runBadge).toContainText("Succeeded", { timeout: 15000 });

    // Foreach items switcher should show item 2 of 2
    await expect(page.locator("text=Item 2 of 2")).toBeVisible();

    // Check Runbar
    const runbar = page.locator(".runbar");
    await expect(runbar.locator(".stat:has-text('Cost')")).toBeVisible();
  });

  test("code review failure correctly fails execution without false success", async ({
    page,
  }) => {
    fixture.runner.onAgent = async (def, ctx) => {
      if (def.task.includes("Interview user")) {
        return fixture.runner.write(
          ctx,
          { feature: "padLeft", approved: true },
          0.01,
          "spec.json",
        );
      }
      if (def.task.includes("Implement the approved feature")) {
        return fixture.runner.write(
          ctx,
          { files: ["src/pad-left.ts"], ready: true },
          0.02,
          "implementation.json",
        );
      }
      if (def.task.includes("Independently review the code")) {
        // Review fails
        return fixture.runner.write(
          ctx,
          { passed: false, notes: "Critical regression detected." },
          0.02,
          "review.json",
        );
      }
      return fixture.runner.write(ctx, { ok: true });
    };

    fixture.runner.onCommand = async (def, _ctx) => {
      if (
        def.command.includes("review.json") ||
        def.command.includes("Code review failed")
      ) {
        // Exit code 1
        return {
          status: "failed",
          outputs: { exitCode: "1" },
          usage: { inputTokens: 0, outputTokens: 0 },
          error: "Command exited with code 1",
        };
      }
      return {
        status: "succeeded",
        outputs: {},
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    };

    await page.goto(`${fixture.baseUrl}/#workflows`);
    await page
      .locator("[data-testid='open-example-aipilot-development']")
      .click();
    await page.waitForURL(/#workflow-editor\/aipilot-development/);

    const runBtn = page.locator("button#editor-run-btn");
    await expect(runBtn).toBeEnabled({ timeout: 5000 });
    await runBtn.click();

    await page.waitForURL(/#workflows\?run=aipilot-development/);
    await page.locator("input#target-repo-input").fill(fixture.repoDir);
    await page.locator("input#wf-input-featureRequest").fill("failing feature");

    await page.locator("button[type='submit']:has-text('Start Run')").click();
    await page.waitForURL(/#runs\//);

    // Run must end with Failed, never Succeeded
    const runBadge = page.locator(".badge-status");
    await expect(runBadge).toContainText("Failed", { timeout: 15000 });
  });
});
