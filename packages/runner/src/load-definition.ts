import { readFile } from "node:fs/promises";
import type {
  AgentNodeDefinition,
  CommandNodeDefinition,
  NodeDefinition,
  ThinkingLevel,
} from "./types.ts";

const THINKING_LEVELS = new Set<ThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export class NodeDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NodeDefinitionError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(
  record: Record<string, unknown>,
  field: string,
): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new NodeDefinitionError(`${field} is required`);
  }
  return value;
}

function optionalString(
  record: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = record[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new NodeDefinitionError(`${field} must be a non-empty string`);
  }
  return value;
}

function stringList(record: Record<string, unknown>, field: string): string[] {
  const value = record[field];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new NodeDefinitionError(`${field} must be an array of strings`);
  }
  return value;
}

function loadAgent(record: Record<string, unknown>): AgentNodeDefinition {
  const model = requiredString(record, "model");
  splitModelRef(model);
  const thinkingLevel = requiredString(record, "thinkingLevel");
  if (!THINKING_LEVELS.has(thinkingLevel as ThinkingLevel)) {
    throw new NodeDefinitionError(`unknown thinking level: ${thinkingLevel}`);
  }
  const interactive = record.interactive;
  if (typeof interactive !== "boolean") {
    throw new NodeDefinitionError("interactive must be a boolean");
  }
  const definition: AgentNodeDefinition = {
    kind: "agent",
    model,
    thinkingLevel: thinkingLevel as ThinkingLevel,
    task: requiredString(record, "task"),
    interactive,
    outputs: stringList(record, "outputs"),
  };
  const skillSourceDir = optionalString(record, "skillSourceDir");
  if (skillSourceDir !== undefined) {
    definition.skillSourceDir = skillSourceDir;
  }
  const skillNames = record.skillNames;
  if (skillNames !== undefined) {
    definition.skillNames = stringList(record, "skillNames");
    if (definition.skillNames.length > 0 && skillSourceDir === undefined) {
      throw new NodeDefinitionError(
        "skillSourceDir is required for skillNames",
      );
    }
  }
  const instructions = optionalString(record, "instructions");
  if (instructions !== undefined) {
    definition.instructions = instructions;
  }
  return definition;
}

function loadCommand(record: Record<string, unknown>): CommandNodeDefinition {
  const allowNonZeroExit = record.allowNonZeroExit;
  if (typeof allowNonZeroExit !== "boolean") {
    throw new NodeDefinitionError("allowNonZeroExit must be a boolean");
  }
  return {
    kind: "command",
    command: requiredString(record, "command"),
    allowNonZeroExit,
  };
}

export function loadNodeDefinition(jsonText: string): NodeDefinition {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new NodeDefinitionError("definition is not valid JSON");
  }
  if (!isRecord(parsed)) {
    throw new NodeDefinitionError("definition must be an object");
  }
  const kind = parsed.kind;
  if (kind === "agent") {
    return loadAgent(parsed);
  }
  if (kind === "command") {
    return loadCommand(parsed);
  }
  throw new NodeDefinitionError(`unknown node type: ${String(kind)}`);
}

export async function readNodeDefinitionFile(
  path: string,
): Promise<NodeDefinition> {
  const text = await readFile(path, "utf8");
  return loadNodeDefinition(text);
}

export function splitModelRef(model: string): { provider: string; id: string } {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) {
    throw new NodeDefinitionError("model must be provider/id");
  }
  const provider = model.slice(0, slash);
  const id = model.slice(slash + 1);
  if (/\s/.test(model)) {
    throw new NodeDefinitionError("model must be provider/id");
  }
  return { provider, id };
}
