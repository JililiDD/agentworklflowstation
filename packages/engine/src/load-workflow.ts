import { basename } from "node:path";
import { loadNodeDefinition, resolveSkills } from "@aipilotagent/runner";
import { parseReference, referencesIn } from "./references.ts";
import type {
  Condition,
  WorkflowCapabilities,
  WorkflowDefinition,
  WorkflowNode,
} from "./types.ts";

export class WorkflowDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowDefinitionError";
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WorkflowDefinitionError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function label(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new WorkflowDefinitionError(`${field} must be a non-empty string`);
  }
  return value;
}

function names(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new WorkflowDefinitionError(`${field} must be an array of strings`);
  }
  return value;
}

function condition(value: unknown): Condition {
  const data = record(value, "condition");
  const ref = label(data.ref, "condition.ref");
  if (!/^\$\{[^{}]+\}$/.test(ref))
    throw new WorkflowDefinitionError(`invalid condition: ${ref}`);
  parseReference(ref);
  if (!("equals" in data))
    throw new WorkflowDefinitionError("condition.equals is required");
  return { ref, equals: data.equals };
}

function parseNode(value: unknown): WorkflowNode {
  const data = record(value, "node");
  const id = label(data.id, "node.id");
  if (!/^[A-Za-z][\w-]*$/.test(id))
    throw new WorkflowDefinitionError(`invalid node id: ${id}`);
  const dependsOn = names(data.dependsOn ?? [], "dependsOn");
  const common = { id, dependsOn } as {
    id: string;
    dependsOn: string[];
    when?: Condition[];
    approval?: boolean;
    writable?: boolean;
  };
  if (data.when !== undefined) {
    if (!Array.isArray(data.when))
      throw new WorkflowDefinitionError("when must be an array");
    common.when = data.when.map(condition);
  }
  for (const field of ["approval", "writable"] as const) {
    if (data[field] !== undefined) {
      if (typeof data[field] !== "boolean")
        throw new WorkflowDefinitionError(`${field} must be a boolean`);
      common[field] = data[field];
    }
  }
  if (data.kind === "agent" || data.kind === "command") {
    const definition = loadNodeDefinition(JSON.stringify(data.definition));
    if (definition.kind !== data.kind)
      throw new WorkflowDefinitionError(`definition kind mismatch: ${id}`);
    if (definition.kind === "command")
      return { ...common, kind: "command", definition };
    if (
      new Set(definition.outputs).size !== definition.outputs.length ||
      definition.outputs.some(
        (file) =>
          file.length === 0 ||
          file === "." ||
          file === ".." ||
          basename(file) !== file,
      )
    )
      throw new WorkflowDefinitionError(`invalid output file name: ${id}`);
    const schemas: Record<string, Record<string, unknown>> = {};
    if (data.schemas !== undefined) {
      for (const [file, schema] of Object.entries(
        record(data.schemas, "schemas"),
      )) {
        if (!definition.outputs.includes(file))
          throw new WorkflowDefinitionError(
            `undeclared schema output: ${file}`,
          );
        schemas[file] = record(schema, `schema ${file}`);
      }
    }
    return { ...common, kind: "agent", definition, schemas };
  }
  if (data.kind === "group") {
    const maxRounds = data.maxRounds;
    if (!Number.isSafeInteger(maxRounds) || (maxRounds as number) < 1) {
      throw new WorkflowDefinitionError("maxRounds must be a positive integer");
    }
    if (data.onExhausted !== "fail" && data.onExhausted !== "approve") {
      throw new WorkflowDefinitionError("onExhausted must be fail or approve");
    }
    return {
      ...common,
      kind: "group",
      nodes: parseNodes(data.nodes),
      until: condition(data.until),
      maxRounds: maxRounds as number,
      onExhausted: data.onExhausted,
    };
  }
  if (data.kind === "foreach") {
    const source = label(data.source, "source");
    if (!/^\$\{[^{}]+\}$/.test(source))
      throw new WorkflowDefinitionError(`invalid source: ${source}`);
    return {
      ...common,
      kind: "foreach",
      source,
      nodes: parseNodes(data.nodes),
    };
  }
  throw new WorkflowDefinitionError(`unknown node kind: ${String(data.kind)}`);
}

function parseNodes(value: unknown): WorkflowNode[] {
  if (!Array.isArray(value))
    throw new WorkflowDefinitionError("nodes must be an array");
  return value.map(parseNode);
}

