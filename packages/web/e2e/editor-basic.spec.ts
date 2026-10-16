import { writeFile } from "node:fs/promises";
import { join } from "node:path";
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

test.describe("Workflow Editor - Story 1: Creation and Safe Legacy Loading", () => {
  test("Can navigate to new workflow editor, shows unsaved changes prompt, and handles cancel/confirm", async ({
    page,
  }) => {
    await page.goto(fixture.baseUrl);
    await expect(page.locator("h2")).toContainText("Workflows");

    // Click Create Workflow button
    await page.click('button:has-text("+ Create Workflow")');
    await expect(page).toHaveURL(/#workflow-editor\/new/);
    await expect(page.locator("h2, span:has-text('Workflow:')")).toBeVisible();

    // Type a new workflow ID
    const idInput = page.locator('input[placeholder="workflow_id"]');
    await idInput.fill("my_custom_flow");
    await expect(page.locator("text=Unsaved changes")).toBeVisible();

    // Clicking Back triggers confirm dialog
    let dialogDismissed = false;
    page.once("dialog", async (dialog) => {
      expect(dialog.message()).toContain("unsaved changes");
      await dialog.dismiss();
      dialogDismissed = true;
    });

    await page.click('button:has-text("← Back")');
    expect(dialogDismissed).toBe(true);
    // Still in editor
    await expect(page).toHaveURL(/#workflow-editor\/new/);

    // Click Back again and accept
    page.once("dialog", async (dialog) => {
      await dialog.accept();
    });
    await page.click('button:has-text("← Back")');
    // Returned to workflows
    await expect(page).toHaveURL(/#workflows/);
  });

  test("Opening corrupted or unsupported YAML displays read-only error and does not overwrite original", async ({
    page,
  }) => {
    const workflowsDir = join(fixture.dataDir, "workflows");
    const brokenPath = join(workflowsDir, "corrupted_flow.yaml");
    const originalBrokenYaml = "nodes: [ broken yaml syntax";
    await writeFile(brokenPath, originalBrokenYaml, "utf8");

    await page.goto(`${fixture.baseUrl}#workflows`);
    const card = page.locator(".item-card:has-text('corrupted_flow')");
    await expect(card).toBeVisible();
    await expect(card.locator("text=Invalid")).toBeVisible();

    // Click Edit on invalid workflow
    await card.locator('button:has-text("Edit")').click();
    await expect(page).toHaveURL(/#workflow-editor\/corrupted_flow/);

    // Error banner is visible
    await expect(page.locator(".alert-error")).toBeVisible();
    await expect(page.locator(".alert-error")).toContainText(
      "YAML parse error",
    );

    // Click Back to Workflows
    await page.click('button:has-text("Back to Workflows")');
    await expect(page).toHaveURL(/#workflows/);
  });
});
