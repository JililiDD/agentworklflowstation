import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildSkillPrompt, resolveSkills, SkillError } from "./skills.ts";

test("injects skill body and absolute directory", async () => {
  const sourceDir = await mkdtemp(join(tmpdir(), "runner-skills-"));
  const siblingDir = join(sourceDir, "orchestrator", "references");
  await mkdir(siblingDir, { recursive: true });
  await writeFile(join(siblingDir, "doc.md"), "sibling-doc\n");
  const builderDir = join(sourceDir, "builder");
  await mkdir(builderDir);
  await writeFile(
    join(builderDir, "SKILL.md"),
    "Read ../orchestrator/references/doc.md\n",
  );

  const otherDir = join(sourceDir, "unselected");
  await mkdir(otherDir);
  await writeFile(join(otherDir, "SKILL.md"), "UNSELECTED_SKILL_BODY\n");
  const skills = await resolveSkills(sourceDir, ["builder"]);
  const prompt = buildSkillPrompt(skills);
  assert.match(prompt, /Read \.\.\/orchestrator\/references\/doc\.md/);
  assert.doesNotMatch(prompt, /UNSELECTED_SKILL_BODY/);
  assert.match(
    prompt,
    new RegExp(builderDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
});

test("rejects a skill name escaping its source directory", async () => {
  const sourceDir = await mkdtemp(join(tmpdir(), "runner-skills-escape-"));
  await assert.rejects(
    () => resolveSkills(sourceDir, ["../outside"]),
    SkillError,
  );
});

test("rejects a missing skill", async () => {
  const sourceDir = await mkdtemp(join(tmpdir(), "runner-skills-missing-"));
  await assert.rejects(
    () => resolveSkills(sourceDir, ["missing"]),
    (error: unknown) =>
      error instanceof SkillError &&
      error.message === "skill not found: missing",
  );
});
