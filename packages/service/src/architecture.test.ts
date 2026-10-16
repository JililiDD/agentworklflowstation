import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const rootDir = resolve(import.meta.dirname, "../../..");
const depcruiseBin = join(rootDir, "node_modules/.bin/depcruise");

test("architecture dependency test confirms runner and engine have no illegal reverse dependencies", () => {
  const result = spawnSync(
    depcruiseBin,
    [
      "--config",
      join(rootDir, ".dependency-cruiser.cjs"),
      "packages/runner",
      "packages/engine",
      "packages/service",
      "packages/web/src",
    ],
    {
      cwd: rootDir,
      encoding: "utf8",
    },
  );

  assert.equal(
    result.status,
    0,
    `depcruise failed with errors:\n${result.stdout}\n${result.stderr}`,
  );
  assert.match(result.stdout, /no dependency violations found/);
});

test("architecture dependency test fails when an illegal reverse dependency is introduced", async () => {
  const temp = await mkdtemp(join(tmpdir(), "aipilot-arch-test-"));
  const runnerFile = join(temp, "runner-fake.js");
  const engineFile = join(temp, "engine-fake.js");
  const configFile = join(temp, ".dependency-cruiser.cjs");

  await writeFile(
    configFile,
    `module.exports = {
      forbidden: [
        {
          name: "runner-no-engine",
          severity: "error",
          from: { path: "runner" },
          to: { path: "engine" }
        }
      ]
    };`,
  );

  await writeFile(engineFile, "export const engine = 'engine';\n");
  // Illegal reverse dependency: runner imports engine
  await writeFile(
    runnerFile,
    "import { engine } from './engine-fake.js';\nexport const runner = engine;\n",
  );

  const result = spawnSync(depcruiseBin, ["--config", configFile, runnerFile], {
    cwd: temp,
    encoding: "utf8",
  });

  // Must fail with status !== 0
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /runner-no-engine/);

  await rm(temp, { recursive: true, force: true });
});
