import { readFile, stat } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, resolve } from "node:path";
import { URL } from "node:url";
import { AuthManager, getDefaultAuthPath } from "./auth-manager.ts";
import type { RunManager } from "./run-manager.ts";
import {
  getSettings,
  listSkillsFromSettings,
  saveSettings,
} from "./settings.ts";
import { assertNoPathTraversal, getDataDir } from "./storage.ts";
import {
  deleteWorkflow,
  getWorkflow,
  getWorkflowLayout,
  listWorkflows,
  saveWorkflow,
  saveWorkflowLayout,
  WorkflowConflictError,
  type WorkflowNodeLayout,
  WorkflowSafetyError,
} from "./workflow-library.ts";

export interface HttpServerOptions {
  dataDir?: string;
  authPath?: string;
  port?: number;
  host?: string;
  staticDir?: string;
  authManager?: AuthManager;
  runManager: RunManager;
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
};

const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2MB

function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  return (
    addr === "127.0.0.1" ||
    addr === "::1" ||
    addr === "::ffff:127.0.0.1" ||
    addr.startsWith("127.")
  );
}

function isLoopbackHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  try {
    const url = new URL(`http://${hostHeader}`);
    const hostname = url.hostname.toLowerCase();
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "[::1]" ||
      hostname.startsWith("127.")
    );
  } catch {
    return false;
  }
}

function isAllowedOrigin(originHeader: string | undefined): boolean {
  if (!originHeader) return true; // Direct tools like curl / CLI have no Origin
  try {
    const parsed = new URL(originHeader);
    return isLoopbackHost(parsed.host);
  } catch {
    return false;
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("payload too large (max 2MB)"));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        const bodyText = Buffer.concat(chunks).toString("utf8");
        resolve(JSON.parse(bodyText));
      } catch (_err) {
        reject(new Error("invalid JSON body"));
      }
    });

    req.on("error", reject);
  });
}

function sendJson(
  res: ServerResponse,
  statusCode: number,
  data: unknown,
): void {
  const json = JSON.stringify(data);
  const origin = res.req?.headers?.origin;
  const corsHeaders: Record<string, string> =
    origin && isAllowedOrigin(origin)
      ? { "Access-Control-Allow-Origin": origin }
      : {};
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
    ...corsHeaders,
  });
  res.end(json);
}

function sendError(
  res: ServerResponse,
  statusCode: number,
  message: string,
): void {
  sendJson(res, statusCode, { error: message });
}

