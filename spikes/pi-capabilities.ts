// throwaway: Phase 1 capability probe against pi SDK 1.3.0
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { Type } from "typebox";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

type PremiseResult = {
  id: string;
  ok: boolean;
  detail: string;
};

const results: PremiseResult[] = [];
const CODEX_ACCOUNTS = "/home/ddxy/.pi/agent/extensions/codex-accounts/index.ts";

function record(id: string, ok: boolean, detail: string): void {
  results.push({ id, ok, detail });
  console.log(`[${ok ? "PASS" : "FAIL"}] ${id}: ${detail}`);
}

async function makeLoader() {
  const isolated = await mkdtemp(join(tmpdir(), "aipilot-spike-"));
  const loader = new DefaultResourceLoader({
    cwd: isolated,
    agentDir: isolated,
    noSkills: true,
    noContextFiles: true,
    noPromptTemplates: true,
    noThemes: true,
    additionalExtensionPaths: [CODEX_ACCOUNTS],
    systemPromptOverride: () => "You are a test probe. Be brief. Use tools when asked.",
    appendSystemPromptOverride: () => [],
  });
  await loader.reload();
  return { loader, isolated };
}

async function runProvider(label: string, provider: string, modelId: string): Promise<void> {
  const modelRuntime = await ModelRuntime.create();
  const { loader } = await makeLoader();
  let model = modelRuntime.getModel(provider, modelId);
  if (!model && provider !== "anthropic") {
    const haiku = modelRuntime.getModel("anthropic", "claude-haiku-5-5");
    if (haiku) {
      const boot = await createAgentSession({
        model: haiku,
        thinkingLevel: "low",
        modelRuntime,
        resourceLoader: loader,
        tools: ["read"],
        sessionManager: SessionManager.inMemory(),
      });
      model = modelRuntime.getModel(provider, modelId);
      boot.session.dispose();
    }
  }
  if (!model) {
    record(`P1:${label}`, false, `${provider}/${modelId} not found after loading extensions`);
    return;
  }
  record(
    `P7:${label}`,
    typeof model.cost?.input === "number" && typeof model.cost?.output === "number",
    `cost=${JSON.stringify(model.cost)}`,
  );

  const probeFile = join(tmpdir(), "aipilot-spike-probe.txt");
  await writeFile(probeFile, "SPIKEOK\n");

  let askWaitedMs = 0;
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false, maxRetries: 0 },
  });
  record(
    `P9:${label}`,
    settingsManager.getSettings().retry?.enabled === false,
    `retry.enabled=${String(settingsManager.getSettings().retry?.enabled)}`,
  );

  const { session } = await createAgentSession({
    model,
    thinkingLevel: "low",
    modelRuntime,
    resourceLoader: loader,
    tools: ["read", "wait_probe"],
    customTools: [
      {
        name: "wait_probe",
        label: "Wait Probe",
        description: "Wait a short time, then return ok.",
        parameters: Type.Object({}),
        execute: async () => {
          const started = Date.now();
          await new Promise((resolve) => setTimeout(resolve, 3000));
          askWaitedMs = Date.now() - started;
          return { content: [{ type: "text", text: "waited" }], details: {} };
        },
      },
    ],
    sessionManager: SessionManager.inMemory(),
    settingsManager,
  });

  try {
    record(
      `P1:${label}`,
      session.model?.provider === provider && session.thinkingLevel === "low",
      `model=${session.model?.provider}/${session.model?.id} thinking=${session.thinkingLevel}`,
    );
    record(
      `P2:${label}`,
      !/SKILL\.md/i.test(session.systemPrompt),
      "noSkills loader; system prompt has no SKILL.md",
    );
    const toolNames = session.getActiveToolNames();
    record(
      `tools:${label}`,
      toolNames.includes("read") && !toolNames.includes("bash") && toolNames.includes("wait_probe"),
      `tools=${toolNames.join(",")}`,
    );
    record(`P3:${label}`, toolNames.includes("wait_probe"), "custom async tool registered");

    const usages: unknown[] = [];
    session.subscribe((event) => {
      if (event.type === "message_end") {
        const message = "message" in event ? event.message : undefined;
        const usage =
          message && typeof message === "object" && "usage" in message
            ? (message as { usage?: unknown }).usage
            : undefined;
        if (usage) usages.push(usage);
      }
    });

    await session.prompt("Reply with the single word PONG and nothing else.");
    const first = session.getLastAssistantText() ?? "";
    record(`P4:${label}`, /pong/i.test(first), `first=${JSON.stringify(first).slice(0, 120)}`);
    record(
      `P4usage:${label}`,
      usages.length > 0,
      `usageEvents=${usages.length} sample=${JSON.stringify(usages[0]).slice(0, 200)}`,
    );

    await session.prompt("Reply with the single word PING and nothing else.");
    const second = session.getLastAssistantText() ?? "";
    record(`P5:${label}`, /ping/i.test(second), `second=${JSON.stringify(second).slice(0, 120)}`);

    await session.prompt(
      `Read the file at ${probeFile} using the read tool. Reply with only the file contents trimmed.`,
    );
    const readText = session.getLastAssistantText() ?? "";
    record(`P10:${label}`, /SPIKEOK/.test(readText), `read=${JSON.stringify(readText).slice(0, 120)}`);

    await session.prompt("Call wait_probe once, then reply with the single word DONE.");
    record(
      `P6:${label}`,
      askWaitedMs >= 2500,
      `async tool waited ${askWaitedMs}ms without aborting the session`,
    );
  } finally {
    session.dispose();
  }
}

record("P11", true, `node ${process.version} ran this TypeScript file without a prior build`);
record(
  "P8",
  true,
  "AgentSession.isRetryableError documents rate-limit and timeout as retryable; live 429 not forced",
);

try {
  await runProvider("anthropic", "anthropic", "claude-haiku-5-5");
} catch (error) {
  record("P1:anthropic", false, error instanceof Error ? error.message : String(error));
}

try {
  await runProvider("openai", "codexJ", "gpt-6-luna");
} catch (error) {
  record("P1:openai", false, error instanceof Error ? error.message : String(error));
}

console.log("\n=== conclusions ===");
for (const row of results) {
  console.log(`${row.id}\t${row.ok ? "yes" : "no"}\t${row.detail}`);
}
