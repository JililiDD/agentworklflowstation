import { appendFile, lstat, mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { usageWithCost } from "./cost.ts";
import { splitModelRef } from "./load-definition.ts";
import type { AgentSessionHandle, SessionAdapter } from "./session-adapter.ts";
import { buildSkillPrompt, resolveSkills } from "./skills.ts";
import type {
  AgentNodeDefinition,
  Answer,
  CommandNodeDefinition,
  Question,
  StepContext,
  StepEvent,
  StepResult,
  StepRunner,
  TokenUsage,
} from "./types.ts";

interface ActiveAgent {
  definition: AgentNodeDefinition;
  session: AgentSessionHandle;
  workDir: string;
  activate(context: StepContext, emit: (event: StepEvent) => void): void;
  inFlight: boolean;
}

function emptyUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0 };
}

async function appendEvent(outputDir: string, event: StepEvent): Promise<void> {
  await appendFile(
    join(outputDir, "events.jsonl"),
    `${JSON.stringify(event)}\n`,
  );
}

function requireAsk(
  context: StepContext,
  definition: AgentNodeDefinition,
): void {
  if (definition.interactive && context.callbacks.ask === undefined) {
    throw new Error("interactive node requires an ask callback");
  }
}

async function runTurn(
  active: ActiveAgent,
  instruction: string,
  context: StepContext,
): Promise<StepResult> {
  if (active.inFlight) throw new Error("agent session is already running");
  active.inFlight = true;
  let usage = emptyUsage();
  let writes = Promise.resolve();
  const emit = (event: StepEvent) => {
    const summary = context.providerSecret
      ? event.summary.replaceAll(context.providerSecret, "[redacted]")
      : event.summary;
    const priced: StepEvent =
      event.usage === undefined
        ? { ...event, summary }
        : {
            ...event,
            summary,
            usage: usageWithCost(event.usage, active.session.rates),
          };
    if (priced.usage !== undefined) {
      usage = {
        inputTokens: usage.inputTokens + priced.usage.inputTokens,
        outputTokens: usage.outputTokens + priced.usage.outputTokens,
        cacheReadTokens:
          (usage.cacheReadTokens ?? 0) + (priced.usage.cacheReadTokens ?? 0),
        cacheWriteTokens:
          (usage.cacheWriteTokens ?? 0) + (priced.usage.cacheWriteTokens ?? 0),
        ...(priced.usage.costUsd === undefined
          ? {}
          : { costUsd: (usage.costUsd ?? 0) + priced.usage.costUsd }),
      };
    }
    writes = writes.then(() => appendEvent(context.outputDir, priced));
    context.callbacks.onEvent(priced);
  };
  active.activate(context, emit);
  try {
    await active.session.prompt(instruction, emit, context.signal);
    await writes;
    const outputs: Record<string, string> = {};
    for (const name of active.definition.outputs) {
      const file = join(context.outputDir, "out", name);
      const info = await lstat(file);
      if (!info.isFile())
        throw new Error(`output is not a regular file: ${name}`);
      outputs[name] = file;
    }
    return { status: "succeeded", outputs, usage };
  } catch (error) {
    await writes;
    const rawMessage = error instanceof Error ? error.message : String(error);
    const message = context.providerSecret
      ? rawMessage.replaceAll(context.providerSecret, "[redacted]")
      : rawMessage;
    emit({ type: "error", at: new Date().toISOString(), summary: message });
    await writes;
    return { status: "failed", outputs: {}, usage, error: message };
  } finally {
    active.inFlight = false;
  }
}

export function createAgentRunner(adapter: SessionAdapter): StepRunner {
  const agents = new Map<string, ActiveAgent>();
  return {
    async runAgent(
      definition: AgentNodeDefinition,
      context: StepContext,
    ): Promise<StepResult> {
      requireAsk(context, definition);
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
      const prior = agents.get(context.outputDir);
      if (prior !== undefined) {
        if (prior.inFlight) throw new Error("agent session is already running");
        await prior.session.dispose();
        agents.delete(context.outputDir);
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
      const taskText = [definition.task, definition.instructions]
        .filter((part): part is string => part !== undefined)
        .join("\n\n");
      await writeFile(join(context.outputDir, "task.md"), taskText);
      const systemPrompt = [
        "Write declared outputs under the out/ directory.",
        buildSkillPrompt(skills),
        ...(definition.interactive
          ? [
              "If you need user input, call ask_user with a question and optional choices.",
            ]
          : []),
      ]
        .filter((part) => part.length > 0)
        .join("\n\n");
      let currentContext = context;
      let currentEmit: (event: StepEvent) => void = () => {
        throw new Error("question outside an agent turn");
      };
      const ask = definition.interactive
        ? async (question: Question, signal?: AbortSignal): Promise<Answer> => {
            if (signal?.aborted) throw new Error("question aborted");
            currentEmit({
              type: "question",
              at: new Date().toISOString(),
              summary: question.prompt,
            });
            const answer = await currentContext.callbacks.ask?.(question);
            if (signal?.aborted) throw new Error("question aborted");
            if (answer === undefined || typeof answer.text !== "string") {
              throw new Error("question was not answered");
            }
            if (
              answer.optionId !== undefined &&
              !question.options.some((item) => item.id === answer.optionId)
            ) {
              throw new Error("answer optionId is not in the question");
            }
            currentEmit({
              type: "answer",
              at: new Date().toISOString(),
              summary: answer.optionId
                ? `selected option ${answer.optionId}`
                : "free-text answer submitted",
            });
            return answer;
          }
        : undefined;
      const session = await adapter.createSession({
        modelProvider: provider,
        modelId: id,
        thinkingLevel: definition.thinkingLevel,
        systemPrompt,
        ...(ask === undefined ? {} : { ask }),
        credentials: { provider, secret: context.providerSecret ?? "" },
        workDir: context.workDir,
      });
      const active: ActiveAgent = {
        definition,
        session,
        workDir: context.workDir,
        inFlight: false,
        activate(nextContext, emit) {
          currentContext = nextContext;
          currentEmit = emit;
        },
      };
      agents.set(context.outputDir, active);
      return runTurn(active, taskText, context);
    },
    async continueAgent(
      instruction: string,
      context: StepContext,
    ): Promise<StepResult> {
      const active = agents.get(context.outputDir);
      if (active === undefined) throw new Error("no agent session to continue");
      if (context.workDir !== active.workDir)
        throw new Error("workDir changed during continuation");
      if (instruction.trim().length === 0)
        throw new Error("continuation instruction is empty");
      requireAsk(context, active.definition);
      if (active.inFlight) throw new Error("agent session is already running");
      await appendFile(
        join(context.outputDir, "task.md"),
        `\n\n## Continuation\n\n${instruction}`,
      );
      return runTurn(active, instruction, context);
    },
    async runCommand(
      _definition: CommandNodeDefinition,
      _context: StepContext,
    ): Promise<StepResult> {
      throw new Error("command nodes are not implemented");
    },
    async dispose(): Promise<void> {
      const sessions = [...agents.values()];
      if (sessions.some((item) => item.inFlight))
        throw new Error("agent session is still running");
      agents.clear();
      await Promise.all(sessions.map((item) => item.session.dispose()));
    },
  };
}
