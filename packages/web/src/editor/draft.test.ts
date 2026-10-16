import assert from "node:assert/strict";
import test from "node:test";
import {
  createDefaultAgentNode,
  createDefaultCommandNode,
  createDefaultForeachNode,
  createDefaultGroupNode,
  draftToPlainObject,
  duplicateSubtree,
  parseDraftFromObject,
  renameNodeInDraft,
} from "./draft.ts";

test("creates default nodes with expected shapes", () => {
  const agent = createDefaultAgentNode("a1");
  assert.equal(agent.id, "a1");
  assert.equal(agent.kind, "agent");
  assert.deepEqual(agent.dependsOn, []);
  assert.equal(agent.writable, false);

  const cmd = createDefaultCommandNode("c1");
  assert.equal(cmd.id, "c1");
  assert.equal(cmd.kind, "command");

  const group = createDefaultGroupNode("g1");
  assert.equal(group.id, "g1");
  assert.equal(group.kind, "group");
  assert.equal(group.maxRounds, 3);

  const fe = createDefaultForeachNode("f1");
  assert.equal(fe.id, "f1");
  assert.equal(fe.kind, "foreach");
});

test("round-trips nested group -> foreach -> group -> agent structure", () => {
  const raw = {
    inputs: ["prompt", "repo"],
    maxParallel: 2,
    budgetUsd: 5.5,
    nodes: [
      {
        id: "outerGroup",
        kind: "group",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: workflow reference syntax
        until: { ref: "${nodes.innerFe.manifest.json#/done}", equals: true },
        maxRounds: 4,
        onExhausted: "approve",
        nodes: [
          {
            id: "innerFe",
            kind: "foreach",
            // biome-ignore lint/suspicious/noTemplateCurlyInString: workflow reference syntax
            source: "${inputs.prompt}",
            nodes: [
              {
                id: "nestedGroup",
                kind: "group",
                // biome-ignore lint/suspicious/noTemplateCurlyInString: workflow reference syntax
                until: { ref: "${nodes.worker.out.json#/ok}", equals: true },
                maxRounds: 2,
                onExhausted: "fail",
                nodes: [
                  {
                    id: "worker",
                    kind: "agent",
                    definition: {
                      kind: "agent",
                      model: "claude-sonnet-4-5",
                      thinkingLevel: "medium",
                      // biome-ignore lint/suspicious/noTemplateCurlyInString: workflow reference syntax
                      task: "Work on ${item.id}",
                      instructions: "Be precise",
                      interactive: false,
                      skillNames: ["git-helper"],
                      outputs: ["out.json"],
                    },
                    schemas: {
                      "out.json": {
                        type: "object",
                        properties: { ok: { type: "boolean" } },
                      },
                    },
                    writable: true,
                    approval: true,
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };

  const parsed = parseDraftFromObject(raw);
  assert.equal(parsed.valid, true);
  assert.deepEqual(parsed.unsupportedFields, []);
  assert.equal(parsed.draft.nodes.length, 1);

  const serialized = draftToPlainObject(parsed.draft);
  assert.deepEqual(serialized, raw);
});

test("detects unsupported and unknown fields across root, node and definition", () => {
  const withUnknown = {
    inputs: ["p"],
    maxParallel: 1,
    customRootField: "surprise",
    nodes: [
      {
        id: "step1",
        kind: "agent",
        unknownNodeProp: 123,
        definition: {
          kind: "agent",
          model: "gpt-4o",
          task: "Run",
          extraDefKey: "bad",
        },
      },
    ],
  };

  const res = parseDraftFromObject(withUnknown);
  assert.equal(res.valid, false);
  assert.ok(res.unsupportedFields.includes("workflow.customRootField"));
  assert.ok(res.unsupportedFields.includes("nodes[0].unknownNodeProp"));
  assert.ok(res.unsupportedFields.includes("nodes[0].definition.extraDefKey"));
});

test("duplicateSubtree remaps internal dependencies and node references without touching outer ones", () => {
  const node1 = createDefaultAgentNode("stepA");
  node1.outputs = ["result.json"];
  const node2 = createDefaultAgentNode("stepB");
  node2.dependsOn = ["stepA", "externalNode"];
  node2.task =
    // biome-ignore lint/suspicious/noTemplateCurlyInString: workflow reference syntax
    "Consume ${nodes.stepA.result.json} and ${nodes.externalNode.data}";

  const group = createDefaultGroupNode("grp1");
  group.nodes = [node1, node2];

  const existingIds = new Set(["stepA", "stepB", "externalNode", "grp1"]);
  const { newNodes, idMap } = duplicateSubtree([group], existingIds);

  assert.equal(newNodes.length, 1);
  const clonedGroup = newNodes[0];
  assert.equal(clonedGroup.kind, "group");
  assert.notEqual(clonedGroup.id, "grp1");
  assert.equal(idMap.get("grp1"), clonedGroup.id);

  assert.equal(clonedGroup.nodes.length, 2);
  const [clonedA, clonedB] = clonedGroup.nodes;
  assert.equal(clonedA?.kind, "agent");
  assert.equal(clonedB?.kind, "agent");
  assert.notEqual(clonedA.id, "stepA");
  assert.notEqual(clonedB.id, "stepB");
  assert.equal(idMap.get("stepA"), clonedA.id);
  assert.equal(idMap.get("stepB"), clonedB.id);

  // Internal dep stepA should be remapped to clonedA.id; externalNode remains externalNode
  assert.deepEqual(clonedB.dependsOn, [clonedA.id, "externalNode"]);

  // Internal reference ${nodes.stepA.result.json} remapped; externalNode remains
  assert.equal(
    clonedB.task,
    `Consume \${nodes.${clonedA.id}.result.json} and \${nodes.externalNode.data}`,
  );

  // Original untouched
  assert.deepEqual(node2.dependsOn, ["stepA", "externalNode"]);
});

test("renameNodeInDraft renames node and updates downstream dependencies", () => {
  const node1 = createDefaultAgentNode("stepA");
  const node2 = createDefaultCommandNode("stepB");
  node2.dependsOn = ["stepA"];

  const group = createDefaultGroupNode("grp1");
  const innerNode = createDefaultAgentNode("stepC");
  innerNode.dependsOn = ["stepA"];
  group.nodes = [innerNode];

  const draft = {
    inputs: [],
    maxParallel: 1,
    nodes: [node1, node2, group],
  };

  const renamed = renameNodeInDraft(draft, "stepA", "stepAlpha");
  assert.equal(renamed.nodes[0]?.id, "stepAlpha");
  assert.deepEqual(renamed.nodes[1]?.dependsOn, ["stepAlpha"]);
  const g = renamed.nodes[2];
  if (g?.kind === "group") {
    assert.deepEqual(g.nodes[0]?.dependsOn, ["stepAlpha"]);
  }
});
