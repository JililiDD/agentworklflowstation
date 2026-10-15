import { spawn } from "node:child_process";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  CommandNodeDefinition,
  StepContext,
  StepResult,
} from "./types.ts";

const MAX_LOG_BYTES = 4 * 1024 * 1024;
const SAFE_ENV_NAMES = new Set([
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "SYSTEMROOT",
  "WINDIR",
]);

function commandEnvironment(secret: string | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!SAFE_ENV_NAMES.has(name) || value === undefined) continue;
    if (secret && value.includes(secret)) continue;
    env[name] = value;
  }
  return env;
}

function redact(text: string, secret: string | undefined): string {
  return secret ? text.replaceAll(secret, "[redacted]") : text;
}

export async function runCommandNode(
  definition: CommandNodeDefinition,
  context: StepContext,
): Promise<StepResult> {
  const outDir = join(context.outputDir, "out");
  await mkdir(outDir, { recursive: true });
  if (!(await lstat(outDir)).isDirectory()) {
    throw new Error("out/ must be a real directory");
  }
  const stdoutPath = join(outDir, "stdout.log");
  const stderrPath = join(outDir, "stderr.log");
  const exitPath = join(outDir, "exit-code.json");
  const outputs = {
    stdout: stdoutPath,
    stderr: stderrPath,
    exitCode: exitPath,
  };
  for (const path of Object.values(outputs)) {
    try {
      if (!(await lstat(path)).isFile()) {
        throw new Error(`command output must be a regular file: ${path}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let overflow = false;
  let spawnError: Error | undefined;
  const child = spawn(definition.command, {
    cwd: context.workDir,
    shell: true,
    detached: process.platform !== "win32",
    env: commandEnvironment(context.providerSecret),
    signal: context.signal,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const terminate = () => {
    if (process.platform !== "win32" && child.pid !== undefined) {
      try {
        process.kill(-child.pid, "SIGTERM");
        return;
      } catch {
        // Fall back to terminating the shell when its process group is gone.
      }
    }
    child.kill();
  };
  context.signal.addEventListener("abort", terminate, { once: true });
  const collect = (
    target: Buffer[],
    chunk: Buffer,
    current: number,
  ): number => {
    if (current + chunk.length > MAX_LOG_BYTES) {
      overflow = true;
      terminate();
      return current;
    }
    target.push(chunk);
    return current + chunk.length;
  };
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBytes = collect(stdout, chunk, stdoutBytes);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes = collect(stderr, chunk, stderrBytes);
  });
  const { exitCode, signal } = await new Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.on("error", (error) => {
      spawnError = error;
    });
    child.on("close", (exitCode, signal) => resolve({ exitCode, signal }));
  });
  context.signal.removeEventListener("abort", terminate);
  await Promise.all([
    writeFile(
      stdoutPath,
      redact(Buffer.concat(stdout).toString("utf8"), context.providerSecret),
    ),
    writeFile(
      stderrPath,
      redact(Buffer.concat(stderr).toString("utf8"), context.providerSecret),
    ),
    writeFile(exitPath, `${JSON.stringify({ exitCode, signal }, null, 2)}\n`),
  ]);
  const succeeded =
    spawnError === undefined &&
    !overflow &&
    signal === null &&
    (exitCode === 0 || (definition.allowNonZeroExit && exitCode !== null));
  const reason =
    spawnError?.message ??
    (overflow
      ? "command log limit exceeded"
      : signal !== null
        ? `command terminated by ${signal}`
        : `command exited with code ${exitCode}`);
  const summary = succeeded
    ? `command exited with code ${exitCode}`
    : redact(reason, context.providerSecret);
  context.callbacks.onEvent({
    type: succeeded ? "tool" : "error",
    at: new Date().toISOString(),
    summary,
  });
  return {
    status: succeeded ? "succeeded" : "failed",
    outputs,
    usage: { inputTokens: 0, outputTokens: 0 },
    ...(succeeded ? {} : { error: summary }),
  };
}
