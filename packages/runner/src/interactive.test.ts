import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFakeSessionAdapter } from "./fake-session.ts";
import { createAgentRunner } from "./run-agent.ts";
import type { AgentNodeDefinition, Question, StepEvent } from "./types.ts";

const question: Question = {
  prompt: "Which format should I use?",
  options: [
    { id: "md", label: "Markdown" },
    { id: "txt", label: "Plain text" },
  ],
};
const definition: AgentNodeDefinition = {
  kind: "agent",
  model: "anthropic/claude-haiku-5-5",
  thinkingLevel: "low",
  task: "Write a draft",
  interactive: true,
  outputs: ["result.txt"],
};

async function context(
  outputDir: string,
  events: StepEvent[],
  ask?: (value: Question) => Promise<{ text: string; optionId?: string }>,
) {
  return {
    outputDir,
    workDir: outputDir,
    signal: new AbortController().signal,
    callbacks: {
      onEvent(event: StepEvent) {
        events.push(event);
      },
      ...(ask === undefined ? {} : { ask }),
    },
  };
}

test("interactive agent asks through the same session and records question and answer", async () => {
  const adapter = createFakeSessionAdapter();
  adapter.nextQuestion = question;
  adapter.onPrompt = async (dir) => {
    await writeFile(join(dir, "out", "result.txt"), "draft");
  };
  const runner = createAgentRunner(adapter);
  const outputDir = await mkdtemp(join(tmpdir(), "runner-interactive-"));
  const events: StepEvent[] = [];
  const asked: Question[] = [];
  const result = await runner.runAgent(
    definition,
    await context(outputDir, events, async (value) => {
      asked.push(value);
      return { text: "Markdown", optionId: "md" };
    }),
  );
  assert.equal(result.status, "succeeded");
  assert.deepEqual(adapter.askEnabled, [true]);
  assert.deepEqual(asked, [question]);
  assert.deepEqual(adapter.answers, [{ text: "Markdown", optionId: "md" }]);
  assert.deepEqual(
    events.map((event) => event.type),
    ["model", "tool", "question", "answer"],
  );
  const logged = (await readFile(join(outputDir, "events.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.deepEqual(
    logged.map((event) => event.type),
    ["model", "tool", "question", "answer"],
  );
  assert.match(logged[2].summary, /Which format/);
  assert.equal(logged[3].summary, "selected option md");
  assert.deepEqual(adapter.disposedSessionIds, []);
  await runner.dispose();
  assert.deepEqual(adapter.disposedSessionIds, adapter.sessionIds);
});

test("free-text answer reaches the model but not the event log", async () => {
  const adapter = createFakeSessionAdapter();
  adapter.nextQuestion = { prompt: "Enter a value", options: [] };
  adapter.onPrompt = async (dir) => {
    await writeFile(join(dir, "out", "result.txt"), "ok");
  };
  const runner = createAgentRunner(adapter);
  const outputDir = await mkdtemp(join(tmpdir(), "runner-free-answer-"));
  await runner.runAgent(
    definition,
    await context(outputDir, [], async () => ({
      text: "private-answer-example",
    })),
  );
  assert.deepEqual(adapter.answers, [{ text: "private-answer-example" }]);
  const events = await readFile(join(outputDir, "events.jsonl"), "utf8");
  assert.match(events, /free-text answer submitted/);
  assert.doesNotMatch(events, /private-answer-example/);
  await runner.dispose();
});

test("an aborted question does not record a late answer", async () => {
  const adapter = createFakeSessionAdapter();
  adapter.nextQuestion = question;
  const runner = createAgentRunner(adapter);
  const outputDir = await mkdtemp(join(tmpdir(), "runner-aborted-answer-"));
  const controller = new AbortController();
  const ctx = await context(outputDir, [], async () => {
    controller.abort();
    return { text: "late reply" };
  });
  ctx.signal = controller.signal;
  const result = await runner.runAgent(definition, ctx);
  assert.equal(result.status, "failed");
  assert.deepEqual(adapter.answers, []);
  const log = await readFile(join(outputDir, "events.jsonl"), "utf8");
  assert.match(log, /question/);
  assert.doesNotMatch(log, /late reply/);
  await runner.dispose();
});

test("non-interactive node cannot ask even when its caller offers a callback", async () => {
  const adapter = createFakeSessionAdapter();
  adapter.nextQuestion = question;
  adapter.onPrompt = async (dir) => {
    await writeFile(join(dir, "out", "result.txt"), "draft");
  };
  const runner = createAgentRunner(adapter);
  const outputDir = await mkdtemp(join(tmpdir(), "runner-noninteractive-"));
  const events: StepEvent[] = [];
  let calls = 0;
  const result = await runner.runAgent(
    { ...definition, interactive: false },
    await context(outputDir, events, async () => {
      calls += 1;
      return { text: "Markdown" };
    }),
  );
  assert.equal(result.status, "succeeded");
  assert.deepEqual(adapter.askEnabled, [false]);
  assert.equal(calls, 0);
  assert.deepEqual(
    events.map((event) => event.type),
    ["model"],
  );
  await runner.dispose();
});

test("interactive continuation sends its question to the current caller", async () => {
  const adapter = createFakeSessionAdapter();
  adapter.onPrompt = async (dir) => {
    await writeFile(join(dir, "out", "result.txt"), "ok");
  };
  const runner = createAgentRunner(adapter);
  const outputDir = await mkdtemp(join(tmpdir(), "runner-ask-again-"));
  let originalCalls = 0;
  await runner.runAgent(
    definition,
    await context(outputDir, [], async () => {
      originalCalls += 1;
      return { text: "old" };
    }),
  );
  adapter.nextQuestion = question;
  let newCalls = 0;
  const result = await runner.continueAgent(
    "Ask me now",
    await context(outputDir, [], async () => {
      newCalls += 1;
      return { text: "Markdown", optionId: "md" };
    }),
  );
  assert.equal(result.status, "succeeded");
  assert.equal(originalCalls, 0);
  assert.equal(newCalls, 1);
  assert.deepEqual(adapter.answers, [{ text: "Markdown", optionId: "md" }]);
  assert.equal(
    adapter.sentPrompts[0]?.sessionId,
    adapter.sentPrompts[1]?.sessionId,
  );
  await runner.dispose();
});

test("a failed node keeps its session for a corrective continuation", async () => {
  const adapter = createFakeSessionAdapter();
  adapter.onPrompt = async (dir, text) => {
    if (text === "Create the missing output") {
      await writeFile(join(dir, "out", "result.txt"), "repaired");
    }
  };
  const runner = createAgentRunner(adapter);
  const outputDir = await mkdtemp(join(tmpdir(), "runner-repair-"));
  const first = await runner.runAgent(
    { ...definition, interactive: false },
    await context(outputDir, []),
  );
  assert.equal(first.status, "failed");
  const next = await runner.continueAgent(
    "Create the missing output",
    await context(outputDir, []),
  );
  assert.equal(next.status, "succeeded");
  assert.equal(adapter.sessionIds.length, 1);
  assert.equal(
    await readFile(join(outputDir, "out", "result.txt"), "utf8"),
    "repaired",
  );
  await runner.dispose();
});

test("continuation uses the same session, appends records, and repairs output", async () => {
  const adapter = createFakeSessionAdapter();
  adapter.onPrompt = async (dir, text) => {
    await writeFile(
      join(dir, "out", "result.txt"),
      text === "Correct the draft" ? "corrected" : "draft",
    );
  };
  const runner = createAgentRunner(adapter);
  const outputDir = await mkdtemp(join(tmpdir(), "runner-continue-"));
  const first = await runner.runAgent(
    { ...definition, interactive: false },
    await context(outputDir, []),
  );
  assert.equal(first.status, "succeeded");
  assert.deepEqual(adapter.disposedSessionIds, []);
  const continued = await runner.continueAgent(
    "Correct the draft",
    await context(outputDir, []),
  );
  assert.equal(continued.status, "succeeded");
  assert.equal(continued.usage.inputTokens, 10);
  assert.equal(
    await readFile(join(outputDir, "out", "result.txt"), "utf8"),
    "corrected",
  );
  assert.deepEqual(
    adapter.sentPrompts.map((item) => item.text),
    ["Write a draft", "Correct the draft"],
  );
  assert.equal(
    adapter.sentPrompts[0]?.sessionId,
    adapter.sentPrompts[1]?.sessionId,
  );
  assert.equal(adapter.sessionIds.length, 1);
  assert.match(
    await readFile(join(outputDir, "task.md"), "utf8"),
    /## Continuation\n\nCorrect the draft/,
  );
  assert.equal(
    (await readFile(join(outputDir, "events.jsonl"), "utf8")).trim().split("\n")
      .length,
    2,
  );
  await runner.dispose();
  const nextContext = await context(outputDir, []);
  await assert.rejects(
    () => runner.continueAgent("again", nextContext),
    /no agent session/,
  );
});
