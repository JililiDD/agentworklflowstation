import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import type { Condition } from "./types.ts";

export interface ReferenceScope {
  inputs: Record<string, string>;
  nodes: Map<string, Record<string, string>>;
  previous: Map<string, Record<string, string>>;
  outputs?: Record<string, string>;
  item?: unknown;
  feedback?: { text: string; outputs: Record<string, string> };
}

export function referencesIn(text: string): string[] {
  const references = [...text.matchAll(/\$\{([^{}]+)\}/g)].map(
    (match) => match[1] ?? "",
  );
  if (text.replace(/\$\{[^{}]+\}/g, "").includes("${")) {
    throw new Error(`invalid reference: ${text}`);
  }
  return references;
}

export function parseReference(ref: string): {
  kind: string;
  key: string;
  file?: string;
  pointer?: string;
} {
  const value =
    ref.startsWith("${") && ref.endsWith("}") ? ref.slice(2, -1) : ref;
  const [head, pointer] = value.split("#", 2);
  if (
    head === undefined ||
    (pointer !== undefined && !pointer.startsWith("/"))
  ) {
    throw new Error(`invalid reference: ${ref}`);
  }
  const parts = head.split(".");
  const kind = parts[0];
  const key = parts[1];
  if (!kind || !key || !/^[A-Za-z][\w-]*$/.test(key)) {
    throw new Error(`invalid reference: ${ref}`);
  }
  if (kind === "nodes" || kind === "previous") {
    const file = parts.slice(2).join(".");
    if (!file || file.includes("/") || file === "..")
      throw new Error(`invalid reference: ${ref}`);
    return { kind, key, file, pointer };
  }
  if (
    (kind === "inputs" || kind === "item" || kind === "outputs") &&
    parts.length >= 2
  ) {
    if (kind === "outputs") {
      const file = parts.slice(1).join(".");
      if (file.includes("/") || file === "..")
        throw new Error(`invalid reference: ${ref}`);
      return { kind, key: file, pointer };
    }
    if (pointer !== undefined) throw new Error(`invalid reference: ${ref}`);
    return { kind, key: parts.slice(1).join(".") };
  }
  throw new Error(`invalid reference: ${ref}`);
}

async function fileValue(file: string, pointer?: string): Promise<unknown> {
  if (pointer === undefined) return file;
  let data: unknown = JSON.parse(await readFile(file, "utf8"));
  for (const segment of pointer.slice(1).split("/")) {
    const key = segment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (typeof data !== "object" || data === null || !(key in data)) {
      throw new Error(`JSON field not found: ${pointer}`);
    }
    data = (data as Record<string, unknown>)[key];
  }
  return data;
}

export async function resolveReference(
  ref: string,
  scope: ReferenceScope,
): Promise<unknown> {
  const { kind, key, file, pointer } = parseReference(ref);
  if (kind === "inputs") {
    if (!Object.hasOwn(scope.inputs, key))
      throw new Error(`unknown input: ${key}`);
    return scope.inputs[key];
  }
  if (kind === "item") {
    let value: unknown = scope.item;
    for (const part of key.split(".")) {
      if (typeof value !== "object" || value === null || !(part in value)) {
        throw new Error(`item field not found: ${key}`);
      }
      value = (value as Record<string, unknown>)[part];
    }
    return value;
  }
  const files =
    kind === "nodes"
      ? scope.nodes.get(key)
      : kind === "previous"
        ? scope.previous.get(key)
        : scope.outputs;
  const path = kind === "outputs" ? files?.[key] : files?.[file ?? ""];
  if (path === undefined && kind === "previous") return "";
  if (path === undefined) throw new Error(`output not found: ${ref}`);
  return fileValue(path, pointer);
}

export async function renderTask(
  text: string,
  scope: ReferenceScope,
): Promise<string> {
  let result = text;
  for (const ref of referencesIn(text)) {
    const value = await resolveReference(ref, scope);
    result = result.replace(
      `\${${ref}}`,
      typeof value === "string" ? value : JSON.stringify(value),
    );
  }
  return result;
}

export async function checkCondition(
  condition: Condition,
  scope: ReferenceScope,
): Promise<boolean> {
  try {
    return isDeepStrictEqual(
      await resolveReference(condition.ref, scope),
      condition.equals,
    );
  } catch (error) {
    // A valid reference to a skipped ancestor has no file to inspect.
    if (error instanceof Error && error.message.startsWith("output not found:"))
      return false;
    throw error;
  }
}
