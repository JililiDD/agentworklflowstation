import assert from "node:assert/strict";
import test from "node:test";
import {
  createDefaultAgentNode,
  createDefaultCommandNode,
  createDefaultForeachNode,
  createDefaultGroupNode,
  type EditorWorkflowDraft,
} from "./draft.ts";
import {
  detectReferencedOutputs,
  draftToFlowElements,
  flowNodesToLayoutMap,
  updateDraftNodeHierarchy,
} from "./flow-transform.ts";

test("detectReferencedOutputs extracts quoted output filenames for upstream node", () => {
  const text =
    // biome-ignore lint/suspicious/noTemplateCurlyInString: test pattern
    "Process ${nodes.step1.out.json#/item} and ${nodes.step1.manifest.txt} and ${nodes.other.data}";
  const detected = detectReferencedOutputs(text, "step1");
  assert.equal(detected.length, 2);
  assert.ok(detected.includes("out.json"));
  assert.ok(detected.includes("manifest.txt"));
});

test("draftToFlowElements places parents before children in nodes array and generates edges", () => {
  const agent1 = createDefaultAgentNode("a1");
  agent1.task = "Task 1";

  const group = createDefaultGroupNode("g1");
  const innerAgent = createDefaultAgentNode("inner1");
  innerAgent.dependsOn = ["a1"]; // Cross layer (will be checked by validation, but edge can be mapped)
  // biome-ignore lint/suspicious/noTemplateCurlyInString: test pattern
  innerAgent.task = "Read ${nodes.a1.result.json}";
  group.nodes = [innerAgent];

  const draft = {
    inputs: [],
    maxParallel: 1,
    nodes: [agent1, group],
  };

  const { nodes, edges } = draftToFlowElements(draft);
  assert.equal(nodes.length, 3);

  // Group container must precede inner1 in array
  const groupIndex = nodes.findIndex((n) => n.id === "g1");
  const innerIndex = nodes.findIndex((n) => n.id === "inner1");
  assert.ok(groupIndex !== -1);
  assert.ok(innerIndex !== -1);
  assert.ok(
    groupIndex < innerIndex,
    "parent must precede child in React Flow nodes array",
  );

  // Child node has parentId set to g1
  assert.equal(nodes[innerIndex]?.parentId, "g1");

  // Edge has label with referenced file
  const edge = edges.find((e) => e.id === "a1->inner1");
  assert.ok(edge);
  assert.equal(edge?.label, "result.json");
});

test("draftToFlowElements extracts referenced output labels from command node and instructions", () => {
  const up = createDefaultAgentNode("up");
  up.outputs = ["data.csv"];

  const cmd = createDefaultCommandNode("cmd");
  cmd.dependsOn = ["up"];
  // biome-ignore lint/suspicious/noTemplateCurlyInString: test pattern
  cmd.command = "wc -l ${nodes.up.data.csv}";

  const draft: EditorWorkflowDraft = {
    inputs: [],
    maxParallel: 1,
    nodes: [up, cmd],
  };

  const { edges } = draftToFlowElements(draft);
  const edge = edges.find((e) => e.id === "up->cmd");
  assert.ok(edge);
  assert.equal(edge?.label, "data.csv");
});

test("flowNodesToLayoutMap serializes coordinates, measured dimensions and collapsed state", () => {
  const nodes = [
    {
      id: "node1",
      position: { x: 120, y: 240 },
      data: { collapsed: false },
      measured: { width: 200, height: 100 },
    },
    {
      id: "group1",
      position: { x: 300, y: 100 },
      data: { collapsed: true },
      style: { width: 400, height: 60 },
    },
  ];

  const layout = flowNodesToLayoutMap(
    nodes as unknown as Parameters<typeof flowNodesToLayoutMap>[0],
  );
  assert.equal(layout.node1?.x, 120);
  assert.equal(layout.node1?.y, 240);
  assert.equal(layout.node1?.width, 200);
  assert.equal(layout.node1?.collapsed, false);

  assert.equal(layout.group1?.collapsed, true);
  assert.equal(layout.group1?.width, 400);
});

test("updateDraftNodeHierarchy moves nodes in and out of nested containers", () => {
  const cmd = createDefaultCommandNode("c1");
  const group = createDefaultGroupNode("g1");
  const fe = createDefaultForeachNode("f1");

  let draft: EditorWorkflowDraft = {
    inputs: [],
    maxParallel: 1,
    nodes: [cmd, group, fe],
  };

  // Move cmd into group g1
  draft = updateDraftNodeHierarchy(draft, "c1", "g1");
  assert.equal(draft.nodes.length, 2);
  const foundGroup = draft.nodes.find((n) => n.id === "g1");
  assert.equal(foundGroup?.kind, "group");
  if (foundGroup?.kind === "group") {
    assert.equal(foundGroup.nodes.length, 1);
    assert.equal(foundGroup.nodes[0]?.id, "c1");
  }

  // Move cmd from g1 into fe f1
  draft = updateDraftNodeHierarchy(draft, "c1", "f1");
  const gAfter = draft.nodes.find((n) => n.id === "g1");
  const fAfter = draft.nodes.find((n) => n.id === "f1");
  assert.equal(gAfter?.kind, "group");
  assert.equal(fAfter?.kind, "foreach");
  if (gAfter?.kind === "group") {
    assert.equal(gAfter.nodes.length, 0);
  }
  if (fAfter?.kind === "foreach") {
    assert.equal(fAfter.nodes[0]?.id, "c1");
  }

  // Move cmd back to root level
  draft = updateDraftNodeHierarchy(draft, "c1", undefined);
  assert.equal(draft.nodes.length, 3);
  assert.ok(draft.nodes.some((n) => n.id === "c1"));
});
