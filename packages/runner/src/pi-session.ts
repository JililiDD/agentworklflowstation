import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  readStoredCredential,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import { Type } from "typebox";
import { isRateLimitOrTimeout, ModelApiError } from "./retry.ts";
import type {
  AgentSessionHandle,
  CreateSessionOptions,
  SessionAdapter,
} from "./session-adapter.ts";
import type { Answer, Question, StepEvent, TokenUsage } from "./types.ts";

const CODEX_ACCOUNTS = join(
  homedir(),
  ".pi/agent/extensions/codex-accounts/index.ts",
);

const questionParams = Type.Object({
  prompt: Type.String({ minLength: 1 }),
  options: Type.Array(
    Type.Object({
      id: Type.String({ minLength: 1 }),
      label: Type.String({ minLength: 1 }),
    }),
  ),
});

async function askUntilAborted(
  ask: (question: Question, signal?: AbortSignal) => Promise<Answer>,
  question: Question,
  signal: AbortSignal | undefined,
): Promise<Answer> {
  if (signal === undefined) return ask(question);
  if (signal.aborted) throw new Error("question aborted");
  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error("question aborted"));
  });
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    if (signal.aborted) throw new Error("question aborted");
    return await Promise.race([ask(question, signal), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export type CredentialStore = NonNullable<
  NonNullable<Parameters<typeof ModelRuntime.create>[0]>["credentials"]
>;

export function createFileCredentialStore(authPath: string): CredentialStore {
  return {
    async read(providerId, options) {
      if (options?.signal?.aborted) throw new Error("aborted");
      try {
        const text = await readFile(authPath, "utf8");
        const data = JSON.parse(text) as Record<string, CredentialStore>;
        return data[providerId] as unknown as NonNullable<
          Parameters<Parameters<CredentialStore["modify"]>[1]>[0]
        >;
      } catch {
        return undefined;
      }
    },
    async list(options) {
      if (options?.signal?.aborted) throw new Error("aborted");
      try {
        const text = await readFile(authPath, "utf8");
        const data = JSON.parse(text) as Record<string, unknown>;
        return Object.entries(data).map(([providerId, cred]) => ({
          providerId,
          type:
            (cred as { type?: "api_key" | "oauth" }).type ??
            ("api_key" as const),
        }));
      } catch {
        return [];
      }
    },
    async modify(providerId, fn, options) {
      if (options?.signal?.aborted) throw new Error("aborted");
      const parent = dirname(authPath);
      await mkdir(parent, { recursive: true });
      if (!existsSync(authPath)) {
        await writeFile(authPath, "{}", { encoding: "utf8", mode: 0o600 });
      }
      const release = await lockfile.lock(authPath, {
        realpath: false,
        retries: 10,
      });
      try {
        if (options?.signal?.aborted) throw new Error("aborted");
        let data: Record<string, unknown> = {};
        try {
          const text = await readFile(authPath, "utf8");
          data = JSON.parse(text) as Record<string, unknown>;
        } catch {
          data = {};
        }
        const current = data[providerId] as
          | Parameters<Parameters<CredentialStore["modify"]>[1]>[0]
          | undefined;
        const next = await fn(current);
        if (next === undefined) {
          delete data[providerId];
        } else {
          data[providerId] = next;
        }
        await writeFile(authPath, `${JSON.stringify(data, null, 2)}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
        return next;
      } finally {
        await release();
      }
    },
    async delete(providerId, options) {
      await this.modify(providerId, async () => undefined, options);
    },
  };
}

/** Only the selected credential enters this runtime. Shared auth writes back under lock. */
export function scopedCredentials(
  provider: string,
  source?: typeof readStoredCredential | CredentialStore,
): CredentialStore {
  if (typeof source === "object" && source !== null && "modify" in source) {
    const baseStore = source as CredentialStore;
    return {
      async read(id, options) {
        if (id !== provider) return undefined;
        return baseStore.read(id, options);
      },
      async list(options) {
        const all = await baseStore.list(options);
        return all.filter((c) => c.providerId === provider);
      },
      async modify(id, fn, options) {
        if (id !== provider) {
          throw new Error("credential provider is outside this node");
        }
        return baseStore.modify(id, fn, options);
      },
      async delete(id, options) {
        if (id !== provider) {
          throw new Error("credential provider is outside this node");
        }
        return baseStore.delete(id, options);
      },
    };
  }

  const readCredential =
    typeof source === "function" ? source : readStoredCredential;
  let credential = readCredential(provider);
  return {
    async read(id) {
      return id === provider ? credential : undefined;
    },
    async list() {
      return credential === undefined
        ? []
        : [{ providerId: provider, type: credential.type }];
    },
    async modify(id, update) {
      if (id !== provider) {
        throw new Error("credential provider is outside this node");
      }
      credential = (await update(credential)) ?? credential;
      return credential;
    },
    async delete(id) {
      if (id !== provider) {
        throw new Error("credential provider is outside this node");
      }
      credential = undefined;
    },
  };
}

function usageFromUnknown(value: unknown): TokenUsage | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.input !== "number" || typeof record.output !== "number")
    return undefined;
  const usage: TokenUsage = {
    inputTokens: record.input,
    outputTokens: record.output,
  };
  if (typeof record.cacheRead === "number")
    usage.cacheReadTokens = record.cacheRead;
  if (typeof record.cacheWrite === "number")
    usage.cacheWriteTokens = record.cacheWrite;
  return usage;
}

export function createPiSessionAdapter(adapterOptions?: {
  authPath?: string;
  baseStore?: CredentialStore;
}): SessionAdapter {
  const baseStore =
    adapterOptions?.baseStore ??
    (adapterOptions?.authPath
      ? createFileCredentialStore(adapterOptions.authPath)
      : undefined);

  return {
    async createSession(
      options: CreateSessionOptions,
    ): Promise<AgentSessionHandle> {
      const isolated = await mkdtemp(join(tmpdir(), "runner-pi-"));
      const runtime = await ModelRuntime.create({
        credentials: scopedCredentials(options.modelProvider, baseStore),
        ...(adapterOptions?.authPath
          ? { authPath: adapterOptions.authPath }
          : {}),
      });
      let model = runtime.getModel(options.modelProvider, options.modelId);
      const isCodexAccount = /^codex[A-Za-z0-9_-]+$/.test(
        options.modelProvider,
      );
      const loader = new DefaultResourceLoader({
        cwd: isolated,
        agentDir: isolated,
        noExtensions: true,
        noSkills: true,
        noContextFiles: true,
        noPromptTemplates: true,
        noThemes: true,
        additionalExtensionPaths: isCodexAccount ? [CODEX_ACCOUNTS] : [],
        systemPromptOverride: () => options.systemPrompt,
        appendSystemPromptOverride: () => [],
      });
      await loader.reload();
      if (model === undefined && isCodexAccount) {
        // The account extension registers its model when a session starts.
        const bootstrap = runtime.getModel("anthropic", "claude-haiku-5-5");
        if (bootstrap === undefined)
          throw new Error("bootstrap model not found");
        const boot = await createAgentSession({
          model: bootstrap,
          modelRuntime: runtime,
          resourceLoader: loader,
          tools: [],
          cwd: isolated,
          sessionManager: SessionManager.inMemory(isolated),
          settingsManager: SettingsManager.inMemory({
            retry: { enabled: false },
          }),
        });
        boot.session.dispose();
        model = runtime.getModel(options.modelProvider, options.modelId);
      }
      if (model === undefined) {
        throw new Error(
          `model not found: ${options.modelProvider}/${options.modelId}`,
        );
      }
      const ask = options.ask;
      const askTool: ToolDefinition<typeof questionParams> = {
        name: "ask_user",
        label: "Ask User",
        description:
          "Ask the user a question with optional choices, then wait for their answer.",
        parameters: questionParams,
        executionMode: "sequential",
        async execute(_callId, params, signal) {
          if (signal?.aborted) throw new Error("question aborted");
          if (ask === undefined)
            throw new Error("asking is disabled for this node");
          const answer = await askUntilAborted(ask, params, signal);
          return {
            content: [{ type: "text", text: JSON.stringify(answer) }],
            details: {},
          };
        },
      };
      const created = await createAgentSession({
        cwd: options.workDir,
        model,
        thinkingLevel: options.thinkingLevel,
        modelRuntime: runtime,
        resourceLoader: loader,
        tools:
          ask === undefined ? ["read", "write"] : ["read", "write", "ask_user"],
        customTools: ask === undefined ? [] : [askTool],
        sessionManager: SessionManager.inMemory(options.workDir),
        settingsManager: SettingsManager.inMemory({
          retry: { enabled: false },
          compaction: { enabled: false },
        }),
      });
      const session = created.session;
      return {
        id: isolated,
        rates: model.cost,
        async prompt(
          text: string,
          onEvent: (event: StepEvent) => void,
          signal: AbortSignal,
        ): Promise<void> {
          const unsubscribe = session.subscribe((event) => {
            if (event.type === "message_end") {
              const message = "message" in event ? event.message : undefined;
              const raw =
                message && typeof message === "object" && "usage" in message
                  ? (message as { usage?: unknown }).usage
                  : undefined;
              const usage = usageFromUnknown(raw);
              if (usage !== undefined) {
                onEvent({
                  type: "model",
                  at: new Date().toISOString(),
                  summary: "model turn",
                  usage,
                });
              }
            }
            if (event.type === "tool_execution_start") {
              onEvent({
                type: "tool",
                at: new Date().toISOString(),
                summary: "tool start",
              });
            }
          });
          const abort = () => {
            void session.abort();
          };
          signal.addEventListener("abort", abort, { once: true });
          try {
            if (signal.aborted) throw new Error("node aborted");
            try {
              await session.prompt(text);
            } catch (error) {
              if (!isRateLimitOrTimeout(error)) throw error;
              const details =
                typeof error === "object" && error !== null
                  ? (error as { status?: unknown; code?: unknown })
                  : {};
              throw new ModelApiError(
                error instanceof Error ? error.message : String(error),
                typeof details.status === "number" ? details.status : undefined,
                typeof details.code === "string" ? details.code : undefined,
                { cause: error },
              );
            }
            const last = [...session.messages]
              .reverse()
              .find((message) => message.role === "assistant");
            if (
              last?.role === "assistant" &&
              (last.stopReason === "error" || last.stopReason === "aborted")
            ) {
              if (last.stopReason === "error") {
                throw new ModelApiError(last.errorMessage ?? "model API error");
              }
              throw new Error(last.errorMessage ?? "model aborted");
            }
          } finally {
            signal.removeEventListener("abort", abort);
            unsubscribe();
          }
        },
        async dispose() {
          session.dispose();
        },
      };
    },
  };
}