function outputFiles(node: WorkflowNode): Set<string> {
  return new Set(
    node.kind === "agent"
      ? node.definition.outputs
      : node.kind === "command"
        ? ["stdout", "stderr", "exitCode"]
        : ["manifest.json"],
  );
}

function jsonFile(node: WorkflowNode, file: string): boolean {
  return node.kind === "agent"
    ? node.schemas?.[file] !== undefined
    : node.kind === "command"
      ? file === "exitCode"
      : file === "manifest.json";
}

function knownJsonField(
  node: WorkflowNode,
  file: string,
  pointer: string,
): boolean {
  let schema: Record<string, unknown> =
    node.kind === "agent"
      ? (node.schemas?.[file] ?? {})
      : node.kind === "command"
        ? { type: "object", properties: { exitCode: {}, signal: {} } }
        : node.kind === "group"
          ? { type: "object", properties: { round: {}, outputs: {} } }
          : {
              type: "array",
              items: { type: "object", properties: { index: {}, outputs: {} } },
            };
  for (const segment of pointer.slice(1).split("/")) {
    const key = segment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (schema.type === "array" && /^\d+$/.test(key)) {
      schema = record(schema.items ?? {}, "array items");
    } else if (schema.type === "object") {
      const properties =
        schema.properties === undefined
          ? {}
          : record(schema.properties, "schema properties");
      const field = properties[key] ?? schema.additionalProperties ?? true;
      if (field === undefined || field === false) return false;
      schema = field === true ? {} : record(field, "schema field");
    } else if (schema.type === undefined) {
      return true; // A valid unconstrained JSON schema cannot enumerate its fields.
    } else {
      return false;
    }
  }
  return true;
}

function validateRef(
  text: string,
  available: Map<string, WorkflowNode>,
  previous: Map<string, WorkflowNode>,
  inputs: Set<string>,
  itemAvailable: boolean,
  ownFiles: Set<string>,
  jsonRequired: boolean,
): void {
  for (const ref of referencesIn(text)) {
    const parsed = parseReference(ref);
    if (parsed.kind === "inputs" && inputs.has(parsed.key) && !jsonRequired)
      continue;
    if (parsed.kind === "item" && itemAvailable && !jsonRequired) continue;
    if (
      parsed.kind === "outputs" &&
      ownFiles.has(parsed.key) &&
      !jsonRequired &&
      !parsed.pointer
    )
      continue;
    if (parsed.kind === "nodes" || parsed.kind === "previous") {
      const source = (parsed.kind === "nodes" ? available : previous).get(
        parsed.key,
      );
      if (source && outputFiles(source).has(parsed.file ?? "")) {
        if (
          jsonRequired &&
          (!parsed.pointer || !jsonFile(source, parsed.file ?? ""))
        ) {
          throw new WorkflowDefinitionError(
            `condition needs a JSON field: \${${ref}}`,
          );
        }
        if (parsed.pointer && !jsonFile(source, parsed.file ?? "")) {
          throw new WorkflowDefinitionError(
            `reference needs a JSON output: \${${ref}}`,
          );
        }
        if (
          parsed.pointer &&
          !knownJsonField(source, parsed.file ?? "", parsed.pointer)
        ) {
          throw new WorkflowDefinitionError(`unknown JSON field: \${${ref}}`);
        }
        continue;
      }
    }
    throw new WorkflowDefinitionError(
      `invalid or non-ancestor reference: \${${ref}}`,
    );
  }
}

