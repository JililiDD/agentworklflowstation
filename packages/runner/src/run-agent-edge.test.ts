import assert from "node:assert/strict";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFakeSessionAdapter } from "./fake-session.ts";
import { createAgentRunner } from "./run-agent.ts";
import type { AgentNodeDefinition, StepEvent } from "./types.ts";

const definition: AgentNodeDefinition = {
  kind: "agent",
  model: "anthropic/claude-haiku-5-5",
  thinkingLevel: "low",
  task: "Write result",
  interactive: false,
  outputs: ["result.txt"],
};

async function run(
  adapter: ReturnType<typeof createFakeSessionAdapter>,
  events: StepEvent[],
  node = definition,
) {
  const outputDir = await mkdtemp(join(tmpdir(), "runner-edge-"));
  const result = await createAgentRunner(adapter).runAgent(node, {
    outputDir,
    workDir: outputDir,
    signal: new AbortController().signal,
    providerSecret: "secret-test-123",
    callbacks: {
      onEvent: (event) => {
        events.push(event);
      },
    },
  });
  return { result, outputDir };
}

test("streams all model/tool events and sums usage across calls", async () => {
  const adapter = createFakeSessionAdapter();
  adapter.nextEvents = [
    {
      type: "model",
      at: "2026-10-15T00:00:00Z",
      summary: "first",
      usage: { inputTokens: 100, outputTokens: 10 },
    },
    { type: "tool", at: "2026-10-15T00:00:01Z", summary: "write" },
    {
      type: "model",
      at: "2026-10-15T00:00:02Z",
      summary: "second",
      usage: { inputTokens: 50, outputTokens: 5 },
    },
  ];
  adapter.onPrompt = async (dir) => {
    await writeFile(join(dir, "out", "result.txt"), "ok");
  };
  const events: StepEvent[] = [];
  const { result, outputDir } = await run(adapter, events);
  assert.equal(result.status, "succeeded");
  assert.deepEqual(
    events.map((event) => event.type),
    ["model", "tool", "model"],
  );
  assert.equal(result.usage.inputTokens, 150);
  assert.equal(result.usage.outputTokens, 15);
  assert.equal(result.usage.costUsd, 0.000225);
  assert.equal(
    (await readFile(join(outputDir, "events.jsonl"), "utf8")).trim().split("\n")
      .length,
    3,
  );
});

test("keeps earlier usage and redacts a credential in failure records", async () => {
  const adapter = createFakeSessionAdapter();
  adapter.onPrompt = async () => {
    throw new Error("request failed: secret-test-123");
  };
  const { result, outputDir } = await run(adapter, []);
  assert.equal(result.status, "failed");
  assert.equal(result.usage.inputTokens, 10);
  assert.equal(result.error, "request failed: [redacted]");
  assert.doesNotMatch(
    await readFile(join(outputDir, "events.jsonl"), "utf8"),
    /secret-test-123/,
  );
});

test("rejects an out/ symlink before starting a session", async () => {
  const adapter = createFakeSessionAdapter();
  const outputDir = await mkdtemp(join(tmpdir(), "runner-symlink-"));
  const elsewhere = await mkdtemp(join(tmpdir(), "runner-outside-"));
  await symlink(elsewhere, join(outputDir, "out"));
  await assert.rejects(
    () =>
      createAgentRunner(adapter).runAgent(definition, {
        outputDir,
        workDir: outputDir,
        signal: new AbortController().signal,
        callbacks: { onEvent() {} },
      }),
    /out\/ must be a real directory/,
  );
  assert.equal(adapter.sessionIds.length, 0);
});

test("requires a real declared output under out/", async () => {
  const adapter = createFakeSessionAdapter();
  const { result } = await run(adapter, []);
  assert.equal(result.status, "failed");
  assert.deepEqual(result.outputs, {});
  await assert.rejects(
    () => run(adapter, [], { ...definition, outputs: ["../escape.txt"] }),
    /invalid output file name/,
  );
});
