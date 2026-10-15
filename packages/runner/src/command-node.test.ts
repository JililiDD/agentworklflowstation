import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFakeSessionAdapter } from "./fake-session.ts";
import { createAgentRunner } from "./run-agent.ts";
import type { CommandNodeDefinition, StepEvent, StepResult } from "./types.ts";

function nodeCommand(script: string): string {
  return `${JSON.stringify(process.execPath)} -e '${script}'`;
}

function outputPath(result: StepResult, name: string): string {
  const path = result.outputs[name];
  assert.ok(path);
  return path;
}

async function run(
  command: string,
  allowNonZeroExit: boolean,
  providerSecret?: string,
) {
  const outputDir = await mkdtemp(join(tmpdir(), "runner-command-"));
  const workDir = await mkdtemp(join(tmpdir(), "runner-command-work-"));
  const events: StepEvent[] = [];
  const adapter = createFakeSessionAdapter();
  const runner = createAgentRunner(adapter);
  const definition: CommandNodeDefinition = {
    kind: "command",
    command,
    allowNonZeroExit,
  };
  const result = await runner.runCommand(definition, {
    outputDir,
    workDir,
    signal: new AbortController().signal,
    callbacks: {
      onEvent(event) {
        events.push(event);
      },
    },
    ...(providerSecret === undefined ? {} : { providerSecret }),
  });
  await runner.dispose();
  return { result, events, workDir, adapter };
}

test("a disallowed nonzero exit fails and preserves logs and exit code", async () => {
  const { result, events, adapter } = await run(
    nodeCommand(
      'process.stdout.write("hello"); process.stderr.write("warning"); process.exit(7)',
    ),
    false,
  );
  assert.equal(result.status, "failed");
  assert.equal(await readFile(outputPath(result, "stdout"), "utf8"), "hello");
  assert.equal(await readFile(outputPath(result, "stderr"), "utf8"), "warning");
  assert.deepEqual(
    JSON.parse(await readFile(outputPath(result, "exitCode"), "utf8")),
    { exitCode: 7, signal: null },
  );
  assert.equal(events[0]?.type, "error");
  assert.deepEqual(adapter.sessionIds, []);
});

test("an allowed nonzero exit succeeds and retains the numeric exit code", async () => {
  const { result, events, workDir } = await run(
    nodeCommand("process.stdout.write(process.cwd()); process.exit(3)"),
    true,
  );
  assert.equal(result.status, "succeeded");
  assert.equal(await readFile(outputPath(result, "stdout"), "utf8"), workDir);
  assert.deepEqual(
    JSON.parse(await readFile(outputPath(result, "exitCode"), "utf8")),
    { exitCode: 3, signal: null },
  );
  assert.equal(events[0]?.type, "tool");
});

test("refuses pre-existing symlink outputs before starting a command", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "runner-command-symlink-"));
  const workDir = await mkdtemp(join(tmpdir(), "runner-command-symlink-work-"));
  const target = join(workDir, "keep.txt");
  await writeFile(target, "KEEP");
  await mkdir(join(outputDir, "out"));
  await symlink(target, join(outputDir, "out", "stdout.log"));
  const runner = createAgentRunner(createFakeSessionAdapter());
  await assert.rejects(
    () =>
      runner.runCommand(
        {
          kind: "command",
          command: nodeCommand('process.stdout.write("BAD")'),
          allowNonZeroExit: false,
        },
        {
          outputDir,
          workDir,
          signal: new AbortController().signal,
          callbacks: { onEvent() {} },
        },
      ),
    /regular file/,
  );
  assert.equal(await readFile(target, "utf8"), "KEEP");
  await runner.dispose();
});

test("oversized command logs fail without retaining unbounded output", {
  timeout: 10000,
}, async () => {
  const { result } = await run(
    nodeCommand('process.stdout.write("X".repeat(5 * 1024 * 1024))'),
    false,
  );
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /log limit exceeded/);
  const info = await stat(outputPath(result, "stdout"));
  assert.ok(info.size <= 4 * 1024 * 1024);
});

test("command environment excludes model credentials and fake secret", async () => {
  const secret = "test-model-credential-xyz";
  const previous = process.env.ANTHROPIC_API_KEY;
  const previousOther = process.env.FAKE_MODEL_TOKEN;
  process.env.ANTHROPIC_API_KEY = secret;
  process.env.FAKE_MODEL_TOKEN = secret;
  try {
    const { result } = await run(
      nodeCommand("process.stdout.write(JSON.stringify(process.env))"),
      false,
      secret,
    );
    const stdout = await readFile(outputPath(result, "stdout"), "utf8");
    const stderr = await readFile(outputPath(result, "stderr"), "utf8");
    assert.equal(result.status, "succeeded");
    assert.doesNotMatch(
      stdout + stderr,
      /test-model-credential-xyz|ANTHROPIC_API_KEY|FAKE_MODEL_TOKEN/,
    );
    assert.equal(JSON.parse(stdout).PATH !== undefined, true);
  } finally {
    if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previous;
    if (previousOther === undefined) delete process.env.FAKE_MODEL_TOKEN;
    else process.env.FAKE_MODEL_TOKEN = previousOther;
  }
});
