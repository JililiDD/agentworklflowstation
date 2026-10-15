import { lstat, mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { usageWithCost } from "./cost.ts";
import { splitModelRef } from "./load-definition.ts";
import type { SessionAdapter } from "./session-adapter.ts";
import { buildSkillPrompt, resolveSkills } from "./skills.ts";
import type {
  AgentNodeDefinition,
  CommandNodeDefinition,
  StepContext,
  StepEvent,
  StepResult,
  StepRunner,
  TokenUsage,
} from "./types.ts";

function emptyUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0 };
}

async function appendEvents(
  outputDir: string,
  events: StepEvent[],
): Promise<void> {
  if (events.length === 0) {
    return;
  }
  const lines = events.map((event) => JSON.stringify(event)).join("\n");
  await writeFile(join(outputDir, "events.jsonl"), `${lines}\n`, { flag: "a" });
}

export function createAgentRunner(adapter: SessionAdapter): StepRunner {
  return {
    async runAgent(
      definition: AgentNodeDefinition,
      context: StepContext,
    ): Promise<StepResult> {
      const outDir = join(context.outputDir, "out");
      for (const name of definition.outputs) {
        if (
          name !== basename(name) ||
          name === "." ||
          name === ".." ||
          name.length === 0
        ) {
          throw new Error(`invalid output file name: ${name}`);
        }
      }
      await mkdir(outDir, { recursive: true });
      if (!(await lstat(outDir)).isDirectory()) {
        throw new Error("out/ must be a real directory");
      }
      await writeFile(join(context.outputDir, "events.jsonl"), "");
      const { provider, id } = splitModelRef(definition.model);
      if (definition.skillNames?.length && !definition.skillSourceDir) {
        throw new Error("skillSourceDir is required for skillNames");
      }
      const skills =
        definition.skillSourceDir !== undefined && definition.skillNames
          ? await resolveSkills(
              definition.skillSourceDir,
              definition.skillNames,
            )
          : [];
      const skillPrompt = buildSkillPrompt(skills);
      const taskParts = [definition.task];
      if (definition.instructions !== undefined) {
        taskParts.push(definition.instructions);
      }
      const taskText = taskParts.join("\n\n");
      await writeFile(join(context.outputDir, "task.md"), taskText);
      const systemParts = [
        "Write declared outputs under the out/ directory.",
        skillPrompt,
      ].filter((part) => part.length > 0);
      const session = await adapter.createSession({
        modelProvider: provider,
        modelId: id,
        thinkingLevel: definition.thinkingLevel,
        systemPrompt: systemParts.join("\n\n"),
        credentials: { provider, secret: context.providerSecret ?? "" },
        workDir: context.workDir,
        signal: context.signal,
      });
      let usage = emptyUsage();
      let writes = Promise.resolve();
      const emit = (event: StepEvent) => {
        const priced: StepEvent =
          event.usage === undefined
            ? event
            : { ...event, usage: usageWithCost(event.usage, session.rates) };
        if (priced.usage !== undefined) {
          usage = {
            inputTokens: usage.inputTokens + priced.usage.inputTokens,
            outputTokens: usage.outputTokens + priced.usage.outputTokens,
            cacheReadTokens:
              (usage.cacheReadTokens ?? 0) +
              (priced.usage.cacheReadTokens ?? 0),
            cacheWriteTokens:
              (usage.cacheWriteTokens ?? 0) +
              (priced.usage.cacheWriteTokens ?? 0),
            ...(priced.usage.costUsd === undefined
              ? {}
              : { costUsd: (usage.costUsd ?? 0) + priced.usage.costUsd }),
          };
        }
        writes = writes.then(() => appendEvents(context.outputDir, [priced]));
        context.callbacks.onEvent(priced);
      };
      try {
        await session.prompt(taskText, emit);
        await writes;
        const outputs: Record<string, string> = {};
        for (const name of definition.outputs) {
          const file = join(outDir, name);
          const info = await lstat(file);
          if (!info.isFile())
            throw new Error(`output is not a regular file: ${name}`);
          outputs[name] = file;
        }
        return { status: "succeeded", outputs, usage };
      } catch (error) {
        await writes;
        const rawMessage =
          error instanceof Error ? error.message : String(error);
        const message = context.providerSecret
          ? rawMessage.replaceAll(context.providerSecret, "[redacted]")
          : rawMessage;
        emit({ type: "error", at: new Date().toISOString(), summary: message });
        await writes;
        return { status: "failed", outputs: {}, usage, error: message };
      } finally {
        await session.dispose();
      }
    },
    async runCommand(
      _definition: CommandNodeDefinition,
      _context: StepContext,
    ): Promise<StepResult> {
      throw new Error("command nodes are not implemented");
    },
    async continueAgent(
      _instruction: string,
      _context: StepContext,
    ): Promise<StepResult> {
      throw new Error("continueAgent is not implemented");
    },
  };
}
