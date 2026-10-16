#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  createAgentRunner,
  createPiSessionAdapter,
} from "@aipilotagent/runner";
import { AuthManager, getDefaultAuthPath } from "./auth-manager.ts";
import { createPlatformHttpServer } from "./http-server.ts";
import { RunManager } from "./run-manager.ts";
import { getDataDir } from "./storage.ts";

export function openBrowser(url: string): void {
  const isWindows = process.platform === "win32";
  const isMac = process.platform === "darwin";
  const cmd = isWindows ? "cmd" : isMac ? "open" : "xdg-open";
  const args = isWindows ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.unref();
  } catch {
    // Ignore browser open errors (e.g. in headless or non-desktop environments)
  }
}

function parseArgs(): {
  port: number;
  host: string;
  dataDir?: string;
  authPath?: string;
  staticDir?: string;
  open: boolean;
} {
  const args = process.argv.slice(2);
  let port = 3000;
  let host = "127.0.0.1";
  let dataDir: string | undefined;
  let authPath: string | undefined;
  let staticDir: string | undefined;
  let open = true;

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
    } else if (arg === "--static-dir" && args[i + 1]) {
      staticDir = args[++i];
    } else if (arg === "--no-open") {
      open = false;
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

  return { port, host, dataDir, authPath, staticDir, open };
}

export async function runServer(): Promise<void> {
  const { port, host, dataDir, authPath, staticDir, open } = parseArgs();
  const resolvedDataDir = getDataDir(dataDir);
  const resolvedAuthPath = authPath ?? getDefaultAuthPath();

  const candidateStaticDir =
    staticDir ??
    (existsSync(join(import.meta.dirname, "../../web/dist"))
      ? join(import.meta.dirname, "../../web/dist")
      : existsSync(join(process.cwd(), "packages/web/dist"))
        ? join(process.cwd(), "packages/web/dist")
        : undefined);

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
    staticDir: candidateStaticDir,
    runManager,
    authManager,
  });

  const actualPort = await server.start();
  const appUrl = `http://${host}:${actualPort}`;
  console.log(`aipilotAgent service running at ${appUrl}`);
  console.log(`Data directory: ${resolvedDataDir}`);
  console.log(`Auth storage: ${resolvedAuthPath}`);
  if (candidateStaticDir) {
    console.log(`Static assets: ${candidateStaticDir}`);
  }

  if (open && !process.env.CI && !process.env.AIPILOT_NO_OPEN) {
    openBrowser(appUrl);
  }

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
