import assert from "node:assert/strict";
import test from "node:test";
import { loadWorkflow, type WorkflowCapabilities } from "@aipilotagent/engine";
import { parseDraftFromObject } from "./draft.ts";
import {
  AIPILOT_EXAMPLE_WORKFLOW,
  BUILTIN_EXAMPLES,
  NOVEL_EXAMPLE_WORKFLOW,
} from "./examples.ts";
import { draftToFlowElements } from "./flow-transform.ts";

const capabilities: WorkflowCapabilities = {
  models: {
    "fake/small": ["off", "low", "medium", "high"],
    "claude-sonnet-4-5": ["off", "low", "medium", "high"],
  },
};

test("BUILTIN_EXAMPLES contains both aipilot and novel workflows", () => {
  assert.equal(BUILTIN_EXAMPLES.length, 2);
  assert.equal(AIPILOT_EXAMPLE_WORKFLOW.id, "aipilot-development");
  assert.equal(NOVEL_EXAMPLE_WORKFLOW.id, "novel-writing");
});

test("aipilot development example satisfies engine validation rules", async () => {
  const def = await loadWorkflow(
    AIPILOT_EXAMPLE_WORKFLOW.workflow,
    capabilities,
  );
  assert.equal(def.nodes.length, 4);
  assert.equal(def.inputs.length, 1);
  assert.equal(def.inputs[0], "featureRequest");

  // Test draft parsing and flow element conversion
  const parsed = parseDraftFromObject(AIPILOT_EXAMPLE_WORKFLOW.workflow);
  assert.equal(parsed.valid, true);
  assert.equal(parsed.unsupportedFields.length, 0);

  const { nodes, edges } = draftToFlowElements(
    parsed.draft,
    AIPILOT_EXAMPLE_WORKFLOW.layout,
  );
  assert.equal(nodes.length, 4);
  assert.equal(edges.length, 3);
});

test("novel writing example satisfies engine validation rules", async () => {
  const def = await loadWorkflow(NOVEL_EXAMPLE_WORKFLOW.workflow, capabilities);
  assert.equal(def.nodes.length, 2);
  assert.equal(def.inputs.length, 1);
  assert.equal(def.inputs[0], "novelTheme");

  // Test draft parsing and flow element conversion
  const parsed = parseDraftFromObject(NOVEL_EXAMPLE_WORKFLOW.workflow);
  assert.equal(parsed.valid, true);
  assert.equal(parsed.unsupportedFields.length, 0);

  const { nodes, edges } = draftToFlowElements(
    parsed.draft,
    NOVEL_EXAMPLE_WORKFLOW.layout,
  );
  assert.equal(nodes.length, 4); // outlinePlanner, chaptersForeach, writeChapter, verifyChapter
  assert.ok(edges.length >= 2);
});
