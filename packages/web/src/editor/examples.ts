export interface ExampleWorkflowItem {
  id: string;
  name: string;
  description: string;
  workflow: Record<string, unknown>;
  layout?: Record<
    string,
    {
      x: number;
      y: number;
      width?: number;
      height?: number;
      collapsed?: boolean;
    }
  >;
}

export const AIPILOT_EXAMPLE_WORKFLOW: ExampleWorkflowItem = {
  id: "aipilot-development",
  name: "aipilot Development Workflow",
  description:
    "Interactive specification interview, implementation in git worktree, and verification via code review.",
  workflow: {
    name: "aipilot Development Workflow",
    inputs: ["featureRequest"],
    maxParallel: 1,
    budgetUsd: 10.0,
    nodes: [
      {
        id: "specPlanner",
        kind: "agent",
        dependsOn: [],
        definition: {
          kind: "agent",
          model: "fake/small",
          thinkingLevel: "off",
          interactive: true,
          // biome-ignore lint/suspicious/noTemplateCurlyInString: workflow reference syntax
          task: "Interview user on requirement '${inputs.featureRequest}' and output spec.json",
          outputs: ["spec.json"],
        },
        schemas: {
          "spec.json": {
            type: "object",
            properties: {
              feature: { type: "string" },
              approved: { type: "boolean" },
            },
            required: ["feature", "approved"],
          },
        },
      },
      {
        id: "devBuilder",
        kind: "agent",
        dependsOn: ["specPlanner"],
        writable: true,
        definition: {
          kind: "agent",
          model: "fake/small",
          thinkingLevel: "off",
          interactive: false,
          // biome-ignore lint/suspicious/noTemplateCurlyInString: workflow reference syntax
          task: "Implement the approved feature '${nodes.specPlanner.spec.json#/feature}' in the git repository and produce implementation.json",
          outputs: ["implementation.json"],
        },
        schemas: {
          "implementation.json": {
            type: "object",
            properties: {
              files: { type: "array", items: { type: "string" } },
              ready: { type: "boolean" },
            },
            required: ["files", "ready"],
          },
        },
      },
      {
        id: "codeReviewer",
        kind: "agent",
        dependsOn: ["devBuilder"],
        writable: false,
        definition: {
          kind: "agent",
          model: "fake/small",
          thinkingLevel: "off",
          interactive: false,
          // biome-ignore lint/suspicious/noTemplateCurlyInString: workflow reference syntax
          task: "Independently review the code changes made in '${nodes.devBuilder.implementation.json#/files/0}' and output review.json",
          outputs: ["review.json"],
        },
        schemas: {
          "review.json": {
            type: "object",
            properties: {
              passed: { type: "boolean" },
              notes: { type: "string" },
            },
            required: ["passed"],
          },
        },
      },
      {
        id: "gateReview",
        kind: "command",
        dependsOn: ["codeReviewer"],
        writable: false,
        definition: {
          kind: "command",
          command: [
            "node -e",
            '\'const fs=require("fs"); const r=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); if (!r.passed) { console.error("Code review failed:", r.notes); process.exit(1); } console.log("Code review passed successfully.");\'',
            `'\${${"nodes.codeReviewer.review.json"}}'`,
          ].join(" "),
          allowNonZeroExit: false,
        },
      },
    ],
  },
  layout: {
    specPlanner: { x: 260, y: 40 },
    devBuilder: { x: 260, y: 220 },
    codeReviewer: { x: 260, y: 400 },
    gateReview: { x: 260, y: 580 },
  },
};

export const NOVEL_EXAMPLE_WORKFLOW: ExampleWorkflowItem = {
  id: "novel-writing",
  name: "Novel Writing Workflow",
  description:
    "Generate a structured 2-chapter outline and sequentially draft chapters into target repository via foreach loop.",
  workflow: {
    name: "Novel Writing Workflow",
    inputs: ["novelTheme"],
    maxParallel: 1,
    budgetUsd: 10.0,
    nodes: [
      {
        id: "outlinePlanner",
        kind: "agent",
        dependsOn: [],
        definition: {
          kind: "agent",
          model: "fake/small",
          thinkingLevel: "off",
          interactive: false,
          // biome-ignore lint/suspicious/noTemplateCurlyInString: workflow reference syntax
          task: "Create a 2-chapter outline for theme '${inputs.novelTheme}' and write outline.json",
          outputs: ["outline.json"],
        },
        schemas: {
          "outline.json": {
            type: "array",
            items: {
              type: "object",
              properties: {
                chapterNumber: { type: "number" },
                title: { type: "string" },
                summary: { type: "string" },
              },
              required: ["chapterNumber", "title", "summary"],
            },
          },
        },
      },
      {
        id: "chaptersForeach",
        kind: "foreach",
        dependsOn: ["outlinePlanner"],
        // biome-ignore lint/suspicious/noTemplateCurlyInString: workflow reference syntax
        source: "${nodes.outlinePlanner.outline.json}",
        nodes: [
          {
            id: "writeChapter",
            kind: "agent",
            dependsOn: [],
            writable: true,
            definition: {
              kind: "agent",
              model: "fake/small",
              thinkingLevel: "off",
              interactive: false,
              // biome-ignore lint/suspicious/noTemplateCurlyInString: workflow reference syntax
              task: "Draft chapter ${item.chapterNumber}: '${item.title}' based on summary '${item.summary}'. Write manuscript to chapters/chapter-${item.chapterNumber}.txt and record stats in chapter.json",
              outputs: ["chapter.json"],
            },
            schemas: {
              "chapter.json": {
                type: "object",
                properties: {
                  chapterNumber: { type: "number" },
                  wordCount: { type: "number" },
                  done: { type: "boolean" },
                },
                required: ["done"],
              },
            },
          },
          {
            id: "verifyChapter",
            kind: "command",
            dependsOn: ["writeChapter"],
            writable: false,
            definition: {
              kind: "command",
              command: [
                "node -e",
                '\'const fs=require("fs"); const c=process.argv[1]; const p="chapters/chapter-" + c + ".txt"; if (!fs.existsSync(p) || fs.statSync(p).size === 0) { console.error("Missing chapter file:", p); process.exit(1); } console.log("Verified chapter file exists:", p);\'',
                `'\${${"item.chapterNumber"}}'`,
              ].join(" "),
              allowNonZeroExit: false,
            },
          },
        ],
      },
    ],
  },
  layout: {
    outlinePlanner: { x: 260, y: 40 },
    chaptersForeach: { x: 180, y: 220, width: 440, height: 380 },
    writeChapter: { x: 40, y: 60 },
    verifyChapter: { x: 40, y: 220 },
  },
};

export const BUILTIN_EXAMPLES: ExampleWorkflowItem[] = [
  AIPILOT_EXAMPLE_WORKFLOW,
  NOVEL_EXAMPLE_WORKFLOW,
];
