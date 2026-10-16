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

test.describe("Workflow Editor - Story 4: End-to-end Lifecycle (Build -> Save -> Launch Run -> Complete)", () => {
  test("Can build workflow in editor, save, launch from run view, and complete execution with FakeRunner", async ({
    page,
  }) => {
    page.on("console", (msg) => console.log("BROWSER:", msg.text()));
    page.on("pageerror", (err) => console.log("PAGE ERROR:", err));
    // 1. Open new workflow editor
    await page.goto(`${fixture.baseUrl}#workflow-editor/new`);
    await page
      .locator('input[placeholder="workflow_id"]')
      .fill("e2e_launch_flow");

    // 2. Add an Agent node
    await page.click('button:has-text("🤖 + Agent")');
    const agentCard = page.locator(".card-agent:has-text('agent1')");
    await expect(agentCard).toBeVisible();

    // 3. Configure Agent node in Drawer
    await agentCard.click();
    const drawer = page.locator("aside.drawer");
    await drawer
      .locator("select#drawer-agent-model")
      .selectOption("fake/small");
    await drawer.locator('button:has-text("prompt")').click();
    await drawer
      .locator("textarea#drawer-agent-task")
      // biome-ignore lint/suspicious/noTemplateCurlyInString: test syntax
      .fill("Execute e2e step for ${inputs.topic}");
    await drawer.locator('button:has-text("behavior")').click();
    await drawer.locator("text=Writable").click();
    await drawer.locator('button:has-text("outputs")').click();
    await drawer.locator("input#drawer-agent-outputs").fill("result.json");

    // 4. Configure Workflow inputs
    await drawer.locator('button:has-text("✕")').click(); // close node drawer to show workflow global settings
    const wfInputs = drawer.locator("input#drawer-wf-inputs");
    await expect(wfInputs).toBeVisible();
    await wfInputs.fill("topic");

    // 5. Save workflow
    await page.click('button:has-text("Save")');
    await expect(page.locator("text=✓ Saved")).toBeVisible();

    // 6. Click Run button (transfers to Workflows launch view)
    const runBtn = page.getByRole("button", { name: "Run", exact: true });
    await expect(runBtn).toBeEnabled();
    await runBtn.click();

    // 7. Verify launch form is pre-opened for e2e_launch_flow
    await expect(page).toHaveURL(/#workflows\?run=e2e_launch_flow/);
    const targetRepoInput = page.locator("#target-repo-input");
    await expect(targetRepoInput).toBeVisible();
    await targetRepoInput.fill(fixture.repoDir);

    const topicInput = page.locator("#wf-input-topic");
    await expect(topicInput).toBeVisible();
    await topicInput.fill("Automated Phase 6 Verification");

    // Click Preflight Check first
    await page.click('button:has-text("Preflight Check")');
    await expect(page.locator(".alert-warning, .alert-error")).toBeVisible();

    // 8. Start Run
    await page.click('button:has-text("Start Run")');

    // 9. Verify navigates to Run Detail view and executes to completion
    await page.waitForURL(/#runs\/.+/, { timeout: 10000 });
    await expect(page.locator(".snapshot-badge")).toBeVisible();

    // Verify run status finishes with Succeeded
    await expect(page.locator("header.topbar .badge-status")).toContainText(
      "Succeeded",
      { timeout: 15000 },
    );
  });
});