function validateGraph(
  nodes: WorkflowNode[],
  capabilities: WorkflowCapabilities,
  inputs: Set<string>,
  ancestors: Map<string, WorkflowNode>,
  previous: Map<string, WorkflowNode>,
  itemAvailable: boolean,
  containerIds: Set<string> = new Set(),
): void {
  const byId = new Map<string, WorkflowNode>();
  for (const node of nodes) {
    if (
      byId.has(node.id) ||
      ancestors.has(node.id) ||
      containerIds.has(node.id)
    ) {
      throw new WorkflowDefinitionError(`duplicate node id: ${node.id}`);
    }
    byId.set(node.id, node);
  }
  const visiting = new Set<string>();
  const ancestorsById = new Map<string, Set<string>>();
  const dependencies = (node: WorkflowNode): Set<string> => {
    if (visiting.has(node.id))
      throw new WorkflowDefinitionError(`dependency cycle at ${node.id}`);
    const cached = ancestorsById.get(node.id);
    if (cached) return cached;
    visiting.add(node.id);
    const result = new Set<string>();
    for (const id of node.dependsOn) {
      const dependency = byId.get(id);
      if (!dependency || dependency === node)
        throw new WorkflowDefinitionError(
          `invalid dependency: ${node.id} -> ${id}`,
        );
      result.add(id);
      for (const ancestor of dependencies(dependency)) result.add(ancestor);
    }
    visiting.delete(node.id);
    ancestorsById.set(node.id, result);
    return result;
  };
  for (const node of nodes) {
    const available = new Map(ancestors);
    for (const id of dependencies(node)) {
      const dependency = byId.get(id);
      if (dependency === undefined)
        throw new WorkflowDefinitionError(`invalid dependency: ${id}`);
      available.set(id, dependency);
    }
    const ownFiles = outputFiles(node);
    for (const rule of node.when ?? []) {
      validateRef(
        rule.ref,
        available,
        previous,
        inputs,
        itemAvailable,
        ownFiles,
        true,
      );
    }
    if (node.kind === "agent") {
      const levels = capabilities.models[node.definition.model];
      if (!levels?.includes(node.definition.thinkingLevel)) {
        throw new WorkflowDefinitionError(
          `unsupported model/thinking: ${node.definition.model}/${node.definition.thinkingLevel}`,
        );
      }
      for (const text of [
        node.definition.task,
        node.definition.instructions ?? "",
      ]) {
        validateRef(
          text,
          available,
          previous,
          inputs,
          itemAvailable,
          ownFiles,
          false,
        );
      }
    } else if (node.kind === "foreach") {
      validateRef(
        node.source,
        available,
        previous,
        inputs,
        itemAvailable,
        ownFiles,
        false,
      );
      const parsed = parseReference(node.source);
      const source = (parsed.kind === "nodes" ? available : previous).get(
        parsed.key,
      );
      if (!source || !jsonFile(source, parsed.file ?? "")) {
        throw new WorkflowDefinitionError(
          `foreach source must be JSON output: ${node.source}`,
        );
      }
      const nextContainerIds = new Set(containerIds);
      nextContainerIds.add(node.id);
      validateGraph(
        node.nodes,
        capabilities,
        inputs,
        available,
        new Map(),
        true,
        nextContainerIds,
      );
    } else if (node.kind === "group") {
      const prior = new Map(node.nodes.map((child) => [child.id, child]));
      const nextContainerIds = new Set(containerIds);
      nextContainerIds.add(node.id);
      validateGraph(
        node.nodes,
        capabilities,
        inputs,
        available,
        prior,
        itemAvailable,
        nextContainerIds,
      );
      const final = new Map([
        ...available,
        ...node.nodes.map((child) => [child.id, child] as const),
      ]);
      validateRef(
        node.until.ref,
        final,
        prior,
        inputs,
        itemAvailable,
        ownFiles,
        true,
      );
    }
  }
}

async function checkSkills(nodes: WorkflowNode[]): Promise<void> {
  for (const node of nodes) {
    if (node.kind === "agent" && node.definition.skillNames?.length) {
      const source = node.definition.skillSourceDir;
      if (source === undefined)
        throw new WorkflowDefinitionError(
          `skillSourceDir required: ${node.id}`,
        );
      await resolveSkills(source, node.definition.skillNames);
    }
    if (node.kind === "group" || node.kind === "foreach")
      await checkSkills(node.nodes);
  }
}

export async function loadWorkflow(
  jsonText: string,
  capabilities: WorkflowCapabilities,
): Promise<WorkflowDefinition> {
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch {
    throw new WorkflowDefinitionError("workflow is not valid JSON");
  }
  const data = record(raw, "workflow");
  const inputs = names(data.inputs, "inputs");
  if (
    new Set(inputs).size !== inputs.length ||
    inputs.some((name) => !/^[A-Za-z][\w-]*$/.test(name))
  ) {
    throw new WorkflowDefinitionError("input names must be unique identifiers");
  }
  const maxParallel = data.maxParallel;
  if (!Number.isSafeInteger(maxParallel) || (maxParallel as number) < 1) {
    throw new WorkflowDefinitionError("maxParallel must be a positive integer");
  }
  const nodes = parseNodes(data.nodes);
  try {
    validateGraph(
      nodes,
      capabilities,
      new Set(inputs),
      new Map(),
      new Map(),
      false,
    );
    await checkSkills(nodes);
  } catch (error) {
    if (error instanceof WorkflowDefinitionError) throw error;
    throw new WorkflowDefinitionError(
      error instanceof Error ? error.message : String(error),
    );
  }
  return { inputs, maxParallel: maxParallel as number, nodes };
}
