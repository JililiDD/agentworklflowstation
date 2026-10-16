import { readdir, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  loadWorkflow,
  type WorkflowCapabilities,
  type WorkflowDefinition,
  WorkflowDefinitionError,
} from "@aipilotagent/engine";
import YAML from "yaml";
import {
  assertNoPathTraversal,
  ensureDir,
  getWorkflowsDir,
  safeId,
  writeFileAtomic,
} from "./storage.ts";

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

export async function saveWorkflow(
  dataDir: string,
  id: string,
  yamlText: string,
  capabilities?: WorkflowCapabilities,
): Promise<{
  id: string;
  yaml: string;
  definition?: WorkflowDefinition;
  path: string;
}> {
  const cleanId = safeId(id, "workflow ID");
  let definition: WorkflowDefinition | undefined;
  if (capabilities !== undefined) {
    definition = await validateWorkflow(yamlText, capabilities);
  } else {
    // Basic YAML parse check if no capabilities supplied
    parseWorkflowYaml(yamlText);
  }

  const workflowsDir = getWorkflowsDir(dataDir);
  await ensureDir(workflowsDir);
  const targetPath = join(workflowsDir, `${cleanId}.yaml`);
  assertNoPathTraversal(workflowsDir, targetPath);

  await writeFileAtomic(targetPath, yamlText);
  return {
    id: cleanId,
    yaml: yamlText,
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
