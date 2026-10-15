import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import { readNodeDefinitionFile } from "./load-definition.ts";
import { createPiSessionAdapter } from "./pi-session.ts";
import { createAgentRunner } from "./run-agent.ts";
import type { Answer, Question, StepEvent, StepResult } from "./types.ts";

export async function askInTerminal(
  question: Question,
  readLine: (prompt: string) => Promise<string>,
  write: (line: string) => void,
): Promise<Answer> {
  write(`Question: ${question.prompt}\n`);
  for (const [index, option] of question.options.entries()) {
    write(`${index + 1}. ${option.label}\n`);
  }
  while (true) {
    const text = (await readLine("Answer: ")).trim();
    if (text.length === 0) {
      write("Please enter an answer.\n");
      continue;
    }
    const number = Number(text);
    if (/^\d+$/.test(text)) {
      const chosen = question.options[number - 1];
      if (chosen !== undefined)
        return { text: chosen.label, optionId: chosen.id };
      if (question.options.length > 0) {
        write("Choose a listed number or enter a text answer.\n");
        continue;
      }
    }
    return { text };
  }
}

function printEvent(event: StepEvent): void {
  const cost =
    event.usage?.costUsd === undefined
      ? "unknown"
      : String(event.usage.costUsd);
  process.stdout.write(`${event.type}\t${event.summary}\tcost=${cost}\n`);
}

function printResult(label: string, result: StepResult): void {
  process.stdout.write(`${label}=${result.status}\n`);
  if (result.error !== undefined) process.stderr.write(`${result.error}\n`);
}

export async function runNodeCli(argv: string[]): Promise<number> {
  const definitionPath = flagValue(argv, "--definition");
  const outputDir = flagValue(argv, "--output");
  const continuation = flagValue(argv, "--continue");
  if (definitionPath === undefined || outputDir === undefined) {
    process.stderr.write(
      "usage: run-node --definition <file.json> --output <dir> [--continue <instruction>]\n",
    );
    return 2;
  }
  const definition = await readNodeDefinitionFile(resolve(definitionPath));
  if (definition.kind !== "agent") {
    process.stderr.write("only agent nodes are supported\n");
    return 2;
  }
  const resolvedOutput = resolve(outputDir);
  await mkdir(resolvedOutput, { recursive: true });
  const runner = createAgentRunner(createPiSessionAdapter());
  let terminal: Interface | undefined;
  const signal = new AbortController().signal;
  const context = {
    outputDir: resolvedOutput,
    workDir: resolvedOutput,
    signal,
    callbacks: {
      onEvent: printEvent,
      async ask(question: Question) {
        if (terminal === undefined) {
          terminal = createInterface({
            input: process.stdin,
            output: process.stdout,
          });
        }
        const reader = terminal;
        return askInTerminal(
          question,
          (prompt) => reader.question(prompt, { signal }),
          (line) => {
            process.stdout.write(line);
          },
        );
      },
    },
  };
  try {
    const result = await runner.runAgent(definition, context);
    printResult("status", result);
    if (continuation === undefined)
      return result.status === "succeeded" ? 0 : 1;
    const continued = await runner.continueAgent(continuation, context);
    printResult("continuation-status", continued);
    return continued.status === "succeeded" ? 0 : 1;
  } finally {
    terminal?.close();
    await runner.dispose();
  }
}

function flagValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  return argv[index + 1];
}
