import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { readNodeDefinitionFile } from "./load-definition.ts";
import { createPiSessionAdapter } from "./pi-session.ts";
import { createAgentRunner } from "./run-agent.ts";
import type { StepEvent } from "./types.ts";

export async function runNodeCli(argv: string[]): Promise<number> {
  const definitionPath = flagValue(argv, "--definition");
  const outputDir = flagValue(argv, "--output");
  if (definitionPath === undefined || outputDir === undefined) {
    process.stderr.write(
      "usage: run-node --definition <file.json> --output <dir>\n",
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
  const result = await runner.runAgent(definition, {
    outputDir: resolvedOutput,
    workDir: resolvedOutput,
    signal: new AbortController().signal,
    callbacks: {
      onEvent(event: StepEvent) {
        const cost =
          event.usage?.costUsd === undefined
            ? "unknown"
            : String(event.usage.costUsd);
        process.stdout.write(`${event.type}\t${event.summary}\tcost=${cost}\n`);
      },
    },
  });
  process.stdout.write(`status=${result.status}\n`);
  if (result.error !== undefined) {
    process.stderr.write(`${result.error}\n`);
  }
  return result.status === "succeeded" ? 0 : 1;
}

function flagValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) {
    return undefined;
  }
  return argv[index + 1];
}
