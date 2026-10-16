import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import {
  getSettings,
  listSkillsFromSettings,
  saveSettings,
} from "./settings.ts";
import { safeId } from "./storage.ts";
import {
  deleteWorkflow,
  getWorkflow,
  getWorkflowLayout,
  listWorkflows,
  saveWorkflow,
  saveWorkflowLayout,
  updateWorkflowDocument,
  validateWorkflow,
  WorkflowConflictError,
  WorkflowSafetyError,
} from "./workflow-library.ts";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "aipilot-service-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

test("safeId validates identifier and rejects path traversal", () => {
  assert.equal(safeId("my-flow"), "my-flow");
  assert.equal(safeId("flow_123.test"), "flow_123.test");

  assert.throws(() => safeId(""), /non-empty string/);
  assert.throws(() => safeId(".."), /invalid/);
  assert.throws(() => safeId("../evil"), /invalid/);
  assert.throws(() => safeId("evil/child"), /invalid/);
  assert.throws(() => safeId("/root"), /invalid/);
  assert.throws(() => safeId("evil\\flow"), /invalid/);
});

test("saveSettings persists and reloads across calls", async () => {
  const initial = await getSettings(tempDir);
  assert.deepEqual(initial.skillDirectories, []);

  const skillDir1 = join(tempDir, "skills-1");
  const skillDir2 = join(tempDir, "skills-2");
  await mkdir(skillDir1, { recursive: true });

  const saved = await saveSettings(tempDir, {
    skillDirectories: [skillDir1, skillDir2, skillDir1], // duplicate
  });
  assert.equal(saved.skillDirectories.length, 2);

  const reloaded = await getSettings(tempDir);
  assert.deepEqual(reloaded.skillDirectories, [skillDir1, skillDir2]);
});

test("listSkillsFromSettings lists SKILL.md subdirectories and handles missing directories", async () => {
  const source1 = join(tempDir, "source1");
  const skillA = join(source1, "skill-a");
  await mkdir(skillA, { recursive: true });
  await writeFile(
    join(skillA, "SKILL.md"),
    "---\nname: skill-a\ndescription: Test Skill A\n---\n# Skill A\n",
  );

  const nonSkill = join(source1, "not-a-skill");
  await mkdir(nonSkill, { recursive: true });

  const missingSource = join(tempDir, "does-not-exist");

  await saveSettings(tempDir, {
    skillDirectories: [source1, missingSource],
  });

  const skills = await listSkillsFromSettings(tempDir);
  assert.equal(skills.length, 1);
  assert.equal(skills[0]?.name, "skill-a");
  assert.equal(skills[0]?.description, "Test Skill A");
  assert.equal(skills[0]?.directory, skillA);
});

