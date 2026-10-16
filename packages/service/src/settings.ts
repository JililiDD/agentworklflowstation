import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  ensureDir,
  getSettingsPath,
  safeId,
  writeFileAtomic,
} from "./storage.ts";

export interface PlatformSettings {
  skillDirectories: string[];
}

export interface SkillInfo {
  name: string;
  directory: string;
  sourceDir: string;
  description?: string;
}

export async function getSettings(dataDir: string): Promise<PlatformSettings> {
  const settingsPath = getSettingsPath(dataDir);
  try {
    const text = await readFile(settingsPath, "utf8");
    const parsed = JSON.parse(text) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return { skillDirectories: [] };
    }
    const record = parsed as Record<string, unknown>;
    const skillDirs = Array.isArray(record.skillDirectories)
      ? record.skillDirectories.filter(
          (d): d is string => typeof d === "string" && d.trim().length > 0,
        )
      : [];
    return { skillDirectories: skillDirs };
  } catch {
    return { skillDirectories: [] };
  }
}

export async function saveSettings(
  dataDir: string,
  settings: unknown,
): Promise<PlatformSettings> {
  if (
    typeof settings !== "object" ||
    settings === null ||
    Array.isArray(settings)
  ) {
    throw new Error("settings must be an object");
  }
  const record = settings as Record<string, unknown>;
  if (!Array.isArray(record.skillDirectories)) {
    throw new Error("skillDirectories must be an array of strings");
  }
  const cleanDirs: string[] = [];
  for (const item of record.skillDirectories) {
    if (typeof item !== "string" || item.trim().length === 0) {
      throw new Error("each skill directory must be a non-empty string");
    }
    cleanDirs.push(resolve(item.trim()));
  }

  // Deduplicate
  const uniqueDirs = Array.from(new Set(cleanDirs));
  const normalized: PlatformSettings = {
    skillDirectories: uniqueDirs,
  };

  const settingsPath = getSettingsPath(dataDir);
  await ensureDir(dataDir);
  await writeFileAtomic(
    settingsPath,
    `${JSON.stringify(normalized, null, 2)}\n`,
  );
  return normalized;
}

export async function listSkillsFromSettings(
  dataDir: string,
): Promise<SkillInfo[]> {
  const settings = await getSettings(dataDir);
  const skills: SkillInfo[] = [];
  const seenNames = new Set<string>();

  for (const sourceDir of settings.skillDirectories) {
    try {
      const entries = await readdir(sourceDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const name = entry.name;
        try {
          safeId(name, "skill name");
        } catch {
          continue;
        }
        const skillDir = join(sourceDir, name);
        const skillFile = join(skillDir, "SKILL.md");
        try {
          const fileStat = await stat(skillFile);
          if (fileStat.isFile()) {
            if (!seenNames.has(name)) {
              seenNames.add(name);
              let description: string | undefined;
              try {
                const body = await readFile(skillFile, "utf8");
                const descMatch = /description:\s*([^\n\r]+)/i.exec(body);
                if (descMatch?.[1]) {
                  description = descMatch[1].trim();
                }
              } catch {
                // Ignore description read error
              }
              skills.push({
                name,
                directory: skillDir,
                sourceDir,
                description,
              });
            }
          }
        } catch {
          // No SKILL.md in this directory, ignore
        }
      }
    } catch {
      // Source directory does not exist or unreadable, skip
    }
  }

  return skills;
}
