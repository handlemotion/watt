export type GitSpawnResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type GitSpawn = (
  args: string[],
  options: {
    cwd: string;
    timeoutMs: number;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
  },
) => Promise<GitSpawnResult>;

export type GitWorktree = {
  path: string;
  head: string;
  branch: string | null;
  bare: boolean;
};

export type CreatedWorktree = {
  worktreePath: string;
  branch: string;
  slug: string;
  copied: string[];
  setupRan: boolean;
};

export type CreateWorktreeInput = {
  repoRoot: string;
  worktreePath: string;
  slug: string;
  branch: string;
  baseRef: string;
  copyGlobs?: string[];
};

export type ArchiveWorktreeInput = {
  repoRoot: string;
  worktreePath: string;
  branch: string;
  keepBranch?: boolean;
};

export type WattJson = {
  copy?: string[];
  setup?: string | string[];
};

export type GitService = {
  createWorktree: (input: CreateWorktreeInput) => Promise<CreatedWorktree>;
  listWorktrees: (repoRoot: string) => Promise<GitWorktree[]>;
  archiveWorktree: (input: ArchiveWorktreeInput) => Promise<void>;
};

export type CreateGitOptions = {
  timeoutMs?: number;
  concurrency?: number;
  spawn?: GitSpawn;
};
