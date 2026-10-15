// biome-ignore-all lint/suspicious/noTemplateCurlyInString: These are literal workflow references, not JavaScript interpolation.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadWorkflow } from "./load-workflow.ts";

const capabilities = { models: { "fake/small": ["off" as const] } };
const agent = (id: string, dependsOn: string[] = [], overrides = {}) => ({
  id,
  dependsOn,
  kind: "agent",
  definition: {
    kind: "agent",
    model: "fake/small",
    thinkingLevel: "off",
    task: "write ${outputs.result.json}",
    interactive: false,
    outputs: ["result.json"],
  },
  schemas: {
    "result.json": {
      type: "object",
      properties: { ready: { type: "boolean" } },
      required: ["ready"],
      additionalProperties: false,
    },
  },
  ...overrides,
});
const parse = (nodes: unknown[], inputs: string[] = ["topic"]) =>
  loadWorkflow(JSON.stringify({ inputs, maxParallel: 2, nodes }), capabilities);

for (const [name, nodes, pattern] of [
  ["duplicate IDs", [agent("x"), agent("x")], /duplicate/],
  ["cycle", [agent("a", ["b"]), agent("b", ["a"])], /cycle/],
  ["missing dependency", [agent("a", ["missing"])], /invalid dependency/],
  [
    "cross-container dependency",
    [
      {
        id: "g",
        kind: "group",
        dependsOn: [],
        nodes: [agent("inner")],
        until: { ref: "${nodes.inner.result.json#/ready}", equals: true },
        maxRounds: 2,
        onExhausted: "fail",
      },
      agent("other", ["inner"]),
    ],
    /invalid dependency/,
  ],
  [
    "sibling reference",
    [
      agent("a"),
      agent("b", [], {
        definition: {
          ...agent("b").definition,
          task: "${nodes.a.result.json}",
        },
      }),
    ],
    /non-ancestor/,
  ],
  [
    "non-JSON condition",
    [
      agent("a"),
      agent("b", ["a"], {
        when: [{ ref: "${nodes.a.result.json}", equals: true }],
      }),
    ],
    /JSON field/,
  ],
  [
    "non-JSON output",
    [
      {
        id: "cmd",
        dependsOn: [],
        kind: "command",
        definition: {
          kind: "command",
          command: "echo ok",
          allowNonZeroExit: false,
        },
      },
      agent("a", ["cmd"], {
        when: [{ ref: "${nodes.cmd.stdout#/ok}", equals: true }],
      }),
    ],
    /JSON field/,
  ],
  [
    "unknown input",
    [
      agent("a", [], {
        definition: { ...agent("a").definition, task: "${inputs.unknown}" },
      }),
    ],
    /non-ancestor/,
  ],
  [
    "unknown output",
    [
      agent("a", [], {
        definition: { ...agent("a").definition, task: "${outputs.missing}" },
      }),
    ],
    /non-ancestor/,
  ],
  [
    "invalid model level",
    [
      agent("a", [], {
        definition: { ...agent("a").definition, thinkingLevel: "high" },
      }),
    ],
    /unsupported model/,
  ],
  [
    "missing schema field",
    [
      agent("a"),
      agent("b", ["a"], {
        when: [{ ref: "${nodes.a.result.json#/unknown}", equals: true }],
      }),
    ],
    /unknown JSON field/,
  ],
  [
    "unsafe output file",
    [
      agent("a", [], {
        definition: { ...agent("a").definition, outputs: ["../escape.json"] },
      }),
    ],
    /invalid output file/,
  ],
  [
    "child with container ID",
    [
      {
        id: "g",
        kind: "group",
        dependsOn: [],
        nodes: [agent("g")],
        until: { ref: "${nodes.g.result.json#/ready}", equals: true },
        maxRounds: 2,
        onExhausted: "fail",
      },
    ],
    /duplicate node id/,
  ],
] as [string, unknown[], RegExp][]) {
  test(`rejects ${name} before running`, async () => {
    await assert.rejects(parse(nodes), pattern);
  });
}

test("rejects broken JSON and missing skill", async () => {
  await assert.rejects(loadWorkflow("{", capabilities), /not valid JSON/);
  const root = await mkdtemp(join(tmpdir(), "engine-skill-"));
  await assert.rejects(
    parse([
      agent("a", [], {
        definition: {
          ...agent("a").definition,
          skillSourceDir: root,
          skillNames: ["missing"],
        },
      }),
    ]),
    /skill not found/,
  );
  await mkdir(join(root, "present"));
  await writeFile(join(root, "present", "SKILL.md"), "# Present\n");
  await parse([
    agent("a", [], {
      definition: {
        ...agent("a").definition,
        skillSourceDir: root,
        skillNames: ["present"],
      },
    }),
  ]);
});

test("accepts transitive ancestor references", async () => {
  await parse([
    agent("root"),
    agent("middle", ["root"]),
    agent("last", ["middle"], {
      definition: {
        ...agent("last").definition,
        task: "${nodes.root.result.json#/ready}",
      },
    }),
  ]);
});

test("accepts ancestors, inputs, item, previous round and nested groups", async () => {
  const group = {
    id: "g",
    dependsOn: [],
    kind: "group",
    maxRounds: 2,
    onExhausted: "fail",
    until: { ref: "${nodes.child.result.json#/ready}", equals: true },
    nodes: [
      agent("child", [], {
        definition: {
          ...agent("child").definition,
          task: "${nodes.seed.result.json} ${inputs.topic} ${previous.child.result.json} ${item.name} ${outputs.result.json}",
        },
      }),
    ],
  };
  await parse([
    agent("seed"),
    {
      id: "each",
      kind: "foreach",
      dependsOn: ["seed"],
      source: "${nodes.seed.result.json}",
      nodes: [group],
    },
  ]);
});