export function createPlatformHttpServer(options: HttpServerOptions): {
  server: Server;
  start: () => Promise<number>;
  stop: () => Promise<void>;
  getPort: () => number;
} {
  const dataDir = getDataDir(options.dataDir);
  const authPath = options.authPath ?? getDefaultAuthPath();
  const authManager = options.authManager ?? new AuthManager({ authPath });
  const runManager = options.runManager;

  const server = createServer(async (req, res) => {
    // 1. AC-10: Loopback client check
    const remote = req.socket.remoteAddress;
    if (!isLoopbackAddress(remote)) {
      sendError(res, 403, "access forbidden: local machine loopback only");
      return;
    }

    // 2. AC-10: Host header check
    if (!isLoopbackHost(req.headers.host)) {
      sendError(res, 400, "invalid host header");
      return;
    }

    // 3. AC-10: Cross-site mutation check
    const origin = req.headers.origin;
    if (
      req.method !== "GET" &&
      req.method !== "HEAD" &&
      req.method !== "OPTIONS"
    ) {
      const checkOrigin = origin ?? (req.headers.referer as string | undefined);
      if (!isAllowedOrigin(checkOrigin)) {
        sendError(res, 403, "cross-site requests forbidden");
        return;
      }
    }

    // 4. CORS preflight
    if (req.method === "OPTIONS") {
      const corsHeaders: Record<string, string> =
        origin && isAllowedOrigin(origin)
          ? { "Access-Control-Allow-Origin": origin }
          : {};
      res.writeHead(204, {
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        ...corsHeaders,
      });
      res.end();
      return;
    }

    try {
      const url = new URL(
        req.url ?? "/",
        `http://${req.headers.host ?? "localhost"}`,
      );
      const pathname = url.pathname;
      const method = req.method ?? "GET";

      // Health
      if (pathname === "/api/health" && method === "GET") {
        sendJson(res, 200, { status: "ok" });
        return;
      }

      // Workflows
      if (pathname === "/api/workflows" && method === "GET") {
        const workflows = await listWorkflows(dataDir);
        sendJson(res, 200, workflows);
        return;
      }

      if (pathname === "/api/workflows" && method === "POST") {
        const body = (await readJsonBody(req)) as Record<string, unknown>;
        const id = body.id as string;
        const yaml = body.yaml as string | undefined;
        const updatedObject = body.updatedObject as
          | Record<string, unknown>
          | undefined;
        const expectedYaml = body.expectedYaml as string | undefined;
        const layout = body.layout as
          | Record<string, WorkflowNodeLayout>
          | undefined;
        if (!id || typeof id !== "string") {
          sendError(res, 400, "id is required");
          return;
        }
        if (!yaml && !updatedObject) {
          sendError(res, 400, "either yaml or updatedObject is required");
          return;
        }
        try {
          const result = await saveWorkflow({
            dataDir,
            id,
            yamlText: yaml,
            updatedObject,
            expectedYaml,
            layout,
          });
          sendJson(res, 201, result);
        } catch (err) {
          if (err instanceof WorkflowSafetyError) {
            sendError(res, 422, err.message);
          } else if (err instanceof WorkflowConflictError) {
            sendError(res, 409, err.message);
          } else {
            sendError(
              res,
              400,
              err instanceof Error ? err.message : String(err),
            );
          }
        }
        return;
      }

      const layoutMatch = /^\/api\/workflows\/([^/]+)\/layout$/.exec(pathname);
      if (layoutMatch) {
        const id = decodeURIComponent(layoutMatch[1] ?? "");
        if (method === "GET") {
          const layoutData = await getWorkflowLayout(dataDir, id);
          sendJson(res, 200, layoutData ?? { version: 1, current: {} });
          return;
        }
        if (method === "PUT") {
          const body = (await readJsonBody(req)) as Record<string, unknown>;
          const layout = (body.layout ?? body) as Record<
            string,
            WorkflowNodeLayout
          >;
          const saved = await saveWorkflowLayout(dataDir, id, layout);
          sendJson(res, 200, saved);
          return;
        }
      }

      const workflowMatch = /^\/api\/workflows\/([^/]+)$/.exec(pathname);
      if (workflowMatch) {
        const id = decodeURIComponent(workflowMatch[1] ?? "");
        if (method === "GET") {
          const wf = await getWorkflow(dataDir, id);
          sendJson(res, 200, wf);
          return;
        }
        if (method === "PUT") {
          const body = (await readJsonBody(req)) as Record<string, unknown>;
          const yaml = body.yaml as string | undefined;
          const updatedObject = body.updatedObject as
            | Record<string, unknown>
            | undefined;
          const expectedYaml = body.expectedYaml as string | undefined;
          const layout = body.layout as
            | Record<string, WorkflowNodeLayout>
            | undefined;
          if (!yaml && !updatedObject) {
            sendError(res, 400, "either yaml or updatedObject is required");
            return;
          }
          try {
            const result = await saveWorkflow({
              dataDir,
              id,
              yamlText: yaml,
              updatedObject,
              expectedYaml,
              layout,
            });
            sendJson(res, 200, result);
          } catch (err) {
            if (err instanceof WorkflowSafetyError) {
              sendError(res, 422, err.message);
            } else if (err instanceof WorkflowConflictError) {
              sendError(res, 409, err.message);
            } else {
              sendError(
                res,
                400,
                err instanceof Error ? err.message : String(err),
              );
            }
          }
          return;
        }
        if (method === "DELETE") {
          await deleteWorkflow(dataDir, id);
          sendJson(res, 200, { ok: true });
          return;
        }
      }

      // Settings & Skills
      if (pathname === "/api/settings" && method === "GET") {
        const settings = await getSettings(dataDir);
        sendJson(res, 200, settings);
        return;
      }

      if (pathname === "/api/settings" && method === "PUT") {
        const body = await readJsonBody(req);
        const settings = await saveSettings(dataDir, body);
        sendJson(res, 200, settings);
        return;
      }

      if (pathname === "/api/skills" && method === "GET") {
        const skills = await listSkillsFromSettings(dataDir);
        sendJson(res, 200, skills);
        return;
      }

      // Auth
      if (pathname === "/api/auth/providers" && method === "GET") {
        const providers = await authManager.listProviders();
        sendJson(res, 200, providers);
        return;
      }

      if (pathname === "/api/auth/login" && method === "POST") {
        const body = (await readJsonBody(req)) as Record<string, unknown>;
        const provider = body.provider as string;
        const authType = (body.authType as "oauth" | "api_key") ?? "oauth";
        if (!provider || typeof provider !== "string") {
          sendError(res, 400, "provider is required");
          return;
        }
        const session = await authManager.startLogin(provider, authType);
        sendJson(res, 200, session);
        return;
      }

      const loginSessionMatch = /^\/api\/auth\/login\/([^/]+)$/.exec(pathname);
      if (loginSessionMatch && method === "GET") {
        const loginId = decodeURIComponent(loginSessionMatch[1] ?? "");
        const session = authManager.getLoginSession(loginId);
        if (!session) {
          sendError(res, 404, `login session not found: ${loginId}`);
          return;
        }
        sendJson(res, 200, session);
        return;
      }

      const loginRespondMatch = /^\/api\/auth\/login\/([^/]+)\/respond$/.exec(
        pathname,
      );
      if (loginRespondMatch && method === "POST") {
        const loginId = decodeURIComponent(loginRespondMatch[1] ?? "");
        const body = (await readJsonBody(req)) as Record<string, unknown>;
        const responseText = body.response as string;
        if (typeof responseText !== "string") {
          sendError(res, 400, "response string is required");
          return;
        }
        const session = await authManager.respondLogin(loginId, responseText);
        sendJson(res, 200, session);
        return;
      }

      const loginCancelMatch = /^\/api\/auth\/login\/([^/]+)\/cancel$/.exec(
        pathname,
      );
      if (loginCancelMatch && method === "POST") {
        const loginId = decodeURIComponent(loginCancelMatch[1] ?? "");
        const session = await authManager.cancelLogin(loginId);
        sendJson(res, 200, session);
        return;
      }

      if (pathname === "/api/auth/api-key" && method === "POST") {
        const body = (await readJsonBody(req)) as Record<string, unknown>;
        const provider = body.provider as string;
        const key = body.key as string;
        if (!provider || typeof provider !== "string") {
          sendError(res, 400, "provider is required");
          return;
        }
        if (!key || typeof key !== "string") {
          sendError(res, 400, "key is required");
          return;
        }
        await authManager.setApiKey(provider, key);
        sendJson(res, 200, { ok: true, providerId: provider });
        return;
      }

      if (pathname === "/api/auth/logout" && method === "POST") {
        const body = (await readJsonBody(req)) as Record<string, unknown>;
        const provider = body.provider as string;
        if (!provider || typeof provider !== "string") {
          sendError(res, 400, "provider is required");
          return;
        }
        await authManager.logout(provider);
        sendJson(res, 200, { ok: true, providerId: provider });
        return;
      }

      // Runs
      if (pathname === "/api/runs" && method === "GET") {
        const runs = await runManager.listRuns();
        sendJson(res, 200, runs);
        return;
      }

      if (pathname === "/api/runs/validate" && method === "POST") {
        const body = (await readJsonBody(req)) as Record<string, unknown>;
        const targetRepo = body.targetRepo as string;
        const workflowId = body.workflowId as string | undefined;
        const workflowYaml = body.workflowYaml as string | undefined;
        const inputs = (body.inputs as Record<string, string>) ?? {};

        const validation = await runManager.validateRunSetup({
          targetRepo,
          workflowId,
          workflowYaml,
          inputs,
        });
        sendJson(res, 200, validation);
        return;
      }

      if (pathname === "/api/runs" && method === "POST") {
        const body = (await readJsonBody(req)) as Record<string, unknown>;
        const targetRepo = body.targetRepo as string;
        const inputs = (body.inputs as Record<string, string>) ?? {};
        const workflowId = body.workflowId as string | undefined;
        const workflowYaml = body.workflowYaml as string | undefined;
        const budgetUsd =
          typeof body.budgetUsd === "number" ? body.budgetUsd : undefined;

        if (!targetRepo || typeof targetRepo !== "string") {
          sendError(res, 400, "targetRepo is required");
          return;
        }
        if (!workflowId && !workflowYaml) {
          sendError(res, 400, "either workflowId or workflowYaml is required");
          return;
        }

        const result = await runManager.startRun({
          targetRepo,
          inputs,
          workflowId,
          workflowYaml,
          budgetUsd,
        });
        sendJson(res, 201, result);
        return;
      }

      const runMatch = /^\/api\/runs\/([^/]+)$/.exec(pathname);
      if (runMatch && method === "GET") {
        const runId = decodeURIComponent(runMatch[1] ?? "");
        const run = await runManager.getRun(runId);
        sendJson(res, 200, run);
        return;
      }

      const runStopMatch = /^\/api\/runs\/([^/]+)\/stop$/.exec(pathname);
      if (runStopMatch && method === "POST") {
        const runId = decodeURIComponent(runStopMatch[1] ?? "");
        await runManager.stopRun(runId);
        sendJson(res, 200, { ok: true, runId });
        return;
      }

      const runResumeMatch = /^\/api\/runs\/([^/]+)\/resume$/.exec(pathname);
      if (runResumeMatch && method === "POST") {
        const runId = decodeURIComponent(runResumeMatch[1] ?? "");
        const body = (await readJsonBody(req)) as Record<string, unknown>;
        const newBudgetUsd =
          typeof body.newBudgetUsd === "number" ? body.newBudgetUsd : undefined;
        const result = await runManager.resumeRun(runId, { newBudgetUsd });
        sendJson(res, 200, result);
        return;
      }

      const runDefinitionMatch = /^\/api\/runs\/([^/]+)\/definition$/.exec(
        pathname,
      );
      if (runDefinitionMatch && method === "GET") {
        const runId = decodeURIComponent(runDefinitionMatch[1] ?? "");
        const def = await runManager.getRunDefinition(runId);
        sendJson(res, 200, def);
        return;
      }

      const runPreviewMatch = /^\/api\/runs\/([^/]+)\/preview$/.exec(pathname);
      if (runPreviewMatch && method === "GET") {
        const runId = decodeURIComponent(runPreviewMatch[1] ?? "");
        const nodePath = url.searchParams.get("nodePath") ?? "";
        const kind = (url.searchParams.get("kind") ?? "output") as
          | "diff"
          | "output"
          | "task";
        const fileName = url.searchParams.get("fileName") ?? undefined;
        const preview = await runManager.getRunPreview(runId, {
          nodePath,
          kind,
          fileName,
        });
        sendJson(res, 200, preview);
        return;
      }

      const runInteractionsMatch = /^\/api\/runs\/([^/]+)\/interactions$/.exec(
        pathname,
      );
      if (runInteractionsMatch && method === "GET") {
        const runId = decodeURIComponent(runInteractionsMatch[1] ?? "");
        const interactions = await runManager.getRunInteractions(runId);
        sendJson(res, 200, interactions);
        return;
      }

      const runEventsMatch = /^\/api\/runs\/([^/]+)\/events$/.exec(pathname);
      if (runEventsMatch && method === "GET") {
        const runId = decodeURIComponent(runEventsMatch[1] ?? "");
        const isStream = url.searchParams.get("stream") === "true";

        if (isStream) {
          const corsHeaders: Record<string, string> =
            origin && isAllowedOrigin(origin)
              ? { "Access-Control-Allow-Origin": origin }
              : {};
          // SSE streaming
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            ...corsHeaders,
          });

          // First send already persisted events
          const initialEvents = await runManager.getRunEvents(runId);
          for (const ev of initialEvents) {
            res.write(`data: ${JSON.stringify(ev)}\n\n`);
          }

          // Finding 2: check if run is already finished or non-active
          const runState = await runManager
            .getRun(runId)
            .catch(() => undefined);
          if (
            !runState ||
            runState.status === "succeeded" ||
            runState.status === "failed" ||
            runState.status === "aborted" ||
            runState.status === "budget_exceeded"
          ) {
            res.end();
            return;
          }

          // Then subscribe to live events
          const unsubscribe = runManager.subscribeEvents(runId, (event) => {
            res.write(`data: ${JSON.stringify(event)}\n\n`);
            if (event.type === "run_finished") {
              res.end();
            }
          });

          req.on("close", () => {
            unsubscribe();
          });
          return;
        }

        // Return array of events
        const events = await runManager.getRunEvents(runId);
        sendJson(res, 200, events);
        return;
      }

      const questionAnswerMatch =
        /^\/api\/runs\/([^/]+)\/questions\/([^/]+)$/.exec(pathname);
      if (questionAnswerMatch && method === "POST") {
        const runId = decodeURIComponent(questionAnswerMatch[1] ?? "");
        const nodePath = decodeURIComponent(questionAnswerMatch[2] ?? "");
        const body = (await readJsonBody(req)) as Record<string, unknown>;
        const optionId =
          typeof body.optionId === "string"
            ? body.optionId
            : typeof body.selectedId === "string"
              ? body.selectedId
              : undefined;
        const text =
          typeof body.text === "string" ? body.text : (optionId ?? "");
        const secret = Boolean(body.secret);
        const answer = {
          text,
          ...(optionId ? { optionId } : {}),
        };
        await runManager.answerQuestion(runId, nodePath, answer, { secret });
        sendJson(res, 200, { ok: true, runId, nodePath, secret });
        return;
      }

      const approvalMatch = /^\/api\/runs\/([^/]+)\/approvals\/([^/]+)$/.exec(
        pathname,
      );
      if (approvalMatch && method === "POST") {
        const runId = decodeURIComponent(approvalMatch[1] ?? "");
        const nodePath = decodeURIComponent(approvalMatch[2] ?? "");
        const body = (await readJsonBody(req)) as Record<string, unknown>;
        const approved = Boolean(body.approved);
        const feedback =
          typeof body.feedback === "string" ? body.feedback : undefined;
        await runManager.handleApproval(runId, nodePath, {
          approved,
          feedback,
        });
        sendJson(res, 200, { ok: true, runId, nodePath, approved });
        return;
      }

      // Inbox
      if (pathname === "/api/inbox" && method === "GET") {
        const inbox = await runManager.getInbox();
        sendJson(res, 200, inbox);
        return;
      }

      // Static files (Web UI)
      if (
        options.staticDir &&
        (method === "GET" || method === "HEAD") &&
        !pathname.startsWith("/api/")
      ) {
        const rawUrl = req.url ?? "";
        if (
          rawUrl.includes("..") ||
          decodeURIComponent(rawUrl).includes("..") ||
          pathname.includes("..") ||
          decodeURIComponent(pathname).includes("..")
        ) {
          sendError(res, 403, "forbidden");
          return;
        }

        const staticBase = resolve(options.staticDir);
        const decodedPath = decodeURIComponent(pathname);
        const relPath =
          pathname === "/" ? "index.html" : decodedPath.replace(/^\/+/, "");
        let targetFile = join(staticBase, relPath);
        try {
          assertNoPathTraversal(staticBase, targetFile);
        } catch {
          sendError(res, 403, "forbidden");
          return;
        }

        let fileStat = await stat(targetFile).catch(() => undefined);
        if (!fileStat?.isFile()) {
          // SPA fallback for HTML requests
          targetFile = join(staticBase, "index.html");
          fileStat = await stat(targetFile).catch(() => undefined);
        }

        if (fileStat?.isFile()) {
          const ext = extname(targetFile).toLowerCase();
          const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
          const data = await readFile(targetFile);
          const corsHeaders: Record<string, string> =
            origin && isAllowedOrigin(origin)
              ? { "Access-Control-Allow-Origin": origin }
              : {};
          res.writeHead(200, {
            "Content-Type": contentType,
            "Content-Length": data.length,
            ...corsHeaders,
          });
          if (method === "HEAD") {
            res.end();
          } else {
            res.end(data);
          }
          return;
        }
      }

      sendError(res, 404, `endpoint not found: ${method} ${pathname}`);
    } catch (error) {
      sendError(
        res,
        500,
        error instanceof Error ? error.message : "internal server error",
      );
    }
  });

  return {
    server,
    start(): Promise<number> {
      return new Promise((resolve, reject) => {
        const port = options.port ?? 0;
        const host = options.host ?? "127.0.0.1";
        server.listen(port, host, () => {
          const addr = server.address() as AddressInfo;
          resolve(addr.port);
        });
        server.on("error", reject);
      });
    },
    stop(): Promise<void> {
      return new Promise((resolve, reject) => {
        if (
          "closeAllConnections" in server &&
          typeof server.closeAllConnections === "function"
        ) {
          server.closeAllConnections();
        }
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
    getPort(): number {
      const addr = server.address() as AddressInfo | null;
      return addr ? addr.port : 0;
    },
  };
}
