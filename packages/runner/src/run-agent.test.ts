import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFakeSessionAdapter } from "./fake-session.ts";
import { createAgentRunner } from "./run-agent.ts";
import type { AgentNodeDefinition, StepContext, StepEvent } from "./types.ts";

const secret = "fake-provider-secret-xyz";

function definition(): AgentNodeDefinition {
  return {
    kind: "agent",
    model: "anthropic/claude-haiku-5-5",
    thinkingLevel: "low",
    task: "Write ok",
    instructions: "Be brief",
    interactive: false,
    outputs: ["result.txt"],
  };
}

async function makeContext(
  outputDir: string,
  events: StepEvent[],
): Promise<StepContext> {
  return {
    outputDir,
    workDir: outputDir,
    signal: new AbortController().signal,
    providerSecret: secret,
    callbacks: {
      onEvent(event) {
        events.push(event);
      },
    },
  };
}

async function textFilesContain(
  directory: string,
  needle: string,
): Promise<boolean> {
  const names = await readdir(directory, { recursive: true });
  for (const name of names) {
    const path = join(directory, name);
    try {
      const text = await readFile(path, "utf8");
      if (text.includes(needle)) {
        return true;
      }
    } catch {
      // skip non-text
    }
  }
  return false;
}

test("writes task.md, events, usage, and uses a new session each run", async () => {
  const adapter = createFakeSessionAdapter();
  adapter.onPrompt = async (workDir) => {
    await writeFile(join(workDir, "out", "result.txt"), "OK\n");
  };
  const runner = createAgentRunner(adapter);
  const outputDir = await mkdtemp(join(tmpdir(), "runner-agent-"));
  const events: StepEvent[] = [];
  const result = await runner.runAgent(
    definition(),
    await makeContext(outputDir, events),
  );
  assert.equal(result.status, "succeeded");
  assert.equal(
    result.outputs["result.txt"],
    join(outputDir, "out", "result.txt"),
  );
  const task = await readFile(join(outputDir, "task.md"), "utf8");
  assert.match(task, /Write ok/);
  assert.match(task, /Be brief/);
  const jsonl = await readFile(join(outputDir, "events.jsonl"), "utf8");
  const parsed = jsonl
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as StepEvent);
  assert.equal(parsed[0]?.type, "model");
  assert.equal(parsed[0]?.usage?.inputTokens, 10);
  assert.equal(parsed[0]?.usage?.costUsd, 0.00003);
  assert.equal(result.usage.costUsd, 0.00003);
  const secondDir = await mkdtemp(join(tmpdir(), "runner-agent-2-"));
  await runner.runAgent(definition(), await makeContext(secondDir, []));
  assert.equal(adapter.sessionIds.length, 2);
  assert.notEqual(adapter.sessionIds[0], adapter.sessionIds[1]);
});

test("does not leak the provider secret and passes one provider", async () => {
  const adapter = createFakeSessionAdapter();
  adapter.onPrompt = async (workDir) => {
    await writeFile(join(workDir, "out", "result.txt"), "OK\n");
  };
  const runner = createAgentRunner(adapter);
  const outputDir = await mkdtemp(join(tmpdir(), "runner-secret-"));
  await runner.runAgent(definition(), await makeContext(outputDir, []));
  assert.equal(adapter.receivedCredentials.length, 1);
  assert.equal(adapter.receivedCredentials[0]?.provider, "anthropic");
  assert.equal(adapter.receivedCredentials[0]?.secret, secret);
  assert.equal(await textFilesContain(outputDir, secret), false);
});
