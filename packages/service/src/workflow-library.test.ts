import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  listWorkflows,
  saveWorkflow,
  validateWorkflow,
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
