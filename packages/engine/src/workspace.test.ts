import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { promisify } from "node:util";
import {
  createWorkspace,
  openWorkspace,
  validateRepository,
} from "./workspace.ts";

const execFile = promisify(execFileCallback);

let tempDir: string;
let repoDir: string;

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFile("git", args, { cwd, env: GIT_ENV });
  return stdout.trim();
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "engine-ws-test-"));
  repoDir = join(tempDir, "repo");
  await mkdir(repoDir, { recursive: true });
  await git(["init"], repoDir);
  await git(["config", "user.name", "test"], repoDir);
  await git(["config", "user.email", "test@example.com"], repoDir);
  await writeFile(join(repoDir, "README.md"), "# Hello\n");
  await git(["add", "README.md"], repoDir);
  await git(["commit", "-m", "initial commit"], repoDir);
});

afterEach(async () => {
  try {
    await rm(tempDir, { recursive: true, force: true });
  } catch {}
});

test("validateRepository detects git repo and uncommitted changes", async () => {
  const notGit = join(tempDir, "not-git");
  await mkdir(notGit, { recursive: true });
  await assert.rejects(
    () => validateRepository(notGit),
    /not a git repository/,
  );

  const cleanStatus = await validateRepository(repoDir);
  assert.equal(cleanStatus.isGit, true);
  assert.equal(cleanStatus.hasUncommittedChanges, false);
  assert.equal(cleanStatus.uncommittedFiles.length, 0);

  // Add dirty file
  await writeFile(join(repoDir, "dirty.txt"), "dirty content");
  const dirtyStatus = await validateRepository(repoDir);
  assert.equal(dirtyStatus.isGit, true);
  assert.equal(dirtyStatus.hasUncommittedChanges, true);
  assert.ok(dirtyStatus.uncommittedFiles.includes("dirty.txt"));
});

test("createWorkspace creates worktree and branch from HEAD", async () => {
  const worktreeDir = join(tempDir, "wt-1");
  const ws = await createWorkspace({
    repoDir,
    worktreeDir,
    runId: "run-abc",
  });

  assert.equal(ws.branch, "aipilot/run-run-abc");
  assert.equal(ws.worktreeDir, worktreeDir);
  const headCommit = await git(["rev-parse", "HEAD"], repoDir);
  assert.equal(ws.headCommit, headCommit);

  const wtReadme = await readFile(join(worktreeDir, "README.md"), "utf8");
  assert.equal(wtReadme, "# Hello\n");

  const branches = await git(["branch"], repoDir);
  assert.ok(branches.includes("aipilot/run-run-abc"));
});

test("checkReadOnly reverts changes and flags modification", async () => {
  const worktreeDir = join(tempDir, "wt-ro");
  const ws = await createWorkspace({
    repoDir,
    worktreeDir,
    runId: "run-ro",
  });

  // No modification
  const check1 = await ws.checkReadOnly();
  assert.equal(check1.modified, false);
  assert.equal(check1.files.length, 0);

  // Modify file
  await writeFile(join(worktreeDir, "bad.txt"), "should be reverted");
  await writeFile(join(worktreeDir, "README.md"), "modified content");

  const check2 = await ws.checkReadOnly();
  assert.equal(check2.modified, true);
  assert.ok(check2.files.includes("bad.txt"));
  assert.ok(check2.files.includes("README.md"));

  // Verify changes were reverted
  const statusAfter = await git(["status", "--porcelain"], worktreeDir);
  assert.equal(statusAfter, "");
  const content = await readFile(join(worktreeDir, "README.md"), "utf8");
  assert.equal(content, "# Hello\n");
});

test("checkReadOnly does not flag files matching .gitignore", async () => {
  await writeFile(join(repoDir, ".gitignore"), "*.log\nignored-dir/\n");
  await git(["add", ".gitignore"], repoDir);
  await git(["commit", "-m", "add gitignore"], repoDir);

  const worktreeDir = join(tempDir, "wt-ign");
  const ws = await createWorkspace({
    repoDir,
    worktreeDir,
    runId: "run-ign",
  });

  await writeFile(join(worktreeDir, "debug.log"), "log line");
  await mkdir(join(worktreeDir, "ignored-dir"), { recursive: true });
  await writeFile(join(worktreeDir, "ignored-dir", "data.tmp"), "tmp data");

  const check = await ws.checkReadOnly();
  assert.equal(check.modified, false);
  assert.equal(check.files.length, 0);
});

test("commitCheckpoint creates checkpoint commit and diff", async () => {
  const worktreeDir = join(tempDir, "wt-chk");
  const ws = await createWorkspace({
    repoDir,
    worktreeDir,
    runId: "run-chk",
  });

  // Checkpoint with no changes
  const emptyChk = await ws.commitCheckpoint("node-1");
  assert.equal(emptyChk.modified, false);
  assert.equal(emptyChk.diff, "");

  // Make changes
  await writeFile(join(worktreeDir, "feature.ts"), "export const a = 1;\n");
  const chk1 = await ws.commitCheckpoint("node-writer", "added feature");
  assert.equal(chk1.modified, true);
  assert.ok(chk1.commit.length > 0);
  assert.ok(chk1.diff.includes("+export const a = 1;"));

  // Check log
  const checkpoints = await ws.listCheckpoints();
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0]?.nodePath, "node-writer");
  assert.equal(checkpoints[0]?.commit, chk1.commit);

  // Cumulative diff
  const cumulative = await ws.cumulativeDiff();
  assert.ok(cumulative.includes("+export const a = 1;"));
});

test("restoreCheckpoint resets to specified checkpoint or HEAD", async () => {
  const worktreeDir = join(tempDir, "wt-rst");
  const ws = await createWorkspace({
    repoDir,
    worktreeDir,
    runId: "run-rst",
  });

  await writeFile(join(worktreeDir, "file1.txt"), "v1");
  const chk1 = await ws.commitCheckpoint("node-1");

  await writeFile(join(worktreeDir, "file2.txt"), "v2");
  await ws.commitCheckpoint("node-2");

  // Dirty uncommitted changes
  await writeFile(join(worktreeDir, "dirty.txt"), "dirty");

  // Restore to chk1 commit
  await ws.restoreCheckpoint(chk1.commit);
  const status = await git(["status", "--porcelain"], worktreeDir);
  assert.equal(status, "");

  const log = await git(["rev-parse", "HEAD"], worktreeDir);
  assert.equal(log, chk1.commit);
});

test("openWorkspace re-opens existing worktree for resume", async () => {
  const worktreeDir = join(tempDir, "wt-open");
  const ws1 = await createWorkspace({
    repoDir,
    worktreeDir,
    runId: "run-res",
  });
  await writeFile(join(worktreeDir, "persisted.txt"), "hello");
  const chk = await ws1.commitCheckpoint("node-init");

  const ws2 = await openWorkspace({
    repoDir,
    worktreeDir,
    runId: "run-res",
  });
  assert.equal(ws2.branch, "aipilot/run-run-res");
  const checkpoints = await ws2.listCheckpoints();
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0]?.commit, chk.commit);
});
