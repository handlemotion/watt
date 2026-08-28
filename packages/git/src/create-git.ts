import path from "node:path";

import pLimit from "p-limit";

import { loadWorktreeConfig } from "./config.js";
import { copyGlobs } from "./copy.js";
import { GitError } from "./errors.js";
import { RepoLock } from "./lock.js";
import { assertAbsolutePath, isPathInside, resolveExistingPrefix, resolveRepoRoot } from "./paths.js";
import { parseWorktreePorcelain } from "./porcelain.js";
import { runSetupCommand } from "./setup.js";
import { defaultGitSpawn } from "./spawn.js";
import type {
  ArchiveWorktreeInput,
  CreateGitOptions,
  CreateWorktreeInput,
  CreatedWorktree,
  GitService,
  GitSpawn,
  GitWorktree,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_CONCURRENCY = 4;
const SETUP_TIMEOUT_MS = 5 * 60_000;

function isTimeout(error: unknown): boolean {
  return error instanceof GitError && error.code === "timeout";
}

export function createGit(options: CreateGitOptions = {}): GitService {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const spawn: GitSpawn = options.spawn ?? defaultGitSpawn;
  const limit = pLimit(options.concurrency ?? DEFAULT_CONCURRENCY);
  const locks = new RepoLock();

  const git = (args: string[], cwd: string, timeout = timeoutMs) =>
    limit(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        return await spawn(args, { cwd, timeoutMs: timeout, signal: controller.signal });
      } catch (error) {
        if (controller.signal.aborted && !isTimeout(error)) {
          throw new GitError(`git ${args.join(" ")} timed out`, "timeout", { cause: error });
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    });

  async function listWorktreesUnlocked(repoRoot: string): Promise<GitWorktree[]> {
    const result = await git(["worktree", "list", "--porcelain"], repoRoot);
    return parseWorktreePorcelain(result.stdout);
  }

  async function branchExists(repoRoot: string, branch: string): Promise<boolean> {
    try {
      await git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], repoRoot);
      return true;
    } catch (error) {
      if (error instanceof GitError && error.code === "git_failed") {
        return false;
      }
      throw error;
    }
  }

  async function rollbackCreate(repoRoot: string, worktreePath: string, branch: string): Promise<void> {
    try {
      await git(["worktree", "remove", "--force", worktreePath], repoRoot);
    } catch {
      // worktree may not have been registered
    }
    try {
      if (await branchExists(repoRoot, branch)) {
        await git(["branch", "-D", branch], repoRoot);
      }
    } catch {
      // best-effort cleanup
    }
  }

  return {
    async listWorktrees(repoRoot) {
      const root = await resolveRepoRoot(repoRoot);
      return listWorktreesUnlocked(root);
    },

    async createWorktree(input: CreateWorktreeInput): Promise<CreatedWorktree> {
      const repoRoot = await resolveRepoRoot(input.repoRoot);
      const worktreePath = await resolveExistingPrefix(assertAbsolutePath("worktreePath", input.worktreePath));
      if (isPathInside(repoRoot, worktreePath)) {
        throw new GitError("worktreePath must not be inside the source repo", "nested_worktree");
      }
      return locks.run(repoRoot, async () => {
        await git(["check-ref-format", `refs/heads/${input.branch}`], repoRoot);
        if (input.baseRef.startsWith("-")) {
          throw new GitError(`invalid baseRef: ${input.baseRef}`, "invalid_ref");
        }
        await git(["rev-parse", "--verify", `${input.baseRef}^{commit}`], repoRoot);
        if (await branchExists(repoRoot, input.branch)) {
          throw new GitError(`branch already exists: ${input.branch}`, "branch_exists");
        }
        await git(["worktree", "add", "-b", input.branch, worktreePath, input.baseRef], repoRoot);
        try {
          const config = await loadWorktreeConfig(repoRoot, input.copyGlobs);
          const copied = await copyGlobs(repoRoot, worktreePath, config.copy);
          let setupRan = false;
          if (config.commands.length > 0) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), SETUP_TIMEOUT_MS);
            try {
              for (const command of config.commands) {
                await runSetupCommand(command, {
                  cwd: worktreePath,
                  timeoutMs: SETUP_TIMEOUT_MS,
                  env: { ROOT_WORKTREE_PATH: repoRoot },
                  signal: controller.signal,
                });
              }
            } finally {
              clearTimeout(timer);
            }
            setupRan = true;
          }
          return {
            worktreePath,
            branch: input.branch,
            slug: input.slug,
            copied,
            setupRan,
          };
        } catch (error) {
          await rollbackCreate(repoRoot, worktreePath, input.branch);
          throw error;
        }
      });
    },

    async archiveWorktree(input: ArchiveWorktreeInput): Promise<void> {
      const repoRoot = await resolveRepoRoot(input.repoRoot);
      const worktreePath = await resolveExistingPrefix(assertAbsolutePath("worktreePath", input.worktreePath));
      const keepBranch = input.keepBranch ?? true;
      await locks.run(repoRoot, async () => {
        const listed = await listWorktreesUnlocked(repoRoot);
        const present = listed.some((row) => path.resolve(row.path) === path.resolve(worktreePath));
        if (present) {
          await git(["worktree", "remove", "--force", worktreePath], repoRoot);
        }
        if (!keepBranch && (await branchExists(repoRoot, input.branch))) {
          await git(["branch", "-D", input.branch], repoRoot);
        }
      });
    },
  };
}
