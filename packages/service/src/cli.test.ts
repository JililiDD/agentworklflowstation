import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach, beforeEach } from "node:test";

let tempDir: string;
let authPath: string;
let dataDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "aipilot-cli-test-"));
  authPath = join(tempDir, "auth.json");
  dataDir = join(tempDir, "data");
  await writeFile(authPath, "{}");
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

test("CLI rejects non-loopback host option with security error", async () => {
  const cliPath = join(import.meta.dirname, "cli.ts");
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", cliPath, "--host", "192.168.1.50"],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stderr = "";
  child.stderr.on("data", (d: Buffer) => {
    stderr += d.toString("utf8");
  });

  const exitCode = await new Promise<number>((resolve) => {
    child.on("exit", (code) => resolve(code ?? -1));
  });

  assert.equal(exitCode, 1);
  assert.match(
    stderr,
    /Security Error: aipilotAgent only accepts loopback host/,
  );
});

test("CLI starts service on loopback, serves requests, and shuts down on SIGTERM", async () => {
  const cliPath = join(import.meta.dirname, "cli.ts");
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      cliPath,
      "--port",
      "0",
      "--data-dir",
      dataDir,
      "--auth-path",
      authPath,
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stdout = "";
  child.stdout.on("data", (d: Buffer) => {
    stdout += d.toString("utf8");
  });

  // Wait for server to print listening URL
  let port: number | undefined;
  for (let i = 0; i < 50; i++) {
    const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(stdout);
    if (match?.[1]) {
      port = Number.parseInt(match[1], 10);
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(port, "port should be printed in stdout");

  // Health check request
  const res = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(res.status, 200);
  const data = (await res.json()) as Record<string, unknown>;
  assert.equal(data.status, "ok");

  // Send SIGTERM to shutdown
  child.kill("SIGTERM");

  const exitCode = await new Promise<number>((resolve) => {
    child.on("exit", (code) => resolve(code ?? -1));
  });
  assert.equal(exitCode, 0);
});
