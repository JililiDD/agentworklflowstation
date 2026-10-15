import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFakeSessionAdapter } from "./fake-session.ts";
import { ModelApiError, type RetryClock } from "./retry.ts";
import { createAgentRunner } from "./run-agent.ts";
import type { AgentNodeDefinition, StepEvent } from "./types.ts";

const definition: AgentNodeDefinition = {
  kind: "agent",
  model: "anthropic/claude-haiku-5-5",
  thinkingLevel: "low",
  task: "Write a file",
  interactive: false,
  outputs: ["result.txt"],
};

function fakeClock(random = 0.5) {
  const delays: number[] = [];
  const clock: RetryClock = {
    random: () => random,
    async sleep(ms, signal) {
      assert.equal(signal.aborted, false);
      delays.push(ms);
    },
  };
  return { clock, delays };
}

async function run(
  failures: Error[],
  clock: RetryClock,
  signal: AbortSignal = new AbortController().signal,
) {
  const adapter = createFakeSessionAdapter();
  adapter.failures.push(...failures);
  adapter.onPrompt = async (dir) => {
    await writeFile(join(dir, "out", "result.txt"), "ok");
  };
  const runner = createAgentRunner(adapter, clock);
  const outputDir = await mkdtemp(join(tmpdir(), "runner-retry-"));
  const events: StepEvent[] = [];
  const result = await runner.runAgent(definition, {
    outputDir,
    workDir: outputDir,
    signal,
    callbacks: {
      onEvent(event) {
        events.push(event);
      },
    },
  });
  await runner.dispose();
  return { result, events, adapter, outputDir };
}

test("two API rate limits retry after 2s and 4s, then succeed", async () => {
  const { clock, delays } = fakeClock();
  const { result, events, adapter, outputDir } = await run(
    [
      new ModelApiError("HTTP 429 rate limit"),
      new ModelApiError("too many requests", 429),
    ],
    clock,
  );
  assert.equal(result.status, "succeeded");
  assert.deepEqual(delays, [2000, 4000]);
  assert.equal(adapter.sentPrompts.length, 3);
  assert.equal(
    new Set(adapter.sentPrompts.map((item) => item.sessionId)).size,
    1,
  );
  assert.deepEqual(
    events
      .filter((event) => event.type === "retry")
      .map((event) => event.summary),
    ["model API retry 1/3 after 2000ms", "model API retry 2/3 after 4000ms"],
  );
  const jsonl = (await readFile(join(outputDir, "events.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(jsonl.filter((event) => event.type === "retry").length, 2);
  assert.equal(result.usage.inputTokens, 30);
});

test("timeout retries are capped at three, with 2/4/8s waits", async () => {
  const { clock, delays } = fakeClock();
  const { result, events, adapter } = await run(
    [
      new ModelApiError("request timeout"),
      new ModelApiError("timed out"),
      new ModelApiError("HTTP 408 timeout", 408),
      new ModelApiError("request timeout"),
    ],
    clock,
  );
  assert.equal(result.status, "failed");
  assert.deepEqual(delays, [2000, 4000, 8000]);
  assert.equal(adapter.sentPrompts.length, 4);
  assert.equal(events.filter((event) => event.type === "retry").length, 3);
});

test("other errors and exhausted quota fail immediately", async () => {
  for (const failure of [
    new Error("tool timed out"),
    new ModelApiError("insufficient_quota HTTP 429", 429),
    new ModelApiError("bad request", 400),
  ]) {
    const { clock, delays } = fakeClock();
    const { result, events, adapter } = await run([failure], clock);
    assert.equal(result.status, "failed");
    assert.deepEqual(delays, []);
    assert.equal(events.filter((event) => event.type === "retry").length, 0);
    assert.equal(adapter.sentPrompts.length, 1);
  }
});

test("abort during backoff prevents another model call", async () => {
  const controller = new AbortController();
  const clock: RetryClock = {
    random: () => 0.5,
    async sleep() {
      controller.abort();
    },
  };
  const { result, adapter, events } = await run(
    [new ModelApiError("HTTP 429 rate limit")],
    clock,
    controller.signal,
  );
  assert.equal(result.status, "failed");
  assert.equal(adapter.sentPrompts.length, 1);
  assert.equal(events.filter((event) => event.type === "retry").length, 1);
});

test("jitter is bounded to plus or minus twenty percent", async () => {
  for (const [random, expected] of [
    [0, 1600],
    [1, 2400],
  ] as const) {
    const { clock, delays } = fakeClock(random);
    const { result } = await run([new ModelApiError("rate limit")], clock);
    assert.equal(result.status, "succeeded");
    assert.deepEqual(delays, [expected]);
  }
});