test("saveWorkflow, getWorkflow and listWorkflows manage YAML workflows", async () => {
  const sampleYaml = `
name: Sample Flow
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

  const saved = await saveWorkflow(tempDir, "flow-1", sampleYaml);
  assert.equal(saved.id, "flow-1");

  const loaded = await getWorkflow(tempDir, "flow-1");
  assert.equal(loaded.id, "flow-1");
  assert.match(loaded.yaml, /Sample Flow/);

  const list = await listWorkflows(tempDir);
  assert.equal(list.length, 1);
  assert.equal(list[0]?.id, "flow-1");
  assert.equal(list[0]?.valid, true);
  assert.equal(list[0]?.nodeCount, 1);
  assert.deepEqual(list[0]?.inputs, ["topic"]);

  // Delete
  await deleteWorkflow(tempDir, "flow-1");
  const emptyList = await listWorkflows(tempDir);
  assert.equal(emptyList.length, 0);
  await assert.rejects(() => getWorkflow(tempDir, "flow-1"), /not found/);
});

test("invalid YAML is reported as invalid in workflow library", async () => {
  const brokenYaml = `
inputs: [
nodes: "broken yaml
`;
  const workflowsDir = join(tempDir, "workflows");
  await mkdir(workflowsDir, { recursive: true });
  await writeFile(join(workflowsDir, "broken.yaml"), brokenYaml);

  const list = await listWorkflows(tempDir);
  assert.equal(list.length, 1);
  assert.equal(list[0]?.id, "broken");
  assert.equal(list[0]?.valid, false);
  assert.ok(list[0]?.error);
});

test("validateWorkflow runs full DAG, reference, and capability validation on YAML", async () => {
  const capabilities = {
    models: {
      "anthropic/claude-haiku-5-5": ["off", "low"] as ("off" | "low")[],
    },
  };

  const validYaml = `
inputs:
  - topic
maxParallel: 2
budgetUsd: 1.5
nodes:
  - id: writer
    kind: agent
    definition:
      model: anthropic/claude-haiku-5-5
      thinkingLevel: off
      task: "Write about \${inputs.topic}"
      outputs:
        - out.json
    schemas:
      out.json:
        type: object
        properties:
          result:
            type: string
  - id: reviewer
    kind: agent
    dependsOn:
      - writer
    definition:
      model: anthropic/claude-haiku-5-5
      thinkingLevel: low
      task: "Review \${nodes.writer.out.json#/result}"
`;

  const def = await validateWorkflow(validYaml, capabilities);
  assert.equal(def.inputs.length, 1);
  assert.equal(def.nodes.length, 2);

  // Invalid model capability in YAML
  const invalidModelYaml = validYaml.replace(
    "anthropic/claude-haiku-5-5",
    "unsupported/model",
  );
  await assert.rejects(
    () => validateWorkflow(invalidModelYaml, capabilities),
    /unsupported model/,
  );

  // Non-ancestor reference in YAML
  const badRefYaml = validYaml.replace("dependsOn:\n      - writer", "");
  await assert.rejects(
    () => validateWorkflow(badRefYaml, capabilities),
    /invalid or non-ancestor reference/,
  );
});

test("updateWorkflowDocument preserves comments and unknown fields on existing YAML", () => {
  const original = `
# Global workflow comment
inputs:
  - topic
# Parallel setting
maxParallel: 1
nodes:
  # First worker comment
  - id: worker1
    kind: command
    customProp: "do not touch this"
    definition:
      task: run echo
      command: echo original
  - id: worker2
    kind: command
    definition:
      task: second worker
      command: echo worker2
`;

  const updatedRecord = {
    inputs: ["topic", "extra"],
    maxParallel: 2,
    nodes: [
      {
        id: "worker1",
        kind: "command",
        definition: {
          task: "run echo updated",
          command: "echo updated",
        },
      },
      {
        id: "worker2",
        kind: "command",
        definition: {
          task: "second worker",
          command: "echo worker2",
        },
      },
      {
        id: "worker3",
        kind: "command",
        definition: {
          task: "third worker",
          command: "echo worker3",
        },
      },
    ],
  };

  const updatedYaml = updateWorkflowDocument(original, updatedRecord);
  assert.match(updatedYaml, /# Global workflow comment/);
  assert.match(updatedYaml, /# Parallel setting/);
  assert.match(updatedYaml, /# First worker comment/);
  assert.match(updatedYaml, /customProp:\s*"do not touch this"/);
  assert.match(updatedYaml, /echo updated/);
  assert.match(updatedYaml, /echo worker3/);
});

test("saveWorkflow refuses to delete nodes with attached comments to protect data", async () => {
  const commentedYaml = `
nodes:
  # Crucial comment describing worker1 logic
  - id: worker1
    kind: command
    definition:
      task: step
      command: echo step
`;
  await saveWorkflow(tempDir, "commented", commentedYaml);

  // Attempt to save an update where worker1 is deleted
  const updateWithoutWorker1 = {
    nodes: [
      {
        id: "worker2",
        kind: "command",
        definition: { task: "step 2", command: "echo step2" },
      },
    ],
  };

  await assert.rejects(
    () =>
      saveWorkflow({
        dataDir: tempDir,
        id: "commented",
        updatedObject: updateWithoutWorker1,
      }),
    (err: unknown) => {
      assert.ok(err instanceof WorkflowSafetyError);
      assert.match((err as Error).message, /attached comments/);
      return true;
    },
  );

  // Verify original file unchanged
  const current = await getWorkflow(tempDir, "commented");
  assert.match(current.yaml, /Crucial comment/);
});

test("saveWorkflow rejects YAML containing aliases or anchors", async () => {
  const aliasYaml = `
common: &commonDef
  task: shared
nodes:
  - id: step1
    kind: command
    definition:
      <<: *commonDef
      command: echo step1
`;
  await saveWorkflow(tempDir, "with-alias", aliasYaml);

  await assert.rejects(
    () =>
      saveWorkflow({
        dataDir: tempDir,
        id: "with-alias",
        updatedObject: {
          nodes: [
            {
              id: "step1",
              kind: "command",
              definition: { command: "echo changed" },
            },
          ],
        },
      }),
    (err: unknown) => {
      assert.ok(err instanceof WorkflowSafetyError);
      assert.match((err as Error).message, /aliases or anchors/);
      return true;
    },
  );
});

test("saveWorkflow preserves .yml extension and detects revision conflicts", async () => {
  const workflowsDir = join(tempDir, "workflows");
  await mkdir(workflowsDir, { recursive: true });
  const ymlPath = join(workflowsDir, "legacy.yml");
  const initialYaml = "maxParallel: 1\nnodes: []\n";
  await writeFile(ymlPath, initialYaml, "utf8");

  // Save update to legacy
  const saved = await saveWorkflow({
    dataDir: tempDir,
    id: "legacy",
    updatedObject: { maxParallel: 4, nodes: [] },
    expectedYaml: initialYaml,
  });
  assert.equal(saved.path, ymlPath);
  assert.ok(saved.path.endsWith(".yml"));

  // Check revision conflict
  await assert.rejects(
    () =>
      saveWorkflow({
        dataDir: tempDir,
        id: "legacy",
        updatedObject: { maxParallel: 8, nodes: [] },
        expectedYaml: "outdated yaml content",
      }),
    (err: unknown) => {
      assert.ok(err instanceof WorkflowConflictError);
      assert.match((err as Error).message, /revision conflict/);
      return true;
    },
  );
});

test("saveWorkflow refuses to write to a symlink", async () => {
  const workflowsDir = join(tempDir, "workflows");
  await mkdir(workflowsDir, { recursive: true });
  const outsideFile = join(tempDir, "outside.yaml");
  await writeFile(outsideFile, "nodes: []\n", "utf8");
  const linkPath = join(workflowsDir, "symlinked.yaml");
  await symlink(outsideFile, linkPath);

  await assert.rejects(
    () =>
      saveWorkflow({
        dataDir: tempDir,
        id: "symlinked",
        yamlText: "nodes: []\n",
      }),
    /symlinks are forbidden/,
  );
});

test("saveWorkflowLayout and getWorkflowLayout handle sidecar persistence, corruptions and failures", async () => {
  const layout = {
    step1: { x: 100, y: 150, width: 220, height: 120 },
    step2: { x: 400, y: 150, collapsed: true },
  };

  // Normal save and get
  await saveWorkflowLayout(tempDir, "flow-layout", layout, "rev123");
  const loaded = await getWorkflowLayout(tempDir, "flow-layout");
  assert.equal(loaded?.version, 1);
  assert.deepEqual(loaded?.current.step1, layout.step1);
  assert.equal(loaded?.revisions?.rev123?.step2?.collapsed, true);

  // Corrupted layout returns null without crashing
  const workflowsDir = join(tempDir, "workflows");
  const corruptPath = join(workflowsDir, "corrupted.layout.json");
  await writeFile(corruptPath, "{ broken json", "utf8");
  await assert.rejects(() => getWorkflowLayout(tempDir, "corrupted"));

  // Symlinked layout is forbidden
  const outsidePath = join(tempDir, "outside.layout.json");
  await writeFile(outsidePath, JSON.stringify({ version: 1, current: {} }));
  const linkPath = join(workflowsDir, "symlink-flow.layout.json");
  await symlink(outsidePath, linkPath);
  await assert.rejects(
    () => getWorkflowLayout(tempDir, "symlink-flow"),
    /symlinks are forbidden/,
  );
  await assert.rejects(
    () => saveWorkflowLayout(tempDir, "symlink-flow", layout),
    /symlinks are forbidden/,
  );

  // Fault injection: layout write failure leaves YAML untouched
  // We make symlink on target layout so saving layout fails
  await assert.rejects(
    () =>
      saveWorkflow({
        dataDir: tempDir,
        id: "symlink-flow",
        yamlText: "maxParallel: 1\nnodes: []\n",
        layout,
      }),
    /symlinks are forbidden/,
  );
  // Target YAML was never created
  await assert.rejects(() => getWorkflow(tempDir, "symlink-flow"), /not found/);
});
