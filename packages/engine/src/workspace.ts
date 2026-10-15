import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || "aipilotagent",
  GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || "agent@aipilot.local",
  GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || "aipilotagent",
  GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || "agent@aipilot.local",
};

export interface RepositoryStatus {
  isGit: boolean;
  hasUncommittedChanges: boolean;
  uncommittedFiles: string[];
  headCommit: string;
}

export interface CreateWorkspaceOptions {
  repoDir: string;
  worktreeDir: string;
  runId: string;
  baseRef?: string;
}

export interface OpenWorkspaceOptions {
  repoDir: string;
  worktreeDir: string;
  runId: string;
  headCommit?: string;
}

export interface CheckpointResult {
  commit: string;
  diff: string;
  modified: boolean;
}

export interface ReadOnlyCheckResult {
  modified: boolean;
  files: string[];
}

export interface CheckpointRecord {
  commit: string;
  nodePath?: string;
  message: string;
}

export interface Workspace {
  readonly repoDir: string;
  readonly worktreeDir: string;
  readonly branch: string;
  readonly headCommit: string;
  checkReadOnly(): Promise<ReadOnlyCheckResult>;
  commitCheckpoint(
    nodePath: string,
    message?: string,
  ): Promise<CheckpointResult>;
  restoreCheckpoint(commitRef?: string): Promise<void>;
  listCheckpoints(): Promise<CheckpointRecord[]>;
  cumulativeDiff(): Promise<string>;
}

async function runGit(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFile("git", args, {
      cwd,
      env: GIT_ENV,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error: unknown) {
    const err = error as { stderr?: string; message?: string };
    const message = err.stderr?.trim() || err.message || String(error);
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${message}`);
  }
}

export async function validateRepository(
  repoDir: string,
): Promise<RepositoryStatus> {
  let isGit = false;
  try {
    const { stdout } = await runGit(
      ["rev-parse", "--is-inside-work-tree"],
      repoDir,
    );
    isGit = stdout.trim() === "true";
  } catch {
    isGit = false;
  }
  if (!isGit) {
    throw new Error(`target directory is not a git repository: ${repoDir}`);
  }
  let headCommit = "";
  try {
    const { stdout } = await runGit(["rev-parse", "HEAD"], repoDir);
    headCommit = stdout.trim();
  } catch {
    throw new Error(`target repository has no commits on HEAD: ${repoDir}`);
  }
  const { stdout } = await runGit(["status", "--porcelain"], repoDir);
  const lines = stdout.split("\n").filter((l) => l.trim().length > 0);
  const uncommittedFiles = lines.map((l) => l.slice(3).trim());
  return {
    isGit: true,
    hasUncommittedChanges: uncommittedFiles.length > 0,
    uncommittedFiles,
    headCommit,
  };
}

class GitWorkspace implements Workspace {
  readonly repoDir: string;
  readonly worktreeDir: string;
  readonly branch: string;
  readonly headCommit: string;

  constructor(
    repoDir: string,
    worktreeDir: string,
    branch: string,
    headCommit: string,
  ) {
    this.repoDir = repoDir;
    this.worktreeDir = worktreeDir;
    this.branch = branch;
    this.headCommit = headCommit;
  }

  async checkReadOnly(): Promise<ReadOnlyCheckResult> {
    const { stdout } = await runGit(
      ["status", "--porcelain"],
      this.worktreeDir,
    );
    const lines = stdout.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length === 0) {
      return { modified: false, files: [] };
    }
    const files = lines.map((l) => l.slice(3).trim());
    await runGit(["reset", "--hard", "HEAD"], this.worktreeDir);
    await runGit(["clean", "-fd"], this.worktreeDir);
    return { modified: true, files };
  }

  async commitCheckpoint(
    nodePath: string,
    message?: string,
  ): Promise<CheckpointResult> {
    const { stdout: statusOut } = await runGit(
      ["status", "--porcelain"],
      this.worktreeDir,
    );
    const lines = statusOut.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length === 0) {
      const { stdout: currentCommit } = await runGit(
        ["rev-parse", "HEAD"],
        this.worktreeDir,
      );
      return { commit: currentCommit.trim(), diff: "", modified: false };
    }
    await runGit(["add", "-A"], this.worktreeDir);
    const commitMsg = `checkpoint(${nodePath}): ${message ?? "node succeeded"}`;
    await runGit(["commit", "-m", commitMsg], this.worktreeDir);
    const { stdout: newCommit } = await runGit(
      ["rev-parse", "HEAD"],
      this.worktreeDir,
    );
    const { stdout: diff } = await runGit(
      ["diff", "HEAD~1", "HEAD"],
      this.worktreeDir,
    );
    return { commit: newCommit.trim(), diff, modified: true };
  }

  async restoreCheckpoint(commitRef?: string): Promise<void> {
    const target = commitRef ?? "HEAD";
    await runGit(["reset", "--hard", target], this.worktreeDir);
    await runGit(["clean", "-fd"], this.worktreeDir);
  }

  async listCheckpoints(): Promise<CheckpointRecord[]> {
    try {
      const { stdout } = await runGit(
        ["log", "--format=%H %s", `${this.headCommit}..HEAD`],
        this.worktreeDir,
      );
      const lines = stdout.split("\n").filter((l) => l.trim().length > 0);
      const records: CheckpointRecord[] = [];
      for (const line of lines) {
        const spaceIdx = line.indexOf(" ");
        if (spaceIdx === -1) continue;
        const commit = line.slice(0, spaceIdx);
        const msg = line.slice(spaceIdx + 1);
        const match = /^checkpoint\(([^)]+)\):\s*(.*)$/.exec(msg);
        if (match) {
          records.push({ commit, nodePath: match[1], message: match[2] ?? "" });
        } else {
          records.push({ commit, message: msg });
        }
      }
      return records;
    } catch {
      return [];
    }
  }

  async cumulativeDiff(): Promise<string> {
    const { stdout } = await runGit(
      ["diff", this.headCommit, "HEAD"],
      this.worktreeDir,
    );
    return stdout;
  }
}

export async function createWorkspace(
  options: CreateWorkspaceOptions,
): Promise<Workspace> {
  const { repoDir, worktreeDir, runId } = options;
  await validateRepository(repoDir);
  const branch = `aipilot/run-${runId}`;
  const baseRef = options.baseRef ?? "HEAD";
  const { stdout: headOut } = await runGit(["rev-parse", baseRef], repoDir);
  const headCommit = headOut.trim();

  await runGit(
    ["worktree", "add", "-b", branch, worktreeDir, headCommit],
    repoDir,
  );

  return new GitWorkspace(repoDir, worktreeDir, branch, headCommit);
}

export async function openWorkspace(
  options: OpenWorkspaceOptions,
): Promise<Workspace> {
  const { repoDir, worktreeDir, runId } = options;
  const branch = `aipilot/run-${runId}`;
  let headCommit = options.headCommit;
  if (!headCommit) {
    try {
      const { stdout: repoHead } = await runGit(["rev-parse", "HEAD"], repoDir);
      const { stdout: mergeBase } = await runGit(
        ["merge-base", "HEAD", repoHead.trim()],
        worktreeDir,
      );
      headCommit = mergeBase.trim();
    } catch {
      const { stdout: current } = await runGit(
        ["rev-parse", "HEAD"],
        worktreeDir,
      );
      headCommit = current.trim();
    }
  }
  return new GitWorkspace(repoDir, worktreeDir, branch, headCommit);
}
