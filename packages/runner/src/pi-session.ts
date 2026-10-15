import { mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  readStoredCredential,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentSessionHandle,
  CreateSessionOptions,
  SessionAdapter,
} from "./session-adapter.ts";
import type { StepEvent, TokenUsage } from "./types.ts";

const CODEX_ACCOUNTS = join(
  homedir(),
  ".pi/agent/extensions/codex-accounts/index.ts",
);

type CredentialStore = NonNullable<
  NonNullable<Parameters<typeof ModelRuntime.create>[0]>["credentials"]
>;

/** Only the selected credential enters this runtime. OAuth refresh stays in memory. */
export function scopedCredentials(
  provider: string,
  readCredential: typeof readStoredCredential = readStoredCredential,
): CredentialStore {
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

export function createPiSessionAdapter(): SessionAdapter {
  return {
    async createSession(
      options: CreateSessionOptions,
    ): Promise<AgentSessionHandle> {
      const isolated = await mkdtemp(join(tmpdir(), "runner-pi-"));
      const runtime = await ModelRuntime.create({
        credentials: scopedCredentials(options.modelProvider),
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
      const created = await createAgentSession({
        cwd: options.workDir,
        model,
        thinkingLevel: options.thinkingLevel,
        modelRuntime: runtime,
        resourceLoader: loader,
        tools: ["read", "write"],
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
          options.signal.addEventListener("abort", abort, { once: true });
          try {
            if (options.signal.aborted) throw new Error("node aborted");
            await session.prompt(text);
            const last = [...session.messages]
              .reverse()
              .find((message) => message.role === "assistant");
            if (
              last?.role === "assistant" &&
              (last.stopReason === "error" || last.stopReason === "aborted")
            ) {
              throw new Error(last.errorMessage ?? `model ${last.stopReason}`);
            }
          } finally {
            options.signal.removeEventListener("abort", abort);
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
