import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export class SkillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillError";
  }
}

export interface ResolvedSkill {
  name: string;
  directory: string;
  body: string;
}

export async function resolveSkills(
  sourceDir: string,
  names: string[],
): Promise<ResolvedSkill[]> {
  const skills: ResolvedSkill[] = [];
  for (const name of names) {
    if (name === "." || name === ".." || !/^[\w-]+$/.test(name)) {
      throw new SkillError(`invalid skill name: ${name}`);
    }
    const directory = resolve(sourceDir, name);
    const skillFile = join(directory, "SKILL.md");
    let body: string;
    try {
      body = await readFile(skillFile, "utf8");
    } catch {
      throw new SkillError(`skill not found: ${name}`);
    }
    skills.push({ name, directory, body });
  }
  return skills;
}

export function buildSkillPrompt(skills: ResolvedSkill[]): string {
  return skills
    .map(
      (skill) =>
        `## Skill: ${skill.name}\n\nSkill directory: ${skill.directory}\n\n${skill.body}`,
    )
    .join("\n\n");
}
