#!/usr/bin/env node
import {
  createAgentRunner,
  createPiSessionAdapter,
} from "@aipilotagent/runner";
import { AuthManager, getDefaultAuthPath } from "./auth-manager.ts";
import { createPlatformHttpServer } from "./http-server.ts";
import { RunManager } from "./run-manager.ts";
import { getDataDir } from "./storage.ts";

function parseArgs(): {
  port: number;
  host: string;
  dataDir?: string;
  authPath?: string;
} {
  const args = process.argv.slice(2);
  let port = 3000;
  let host = "127.0.0.1";
  let dataDir: string | undefined;
  let authPath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--port" && args[i + 1]) {
      port = Number.parseInt(args[++i] ?? "3000", 10);
    } else if (arg === "--host" && args[i + 1]) {
      host = args[++i] ?? "127.0.0.1";
    } else if (arg === "--data-dir" && args[i + 1]) {
      dataDir = args[++i];
    } else if (arg === "--auth-path" && args[i + 1]) {
      authPath = args[++i];
    }
  }

  // AC-10: Restrict host to loopback
  if (
    host !== "127.0.0.1" &&
    host !== "localhost" &&
    host !== "::1" &&
    !host.startsWith("127.")
  ) {
    console.error(
      "Security Error: aipilotAgent only accepts loopback host (127.0.0.1 / localhost)",
    );
    process.exit(1);
  }

  return { port, host, dataDir, authPath };
}

export async function runServer(): Promise<void> {
  const { port, host, dataDir, authPath } = parseArgs();
  const resolvedDataDir = getDataDir(dataDir);
  const resolvedAuthPath = authPath ?? getDefaultAuthPath();

  const sessionAdapter = createPiSessionAdapter({
    authPath: resolvedAuthPath,
  });
  const runner = createAgentRunner(sessionAdapter);

  const runManager = new RunManager({
    dataDir: resolvedDataDir,
    runner,
  });

  // AC-9: Recover interrupted runs from previous process exit
  await runManager.recoverInterruptedRunsOnStartup();

  const authManager = new AuthManager({
    authPath: resolvedAuthPath,
  });

  const server = createPlatformHttpServer({
    dataDir: resolvedDataDir,
    authPath: resolvedAuthPath,
    port,
    host,
    runManager,
    authManager,
  });

  const actualPort = await server.start();
  console.log(`aipilotAgent service running at http://${host}:${actualPort}`);
  console.log(`Data directory: ${resolvedDataDir}`);
  console.log(`Auth storage: ${resolvedAuthPath}`);

  let stopping = false;
  const onSignal = async () => {
    if (stopping) return;
    stopping = true;
    console.log("\nShutting down aipilotAgent service...");
    await runManager.stopAllRuns();
    await server.stop();
    process.exit(0);
  };

  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}

if (
  process.argv[1]?.endsWith("cli.ts") ||
  process.argv[1]?.endsWith("cli.js")
) {
  runServer().catch((err) => {
    console.error("Fatal server error:", err);
    process.exit(1);
  });
}
