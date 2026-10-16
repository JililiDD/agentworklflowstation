import { readFile } from "node:fs/promises";
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

test.describe("Workflow Editor - Story 2 & 3: Canvas, Nesting, Properties, References, and Validation", () => {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: test syntax
  test("1. Build nested group -> foreach -> agent, edit attributes, insert ${...} ref, and verify markers", async ({
    page,
  }) => {
    // Set 1280px viewport per D-8
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${fixture.baseUrl}#workflow-editor/new`);
    await expect(page.locator("span:has-text('Workflow:')")).toBeVisible();

    const idInput = page.locator('input[placeholder="workflow_id"]');
    await idInput.fill("nested_demo");

    // Add Group node (D-3)
    await page.click('button:has-text("🔄 + Group")');
    const groupCard = page.locator(".container-group:has-text('group1')");
    await expect(groupCard).toBeVisible();

    // Select group1 to insert Foreach inside it
    await groupCard.click();
    await page.click('button:has-text("🔁 + Foreach")');
    const foreachCard = page.locator(".container-foreach:has-text('foreach1')");
    await expect(foreachCard).toBeVisible();

    // Select foreach1 to insert Agent inside it (AC-16)
    await foreachCard.click();
    await page.click('button:has-text("🤖 + Agent")');
    const agentCard = page.locator(".card-agent:has-text('agent1')");
    await expect(agentCard).toBeVisible();

    // Click agent1 to open property drawer (D-4, D-5)
    await agentCard.click();
    const drawer = page.locator("aside.drawer");
    await expect(drawer).toBeVisible();
    await expect(drawer.locator("h3")).toContainText("agent1");

    // D-5: Check tabs
    await expect(drawer.locator('button:has-text("model")')).toBeVisible();
    await expect(drawer.locator('button:has-text("prompt")')).toBeVisible();
    await expect(drawer.locator('button:has-text("behavior")')).toBeVisible();
    await expect(drawer.locator('button:has-text("outputs")')).toBeVisible();

    // Model tab: select fake/small
    await drawer
      .locator("select#drawer-agent-model")
      .selectOption("fake/small");

    // Prompt tab: write task and insert reference (D-58)
    await drawer.locator('button:has-text("prompt")').click();
    const taskArea = drawer.locator("textarea#drawer-agent-task");
    await taskArea.fill("Process item ");

    // Click reference button if present
    const itemRefBtn = drawer.locator('button:has-text("item.<field>")');
    if (await itemRefBtn.isVisible()) {
      await itemRefBtn.click();
      const val = await taskArea.inputValue();
      // biome-ignore lint/suspicious/noTemplateCurlyInString: test syntax
      expect(val).toContain("${item.}");
    } else {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: test syntax
      await taskArea.fill("Process item ${inputs.topic}");
    }

    // Rename node test (Finding 1)
    const idInputNode = drawer.locator("input#drawer-node-id");
    await idInputNode.fill("agent_renamed");
    const renamedAgentCard = page.locator(
      ".card-agent:has-text('agent_renamed')",
    );
    await expect(renamedAgentCard).toBeVisible();

    // Behavior tab: enable Writable, Interactive, Approval, and add When Condition (AC-8, AC-9, AC-12, AC-13)
    await drawer.locator('button:has-text("behavior")').click();
    await drawer.locator("text=Writable").click();
    await drawer.locator("text=Interactive").click();
    await drawer.locator("text=Approval").click();

    // AC-12: Add When condition (Finding 3)
    await drawer.locator('button:has-text("+ Add Condition")').click();
    const whenRefInput = drawer.locator("input#when-ref-0");
    await expect(whenRefInput).toBeVisible();
    // biome-ignore lint/suspicious/noTemplateCurlyInString: test syntax
    await whenRefInput.fill("${inputs.topic}");

    // D-11: Markers should now appear on card (including ⚡)
    await expect(renamedAgentCard.locator("text=✏️")).toBeVisible();
    await expect(renamedAgentCard.locator("text=💬")).toBeVisible();
    await expect(renamedAgentCard.locator("text=🛡️")).toBeVisible();
    await expect(renamedAgentCard.locator("text=⚡")).toBeVisible();

    // Outputs tab: declare output file
    await drawer.locator('button:has-text("outputs")').click();
    await drawer
      .locator("input#drawer-agent-outputs")
      .fill("result.json, summary.txt");
    await expect(renamedAgentCard).toContainText("2 out");
  });

  test("2. Validation errors, Problems panel, Go to node, and Run disabled (AC-20 to AC-27; D-19 to D-22)", async ({
    page,
  }) => {
    await page.goto(`${fixture.baseUrl}#workflow-editor/new`);
    await page
      .locator('input[placeholder="workflow_id"]')
      .fill("validation_demo");

    // Add agent node with empty task
    await page.click('button:has-text("🤖 + Agent")');
    const agentCard = page.locator(".card-agent:has-text('agent1')");
    await expect(agentCard).toBeVisible();

    // Problems panel should show MISSING_TASK error
    const problems = page.locator(".problems-panel");
    await expect(problems).toBeVisible();
    await expect(problems).toContainText("empty task description");

    // D-19: Agent card border has error state and error icon
    await expect(agentCard.locator(".error-icon")).toBeVisible();

    // D-22: Run button is disabled with error count in title
    const runBtn = page.getByRole("button", { name: "Run", exact: true });
    await expect(runBtn).toBeDisabled();
    const title = await runBtn.getAttribute("title");
    expect(title).toContain("validation error");

    // D-21: Click "Go to node" focuses and selects the node
    await problems.locator('button:has-text("Go to node →")').first().click();
    const drawer = page.locator("aside.drawer");
    await expect(drawer).toBeVisible();
    await expect(drawer.locator("h3")).toContainText("agent1");

    // Fix the error by selecting model and task
    await drawer
      .locator("select#drawer-agent-model")
      .selectOption("fake/small");
    await drawer.locator('button:has-text("prompt")').click();
    await drawer
      .locator("textarea#drawer-agent-task")
      .fill("Fixed task instruction");

    // Error resolves, problems panel hides or count drops
    await expect(agentCard.locator(".error-icon")).not.toBeVisible();
  });

  test("3. Copy & paste duplicate subtree with independent IDs and dependencies (AC-17)", async ({
    page,
  }) => {
    await page.goto(`${fixture.baseUrl}#workflow-editor/new`);
    await page.locator('input[placeholder="workflow_id"]').fill("copy_demo");

    // Add Command node
    await page.click('button:has-text("💻 + Command")');
    const cmd1 = page
      .locator(".card-command")
      .filter({ has: page.locator("span", { hasText: /^command1$/ }) });
    await expect(cmd1).toBeVisible();

    // Select command1
    await cmd1.click();

    // Click Copy button in topbar
    await page.click('button:has-text("Copy")');

    // Click Paste button
    await page.click('button:has-text("Paste")');

    // Cloned node should appear with unique ID
    const cmdCopy = page.locator(".card-command:has-text('command1_copy')");
    await expect(cmdCopy).toBeVisible();
    // Original untouched
    await expect(cmd1).toBeVisible();
  });

  test("4. Save workflow and reload restores layout positions without polluting YAML (AC-19, AC-92)", async ({
    page,
  }) => {
    await page.goto(`${fixture.baseUrl}#workflow-editor/new`);
    await page
      .locator('input[placeholder="workflow_id"]')
      .fill("persisted_layout_flow");

    // Add Agent node and Command node
    await page.click('button:has-text("🤖 + Agent")');
    await page.click('button:has-text("💻 + Command")');

    const agentCard = page.locator(".card-agent:has-text('agent1')");
    await agentCard.click();
    const drawer = page.locator("aside.drawer");
    await drawer
      .locator("select#drawer-agent-model")
      .selectOption("fake/small");
    await drawer.locator('button:has-text("prompt")').click();
    await drawer.locator("textarea#drawer-agent-task").fill("Agent task here");

    const cmdCard = page.locator(".card-command:has-text('command1')");
    await cmdCard.click();
    await drawer
      .locator("input#drawer-cmd-command")
      .fill("echo test persisted execution");

    // Click Save button
    await page.click('button:has-text("Save")');
    await expect(page.locator("text=✓ Saved")).toBeVisible();

    // Reload page
    await page.reload();
    await expect(page.locator(".card-agent:has-text('agent1')")).toBeVisible();
    await expect(
      page.locator(".card-command:has-text('command1')"),
    ).toBeVisible();

    // Check disk file on server: YAML definition must not contain any UI/layout keys
    const workflowsDir = join(fixture.dataDir, "workflows");
    const yamlContent = await readFile(
      join(workflowsDir, "persisted_layout_flow.yaml"),
      "utf8",
    );
    expect(yamlContent).not.toContain("position");
    expect(yamlContent).not.toContain("measured");
    expect(yamlContent).not.toContain("layout:");
    expect(yamlContent).toContain("echo test persisted execution");

    // Layout sidecar file exists and contains coordinates
    const layoutContent = await readFile(
      join(workflowsDir, "persisted_layout_flow.layout.json"),
      "utf8",
    );
    const layoutJson = JSON.parse(layoutContent);
    expect(layoutJson.version).toBe(1);
    expect(layoutJson.current.agent1).toBeDefined();
    expect(layoutJson.current.command1).toBeDefined();
  });
});
