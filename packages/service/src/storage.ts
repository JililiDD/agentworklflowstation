import { mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

export function safeId(id: string, label = "identifier"): string {
  if (typeof id !== "string" || id.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  const trimmed = id.trim();
  if (
    trimmed === "." ||
    trimmed === ".." ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(trimmed)
  ) {
    throw new Error(`invalid ${label}: ${id}`);
  }
  return trimmed;
}

export function getDataDir(override?: string): string {
  if (override && override.trim().length > 0) {
    return resolve(override.trim());
  }
  if (
    process.env.AIPILOT_DATA_DIR &&
    process.env.AIPILOT_DATA_DIR.trim().length > 0
  ) {
    return resolve(process.env.AIPILOT_DATA_DIR.trim());
  }
  if (
    process.env.XDG_DATA_HOME &&
    process.env.XDG_DATA_HOME.trim().length > 0
  ) {
    return resolve(join(process.env.XDG_DATA_HOME.trim(), "aipilotagent"));
  }
  return resolve(join(homedir(), ".local", "share", "aipilotagent"));
}

export function getWorkflowsDir(dataDir: string): string {
  return join(resolve(dataDir), "workflows");
}

export function getRunsDir(dataDir: string): string {
  return join(resolve(dataDir), "runs");
}

export function getSettingsPath(dataDir: string): string {
  return join(resolve(dataDir), "settings.json");
}

export function assertNoPathTraversal(
  baseDir: string,
  targetPath: string,
): void {
  const normBase = resolve(baseDir);
  const normTarget = resolve(targetPath);
  if (normTarget !== normBase && !normTarget.startsWith(normBase + sep)) {
    throw new Error(`path traversal forbidden: ${targetPath}`);
  }
}

export async function ensureDir(path: string): Promise<string> {
  const resolved = resolve(path);
  await mkdir(resolved, { recursive: true });
  return resolved;
}

export async function writeFileAtomic(
  filePath: string,
  content: string,
): Promise<void> {
  const resolved = resolve(filePath);
  const parent = dirname(resolved);
  await mkdir(parent, { recursive: true });
  const tempPath = join(
    parent,
    `.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`,
  );
  await writeFile(tempPath, content, "utf8");
  await rename(tempPath, resolved);
}
