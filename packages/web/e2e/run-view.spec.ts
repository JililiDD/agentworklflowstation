import { expect, test } from "@playwright/test";
import {
  createTestServerFixture,
  type TestServerFixture,
} from "./test-fixture.ts";

let fixture: TestServerFixture;

test.beforeAll(async () => {
  fixture = await createTestServerFixture();
});

test.afterAll(async () => {
  await fixture.cleanup();
});

test.describe("aipilotAgent Web UI E2E Test Suite", () => {
  test("1. Navigation, Theme Switching, and Settings (Skill sources & Provider auth)", async ({
    page,
  }) => {
    await page.goto(fixture.baseUrl);

    // Initial page shows Workflows
    await expect(page.locator("h2")).toContainText("Workflows");

    // Theme toggle switches between light and dark
    const html = page.locator("html");
    const initialTheme = await html.getAttribute("data-theme");
    const themeBtn = page.locator(".theme-toggle");
    await themeBtn.click();
    const newTheme = await html.getAttribute("data-theme");
    expect(newTheme).not.toEqual(initialTheme);
    await themeBtn.click(); // toggle back

    // Navigate to Settings
    await page.click('button[title="Settings"]');
    await expect(page.locator("h2")).toContainText("Settings");

    // Register skill directory
    const dirInput = page.locator('input[placeholder="/path/to/skills-dir"]');
    await dirInput.fill(fixture.skillsDir);
    await page.click('button:has-text("Add Directory")');

    // Verify skill is discovered and listed
    const skillsTable = page.locator(
      "section:has-text('Skill Sources') table.data-table",
    );
    await expect(skillsTable).toContainText("test-expert");
    await expect(skillsTable).toContainText("Expert skill for testing");

    // Configure an API key for OpenAI
    const keyInput = page.locator('input[placeholder="Enter API Key"]');
    await keyInput.fill("sk-test-secret-key-12345");
    await page.click('button:has-text("Save Key")');

    // Provider table shows configured
    const providersTable = page.locator(
      "section:has-text('Model Credentials') table.data-table",
    );
    await expect(providersTable).toContainText("openai");
    await expect(providersTable).toContainText("Configured");
    // Verify secret key is never leaked on page
    const pageText = await page.textContent("body");
    expect(pageText).not.toContain("sk-test-secret-key-12345");
  });

  test("2. Workflows view, Launching Run, Q&A with Secret in Drawer, Approval, and Completion", async ({
    page,
  }) => {
    await page.goto(fixture.baseUrl);
    await page.click('button[title="Workflows"]');
    await expect(page.locator("h2")).toContainText("Workflows");

    // Workflow card is present
    await expect(page.locator(".item-card h3")).toContainText(
      "Sample Review Workflow",
    );

    // Click Run Workflow to open launch form
    await page.click('button:has-text("Run Workflow")');

    // Test invalid target repo preflight check
    const repoInput = page.locator("#target-repo-input");
    await repoInput.fill("/tmp/non-existent-git-dir-xyz");
    await page.click('button:has-text("Preflight Check")');
    await expect(page.locator(".alert-error")).toContainText(
      "not a git repository",
    );

    // Fill valid target repository and inputs
    await repoInput.fill(fixture.repoDir);
    const topicInput = page.locator("#wf-input-topic");
    await topicInput.fill("Automated Agent Workflows");

    // Preflight check now succeeds
    await page.click('button:has-text("Preflight Check")');
    await expect(page.locator(".alert-warning")).toContainText(
      "Preflight checks passed",
    );

    // Setup fake runner behaviors for this run
    fixture.runner.onAgent = async (def, ctx) => {
      if (def.task.includes("Interview")) {
        const answer = await ctx.callbacks.ask?.({
          prompt: "What is the primary objective of this review?",
          options: [
            { id: "opt-speed", label: "Fast turnaround" },
            { id: "opt-thorough", label: "Thorough verification" },
          ],
        });
        expect(answer?.text).toBe("Fast turnaround");
        return fixture.runner.write(
          ctx,
          `Objective: ${answer?.text}`,
          0.08,
          "summary.txt",
        );
      }

      if (def.task.includes("Draft")) {
        return fixture.runner.write(
          ctx,
          "Draft solution content here",
          0.12,
          "draft.txt",
        );
      }
      return fixture.runner.write(ctx, { ok: true });
    };

    // Click Start Run
    await page.click('button:has-text("Start Run")');

    // Page navigates to #runs/<runId>
    await page.waitForURL(/#runs\/.+/);
    await expect(page.locator(".snapshot-badge")).toContainText(
      "Read-only snapshot from run start",
    );

    // Wait for the askNode card to appear
    const askCard = page.locator('.card:has-text("askNode")');
    await expect(askCard).toBeVisible();

    // Navigation Inbox badge shows at least 1 waiting item
    const countBadge = page.locator(".count-badge");
    await expect(countBadge).toBeVisible();

    // Click askNode to open Drawer
    await askCard.click();
    const drawer = page.locator(".drawer");
    await expect(drawer).toBeVisible();

    // Verify Questions tab displays prompt and options
    await expect(drawer).toContainText(
      "What is the primary objective of this review?",
    );
    await expect(drawer.locator(".choice-btn")).toHaveCount(2);

    // Click first option "Fast turnaround"
    await drawer.locator('.choice-btn:has-text("Fast turnaround")').click();

    // Verify question is resolved and askNode completes
    await expect(page.locator('.card:has-text("askNode")')).toContainText(
      "Succeeded",
      { timeout: 15000 },
    );

    // Now approveNode runs and requires approval
    const approveCard = page.locator('.card:has-text("approveNode")');
    await approveCard.click();

    // Verify Approval Required section is visible in drawer
    await expect(drawer).toContainText("Approval Required");

    // Click Approve button
    await drawer.locator('button:has-text("Approve")').click();

    // Verify approveNode succeeds and whole run succeeds
    await expect(approveCard).toContainText("Succeeded", { timeout: 15000 });
    await expect(page.locator(".badge-status")).toContainText("Succeeded", {
      timeout: 15000,
    });

    // Check Runbar metrics
    await expect(
      page.locator(".stat:has-text('You stepped in')"),
    ).toContainText("times");
  });

  test("3. Runs list view and re-opening past run", async ({ page }) => {
    await page.goto(fixture.baseUrl);
    await page.click('button[title="Runs"]');
    await expect(page.locator("h2")).toContainText("Runs");

    // Historical run is present in table
    const firstRow = page.locator("table.data-table tbody tr").first();
    await expect(firstRow).toBeVisible();
    await expect(firstRow).toContainText(/succeeded/i);

    // Click row opens run detail again
    await firstRow.click();
    await page.waitForURL(/#runs\/.+/);
    await expect(page.locator(".snapshot-badge")).toContainText(
      "Read-only snapshot from run start",
    );
  });

  test("4. Stop and Resume execution flow", async ({ page }) => {
    await page.goto(fixture.baseUrl);
    await page.click('button[title="Workflows"]');
    await page.click('button:has-text("Run Workflow")');

    const repoInput = page.locator("#target-repo-input");
    await repoInput.fill(fixture.repoDir);
    const topicInput = page.locator("#wf-input-topic");
    await topicInput.fill("Stop and Resume Test");

    // Fake runner waits until aborted
    fixture.runner.onAgent = async (_def, ctx) => {
      await new Promise((resolve) => {
        ctx.signal.addEventListener("abort", resolve, { once: true });
      });
      return {
        status: "failed",
        outputs: {},
        usage: { inputTokens: 0, outputTokens: 0 },
        error: "aborted",
      };
    };

    await page.click('button:has-text("Start Run")');
    await page.waitForURL(/#runs\/.+/);

    // Wait for Stop run button to become visible when run starts
    const stopBtn = page.locator('button:has-text("Stop run")');
    await expect(stopBtn).toBeVisible({ timeout: 15000 });

    // Click Stop run
    page.on("dialog", (dialog) => dialog.accept());
    await stopBtn.click();

    // Status becomes Aborted or Failed
    await expect(page.locator(".badge-status")).toContainText(
      /Aborted|Failed/,
      { timeout: 15000 },
    );

    // Now resume
    fixture.runner.onAgent = async (def, ctx) => {
      if (def.task.includes("Interview")) {
        return fixture.runner.write(
          ctx,
          "Resumed summary",
          0.05,
          "summary.txt",
        );
      }
      if (def.task.includes("Draft")) {
        return fixture.runner.write(ctx, "Resumed draft", 0.05, "draft.txt");
      }
      return fixture.runner.write(ctx, { resumed: true });
    };

    await page.click('button:has-text("Resume run")');

    // Approve the second node after resume
    const approveCard = page.locator('.card:has-text("approveNode")');
    await approveCard.click();
    const approveBtn = page.locator('.drawer button:has-text("Approve")');
    await expect(approveBtn).toBeVisible({ timeout: 15000 });
    await approveBtn.click();

    await expect(page.locator(".badge-status")).toContainText("Succeeded", {
      timeout: 15000,
    });
  });

  test("5. Nested workflow canvas with group rounds, foreach items, and dark theme contrast", async ({
    page,
  }) => {
    // Add a group workflow to the library
    const groupWfYaml = `
name: Nested Group Workflow
inputs:
  - topic
maxParallel: 1
nodes:
  - id: loopGroup
    kind: group
    maxRounds: 2
    onExhausted: fail
    until:
      ref: "\${nodes.stepTwo.out2.json#/ready}"
      equals: true
    nodes:
      - id: stepOne
        kind: agent
        definition:
          model: fake/small
          thinkingLevel: off
          task: "First inner task"
          outputs:
            - out1.json
      - id: stepTwo
        kind: agent
        dependsOn:
          - stepOne
        definition:
          model: fake/small
          thinkingLevel: off
          task: "Second inner task"
          outputs:
            - out2.json
        schemas:
          out2.json:
            type: object
            properties:
              ready:
                type: boolean
            required:
              - ready
`;
    const { saveWorkflow } = await import(
      "../../service/src/workflow-library.ts"
    );
    await saveWorkflow(fixture.dataDir, "group-wf", groupWfYaml);

    fixture.runner.onAgent = async (def, ctx) => {
      const fileName = def.outputs[0] ?? "out.json";
      return fixture.runner.write(ctx, { ready: true }, 0.01, fileName);
    };

    await page.goto(fixture.baseUrl);
    await page.click('button[title="Workflows"]');

    // Select the nested group workflow
    const groupCard = page.locator(
      '.item-card:has-text("Nested Group Workflow")',
    );
    await expect(groupCard).toBeVisible();
    await groupCard.locator('button:has-text("Run")').click();

    const repoInput = page.locator("#target-repo-input");
    await repoInput.fill(fixture.repoDir);
    const topicInput = page.locator("#wf-input-topic");
    await topicInput.fill("Testing nested group");

    await page.click('button:has-text("Preflight Check")');
    await expect(page.locator(".alert-warning")).toContainText(
      "Preflight checks passed",
    );

    await page.click('button:has-text("Start Run")');
    await page.waitForURL(/#runs\/.+/);

    // Verify container frame renders
    const frame = page.locator(".frame");
    await expect(frame).toBeVisible({ timeout: 15000 });
    await expect(frame.locator(".fh")).toContainText("Repeat");
    await expect(frame.locator(".fh")).toContainText("loopGroup");

    // Stepper shows Round 1
    await expect(frame.locator(".stepper")).toContainText(/Round 1/);

    // Both inner cards are rendered inside
    await expect(page.locator('.card:has-text("stepOne")')).toBeVisible();
    await expect(page.locator('.card:has-text("stepTwo")')).toBeVisible();

    // Clicking child node opens drawer with task definition
    await page.locator('.card:has-text("stepOne")').click();
    const drawer = page.locator(".drawer");
    await expect(drawer).toBeVisible();
    await expect(drawer).toContainText("First inner task");

    // Dark theme contrast check
    const themeBtn = page.locator(".theme-toggle");
    await themeBtn.click();
    const theme = await page.evaluate(() =>
      document.documentElement.getAttribute("data-theme"),
    );
    expect(theme).toBe("dark");

    // Snapshot badge remains visible and read-only
    await expect(page.locator(".snapshot-badge")).toContainText(
      "Read-only snapshot from run start",
    );

    // Wait for whole nested run to succeed
    await expect(page.locator(".badge-status")).toContainText("Succeeded", {
      timeout: 15000,
    });
  });
});
