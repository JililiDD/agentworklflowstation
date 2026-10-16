import { createHash } from "node:crypto";
import { lstat, readdir, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  loadWorkflow,
  type WorkflowCapabilities,
  type WorkflowDefinition,
  WorkflowDefinitionError,
} from "@aipilotagent/engine";
import YAML, { type Node, type Pair, type YAMLMap, type YAMLSeq } from "yaml";
import {
  assertNoPathTraversal,
  ensureDir,
  getWorkflowLayoutPath,
  getWorkflowsDir,
  safeId,
  writeFileAtomic,
} from "./storage.ts";

export class WorkflowSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowSafetyError";
  }
}

export class WorkflowConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowConflictError";
  }
}

export interface WorkflowLibraryItem {
  id: string;
  name?: string;
  path: string;
  updatedAt: string;
  valid: boolean;
  error?: string;
  inputs?: string[];
  nodeCount?: number;
  budgetUsd?: number;
  maxParallel?: number;
}

export function parseWorkflowYaml(yamlText: string): unknown {
  try {
    return YAML.parse(yamlText);
  } catch (error) {
    throw new WorkflowDefinitionError(
      `YAML parse error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function validateWorkflow(
  yamlText: string,
  capabilities: WorkflowCapabilities,
): Promise<WorkflowDefinition> {
  const parsed = parseWorkflowYaml(yamlText);
  return loadWorkflow(parsed, capabilities);
}

export function hasAnyComment(target: unknown): boolean {
  if (!target || typeof target !== "object") return false;
  let found = false;
  YAML.visit(target as Node, (_key, item) => {
    if (
      item &&
      ((item as { comment?: string; commentBefore?: string }).comment ||
        (item as { comment?: string; commentBefore?: string }).commentBefore)
    ) {
      found = true;
      return YAML.visit.BREAK;
    }
  });
  return found;
}

export function checkDocumentSafety(doc: YAML.Document): void {
  if (doc.errors.length > 0) {
    throw new WorkflowSafetyError(
      `YAML document contains syntax errors: ${doc.errors.map((e) => e.message).join("; ")}`,
    );
  }
  let hasAlias = false;
  YAML.visit(doc, {
    Alias() {
      hasAlias = true;
      return YAML.visit.BREAK;
    },
  });
  if (hasAlias) {
    throw new WorkflowSafetyError(
      "YAML contains aliases or anchors which cannot be safely preserved by visual editor",
    );
  }
}

function updateNodeMap(
  doc: YAML.Document,
  map: YAMLMap,
  newVals: Record<string, unknown>,
): void {
  for (const [key, val] of Object.entries(newVals)) {
    if (key === "definition") {
      const defRecord = val as Record<string, unknown>;
      let defMap = map.get("definition", true) as YAMLMap | undefined;
      if (!defMap || !(defMap instanceof YAML.YAMLMap)) {
        defMap = doc.createNode(defRecord) as YAMLMap;
        map.set("definition", defMap);
      } else {
        for (const [dKey, dVal] of Object.entries(defRecord)) {
          defMap.set(dKey, dVal);
        }
        // Remove definition keys not present
        const currentDefKeys = (defMap.items as Pair[]).map((p) =>
          String((p.key as { value?: unknown })?.value ?? p.key),
        );
        for (const k of currentDefKeys) {
          if (!(k in defRecord)) {
            defMap.delete(k);
          }
        }
      }
    } else if (key === "nodes") {
      const childArray = val as Record<string, unknown>[];
      let nodesSeq = map.get("nodes", true) as YAMLSeq | undefined;
      if (!nodesSeq || !(nodesSeq instanceof YAML.YAMLSeq)) {
        nodesSeq = doc.createNode(childArray) as YAMLSeq;
        map.set("nodes", nodesSeq);
      } else {
        updateNodeSeq(doc, nodesSeq, childArray);
      }
    } else {
      map.set(key, val);
    }
  }

  // Handle keys that might have been removed
  const optionalKeys = ["when", "approval", "writable", "schemas"];
  for (const k of optionalKeys) {
    if (newVals[k] === undefined && map.has(k)) {
      map.delete(k);
    }
  }
}

function updateNodeSeq(
  doc: YAML.Document,
  seq: YAMLSeq,
  newNodes: Record<string, unknown>[],
): void {
  const existingItems = [...seq.items] as Node[];
  const newNodesById = new Map<string, Record<string, unknown>>();
  for (const n of newNodes) {
    if (typeof n.id === "string") {
      newNodesById.set(n.id, n);
    }
  }

  // Check for deleted items with comments
  for (let i = 0; i < existingItems.length; i++) {
    const item = existingItems[i];
    if (item instanceof YAML.YAMLMap) {
      const idScalar = item.get("id");
      const id = typeof idScalar === "string" ? idScalar : undefined;
      if (id && !newNodesById.has(id)) {
        const hasComment =
          hasAnyComment(item) || (i === 0 && Boolean(seq.commentBefore));
        if (hasComment) {
          throw new WorkflowSafetyError(
            `cannot safely delete node '${id}' which has attached comments; operation refused to prevent data loss`,
          );
        }
      }
    }
  }

  // Rebuild sequence with in-place updates where possible to preserve comments
  const updatedItems: Node[] = [];
  const existingMapById = new Map<string, YAMLMap>();
  for (const item of existingItems) {
    if (item instanceof YAML.YAMLMap) {
      const idScalar = item.get("id");
      if (typeof idScalar === "string") {
        existingMapById.set(idScalar, item);
      }
    }
  }

  for (const n of newNodes) {
    const id = typeof n.id === "string" ? n.id : "";
    const existing = existingMapById.get(id);
    if (existing) {
      updateNodeMap(doc, existing, n);
      updatedItems.push(existing);
    } else {
      const created = doc.createNode(n) as Node;
      updatedItems.push(created);
    }
  }

  seq.items = updatedItems;
}

export function updateWorkflowDocument(
  originalYamlText: string,
  updatedRecord: Record<string, unknown>,
): string {
  const doc = YAML.parseDocument(originalYamlText);
  checkDocumentSafety(doc);

  if (Array.isArray(updatedRecord.inputs)) {
    doc.set("inputs", updatedRecord.inputs);
  }
  if (typeof updatedRecord.maxParallel === "number") {
    doc.set("maxParallel", updatedRecord.maxParallel);
  }
  if (typeof updatedRecord.budgetUsd === "number") {
    doc.set("budgetUsd", updatedRecord.budgetUsd);
  } else if (doc.has("budgetUsd")) {
    doc.delete("budgetUsd");
  }

  if (Array.isArray(updatedRecord.nodes)) {
    let nodesSeq = doc.get("nodes", true) as YAMLSeq | undefined;
    if (!nodesSeq || !(nodesSeq instanceof YAML.YAMLSeq)) {
      nodesSeq = doc.createNode(updatedRecord.nodes) as YAMLSeq;
      doc.set("nodes", nodesSeq);
    } else {
      updateNodeSeq(
        doc,
        nodesSeq,
        updatedRecord.nodes as Record<string, unknown>[],
      );
    }
  }

  return doc.toString();
}

export interface WorkflowNodeLayout {
  x: number;
  y: number;
  width?: number;
  height?: number;
  collapsed?: boolean;
}

export interface WorkflowLayoutData {
  version: 1;
  current: Record<string, WorkflowNodeLayout>;
  revisions?: Record<string, Record<string, WorkflowNodeLayout>>;
}

export async function getWorkflowLayout(
  dataDir: string,
  id: string,
): Promise<WorkflowLayoutData | null> {
  const cleanId = safeId(id, "workflow ID");
  const workflowsDir = getWorkflowsDir(dataDir);
  const layoutPath = getWorkflowLayoutPath(dataDir, cleanId);
  assertNoPathTraversal(workflowsDir, layoutPath);

  try {
    const s = await lstat(layoutPath);
    if (s.isSymbolicLink()) {
      throw new WorkflowSafetyError(`symlinks are forbidden: ${layoutPath}`);
    }
    const text = await readFile(layoutPath, "utf8");
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as WorkflowLayoutData;
  } catch (err: unknown) {
    if ((err as { code?: string }).code === "ENOENT") return null;
    throw err;
  }
}

export async function saveWorkflowLayout(
  dataDir: string,
  id: string,
  layout: Record<string, WorkflowNodeLayout>,
  yamlRevisionHash?: string,
): Promise<WorkflowLayoutData> {
  const cleanId = safeId(id, "workflow ID");
  const workflowsDir = getWorkflowsDir(dataDir);
  await ensureDir(workflowsDir);
  const layoutPath = getWorkflowLayoutPath(dataDir, cleanId);
  assertNoPathTraversal(workflowsDir, layoutPath);

  try {
    const s = await lstat(layoutPath);
    if (s.isSymbolicLink()) {
      throw new WorkflowSafetyError(`symlinks are forbidden: ${layoutPath}`);
    }
  } catch (err: unknown) {
    if ((err as { code?: string }).code !== "ENOENT") throw err;
  }

  const existing = await getWorkflowLayout(dataDir, cleanId);
  const revisions = existing?.revisions ? { ...existing.revisions } : {};
  if (yamlRevisionHash) {
    revisions[yamlRevisionHash] = layout;
  }

  const data: WorkflowLayoutData = {
    version: 1,
    current: layout,
    revisions: Object.keys(revisions).length > 0 ? revisions : undefined,
  };

  await writeFileAtomic(layoutPath, `${JSON.stringify(data, null, 2)}\n`);
  return data;
}

export interface SaveWorkflowOptions {
  dataDir: string;
  id: string;
  yamlText?: string;
  updatedObject?: Record<string, unknown>;
  expectedYaml?: string;
  capabilities?: WorkflowCapabilities;
  layout?: Record<string, WorkflowNodeLayout>;
}

export async function saveWorkflow(
  dataDirOrOptions: string | SaveWorkflowOptions,
  idParam?: string,
  yamlTextParam?: string,
  capabilitiesParam?: WorkflowCapabilities,
): Promise<{
  id: string;
  yaml: string;
  definition?: WorkflowDefinition;
  path: string;
}> {
  let dataDir: string;
  let id: string;
  let yamlText: string | undefined;
  let updatedObject: Record<string, unknown> | undefined;
  let expectedYaml: string | undefined;
  let capabilities: WorkflowCapabilities | undefined;
  let layout: Record<string, WorkflowNodeLayout> | undefined;

  if (typeof dataDirOrOptions === "object" && dataDirOrOptions !== null) {
    dataDir = dataDirOrOptions.dataDir;
    id = dataDirOrOptions.id;
    yamlText = dataDirOrOptions.yamlText;
    updatedObject = dataDirOrOptions.updatedObject;
    expectedYaml = dataDirOrOptions.expectedYaml;
    capabilities = dataDirOrOptions.capabilities;
    layout = dataDirOrOptions.layout;
  } else {
    dataDir = dataDirOrOptions;
    id = idParam as string;
    yamlText = yamlTextParam;
    capabilities = capabilitiesParam;
  }

  const cleanId = safeId(id, "workflow ID");
  const workflowsDir = getWorkflowsDir(dataDir);
  await ensureDir(workflowsDir);

  // Check existing file (.yaml or .yml)
  const targetYaml = join(workflowsDir, `${cleanId}.yaml`);
  const targetYml = join(workflowsDir, `${cleanId}.yml`);
  assertNoPathTraversal(workflowsDir, targetYaml);
  assertNoPathTraversal(workflowsDir, targetYml);

  let existingPath: string | null = null;
  let existingContent: string | null = null;

  try {
    const s = await lstat(targetYaml);
    if (s.isSymbolicLink()) {
      throw new WorkflowSafetyError(`symlinks are forbidden: ${targetYaml}`);
    }
    if (s.isFile()) {
      existingPath = targetYaml;
      existingContent = await readFile(targetYaml, "utf8");
    }
  } catch (err: unknown) {
    if ((err as { code?: string }).code !== "ENOENT") throw err;
  }

  if (!existingPath) {
    try {
      const s = await lstat(targetYml);
      if (s.isSymbolicLink()) {
        throw new WorkflowSafetyError(`symlinks are forbidden: ${targetYml}`);
      }
      if (s.isFile()) {
        existingPath = targetYml;
        existingContent = await readFile(targetYml, "utf8");
      }
    } catch (err: unknown) {
      if ((err as { code?: string }).code !== "ENOENT") throw err;
    }
  }

  // Revision conflict check
  if (expectedYaml !== undefined && existingContent !== null) {
    if (existingContent !== expectedYaml) {
      throw new WorkflowConflictError(
        `workflow '${id}' was modified externally (revision conflict)`,
      );
    }
  }

  let finalYaml: string;
  if (updatedObject !== undefined) {
    if (existingContent !== null) {
      finalYaml = updateWorkflowDocument(existingContent, updatedObject);
    } else {
      finalYaml = YAML.stringify(updatedObject);
    }
  } else if (yamlText !== undefined) {
    finalYaml = yamlText;
  } else {
    throw new Error("either yamlText or updatedObject must be provided");
  }

  let definition: WorkflowDefinition | undefined;
  if (capabilities !== undefined) {
    definition = await validateWorkflow(finalYaml, capabilities);
  } else {
    parseWorkflowYaml(finalYaml);
  }

  // Two-stage persistence: save layout sidecar first if provided
  if (layout !== undefined) {
    const revisionHash = createHash("sha256")
      .update(finalYaml)
      .digest("hex")
      .slice(0, 16);
    await saveWorkflowLayout(dataDir, cleanId, layout, revisionHash);
  }

  const targetPath = existingPath ?? targetYaml;
  await writeFileAtomic(targetPath, finalYaml);

  return {
    id: cleanId,
    yaml: finalYaml,
    definition,
    path: targetPath,
  };
}

export async function getWorkflow(
  dataDir: string,
  id: string,
): Promise<{ id: string; yaml: string; updatedAt: string; path: string }> {
  const cleanId = safeId(id, "workflow ID");
  const workflowsDir = getWorkflowsDir(dataDir);
  const targetPath = join(workflowsDir, `${cleanId}.yaml`);
  assertNoPathTraversal(workflowsDir, targetPath);

  try {
    const [yaml, s] = await Promise.all([
      readFile(targetPath, "utf8"),
      stat(targetPath),
    ]);
    return {
      id: cleanId,
      yaml,
      updatedAt: s.mtime.toISOString(),
      path: targetPath,
    };
  } catch (_error) {
    // Try .yml fallback
    const ymlPath = join(workflowsDir, `${cleanId}.yml`);
    try {
      const [yaml, s] = await Promise.all([
        readFile(ymlPath, "utf8"),
        stat(ymlPath),
      ]);
      return {
        id: cleanId,
        yaml,
        updatedAt: s.mtime.toISOString(),
        path: ymlPath,
      };
    } catch {
      throw new Error(`workflow not found: ${id}`);
    }
  }
}

export async function listWorkflows(
  dataDir: string,
): Promise<WorkflowLibraryItem[]> {
  const workflowsDir = getWorkflowsDir(dataDir);
  await ensureDir(workflowsDir);
  const entries = await readdir(workflowsDir, { withFileTypes: true });
  const items: WorkflowLibraryItem[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".yaml") && !entry.name.endsWith(".yml")) continue;
    const filePath = join(workflowsDir, entry.name);
    const id = entry.name.replace(/\.(yaml|yml)$/, "");
    try {
      const [text, s] = await Promise.all([
        readFile(filePath, "utf8"),
        stat(filePath),
      ]);
      const updatedAt = s.mtime.toISOString();
      try {
        const parsed = YAML.parse(text) as unknown;
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          !Array.isArray(parsed)
        ) {
          const record = parsed as Record<string, unknown>;
          const inputs = Array.isArray(record.inputs)
            ? record.inputs.filter((i): i is string => typeof i === "string")
            : [];
          const nodes = Array.isArray(record.nodes) ? record.nodes : [];
          const name = typeof record.name === "string" ? record.name : id;
          const maxParallel =
            typeof record.maxParallel === "number"
              ? record.maxParallel
              : undefined;
          const budgetUsd =
            typeof record.budgetUsd === "number" ? record.budgetUsd : undefined;
          items.push({
            id,
            name,
            path: filePath,
            updatedAt,
            valid: true,
            inputs,
            nodeCount: nodes.length,
            maxParallel,
            budgetUsd,
          });
        } else {
          items.push({
            id,
            path: filePath,
            updatedAt,
            valid: false,
            error: "workflow root must be an object",
          });
        }
      } catch (err) {
        items.push({
          id,
          path: filePath,
          updatedAt,
          valid: false,
          error:
            err instanceof Error
              ? err.message
              : "failed to parse workflow YAML",
        });
      }
    } catch {
      // File read failed, skip
    }
  }

  // Sort by updatedAt descending
  items.sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
  return items;
}

export async function deleteWorkflow(
  dataDir: string,
  id: string,
): Promise<void> {
  const cleanId = safeId(id, "workflow ID");
  const workflowsDir = getWorkflowsDir(dataDir);
  const targetYaml = join(workflowsDir, `${cleanId}.yaml`);
  const targetYml = join(workflowsDir, `${cleanId}.yml`);

  let deleted = false;
  try {
    await unlink(targetYaml);
    deleted = true;
  } catch {
    // yaml not found
  }
  try {
    await unlink(targetYml);
    deleted = true;
  } catch {
    // yml not found
  }

  if (!deleted) {
    throw new Error(`workflow not found: ${id}`);
  }
}
