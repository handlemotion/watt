import { realpath } from "node:fs/promises";
import path from "node:path";

import pLimit from "p-limit";

import { loadWorktreeConfig } from "./config.js";
import { assertCopyGlobs, copyGlobs } from "./copy.js";
import { GitError } from "./errors.js";
import { RepositoryLease } from "./lease.js";
import { RepoLock } from "./lock.js";
import {
  assertAbsolutePath,
  isPathInside,
  resolveExistingPrefix,
  resolveRepoRoot,
} from "./paths.js";
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
  RepositorySnapshot,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_LEASE_TIMEOUT_MS = 5_000;
const DEFAULT_CONCURRENCY = 4;
const SETUP_TIMEOUT_MS = 5 * 60_000;

function isTimeout(error: unknown): boolean {
  return error instanceof GitError && error.code === "timeout";
}

export function createGit(options: CreateGitOptions = {}): GitService {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const leaseTimeoutMs = options.leaseTimeoutMs ?? DEFAULT_LEASE_TIMEOUT_MS;
  if (!Number.isFinite(leaseTimeoutMs) || leaseTimeoutMs <= 0) {
    throw new GitError("leaseTimeoutMs must be positive", "invalid_options");
  }
  const spawn: GitSpawn = options.spawn ?? defaultGitSpawn;
  const limit = pLimit(options.concurrency ?? DEFAULT_CONCURRENCY);
  const locks = new RepoLock();
  const leases = new RepositoryLease(leaseTimeoutMs);

  const git = (args: string[], cwd: string, timeout = timeoutMs) =>
    limit(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        return await spawn(args, {
          cwd,
          timeoutMs: timeout,
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted && !isTimeout(error)) {
          throw new GitError(`git ${args.join(" ")} timed out`, "timeout", {
            cause: error,
          });
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    });

  async function resolveRepository(repoRoot: string): Promise<{
    repoRoot: string;
    repositoryIdentity: string;
  }> {
    const requestedRoot = await resolveRepoRoot(repoRoot);
    const result = await git(
      [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
        "--show-toplevel",
      ],
      requestedRoot,
    );
    const [commonDirectory, topLevel] = result.stdout.split("\n");
    if (!commonDirectory || !topLevel) {
      throw new GitError("could not resolve repository identity", "git_failed");
    }
    try {
      return {
        repoRoot: await realpath(topLevel),
        repositoryIdentity: await realpath(commonDirectory),
      };
    } catch (cause) {
      throw new GitError(
        "could not canonicalize repository identity",
        "git_failed",
        {
          cause,
        },
      );
    }
  }

  async function listWorktreesUnlocked(
    repoRoot: string,
  ): Promise<GitWorktree[]> {
    const result = await git(["worktree", "list", "--porcelain"], repoRoot);
    return Promise.all(
      parseWorktreePorcelain(result.stdout).map(async (worktree) => {
        try {
          return {
            ...worktree,
            path: await realpath(worktree.path),
            pathExists: true,
          };
        } catch {
          return {
            ...worktree,
            path: await resolveExistingPrefix(path.resolve(worktree.path)),
            pathExists: false,
          };
        }
      }),
    );
  }

  async function inspectRepository(
    repoRoot: string,
  ): Promise<RepositorySnapshot> {
    const repository = await resolveRepository(repoRoot);
    return {
      ...repository,
      inspectedAt: Date.now(),
      worktrees: await listWorktreesUnlocked(repository.repoRoot),
    };
  }

  async function branchExists(
    repoRoot: string,
    branch: string,
  ): Promise<boolean> {
    try {
      await git(
        ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
        repoRoot,
      );
      return true;
    } catch (error) {
      if (error instanceof GitError && error.code === "git_failed") {
        return false;
      }
      throw error;
    }
  }

  async function rollbackCreate(
    repoRoot: string,
    worktreePath: string,
    branch: string,
  ): Promise<void> {
    try {
      await git(["worktree", "remove", "--force", worktreePath], repoRoot);
    } catch {
      // worktree may not have been registered
    }
    try {
      if (await branchExists(repoRoot, branch)) {
        await git(["branch", "-D", "--", branch], repoRoot);
      }
    } catch {
      // best-effort cleanup
    }
  }

  return {
    inspectRepository,

    async listWorktrees(repoRoot) {
      return (await inspectRepository(repoRoot)).worktrees;
    },

    async createWorktree(input: CreateWorktreeInput): Promise<CreatedWorktree> {
      const repository = await resolveRepository(input.repoRoot);
      const repoRoot = repository.repoRoot;
      const worktreePath = await resolveExistingPrefix(
        assertAbsolutePath("worktreePath", input.worktreePath),
      );
      if (isPathInside(repoRoot, worktreePath)) {
        throw new GitError(
          "worktreePath must not be inside the source repo",
          "nested_worktree",
        );
      }
      return locks.run(repository.repositoryIdentity, () =>
        leases.run(
          repository.repositoryIdentity,
          "create_worktree",
          async () => {
            const config = await loadWorktreeConfig(repoRoot, input.copyGlobs);
            assertCopyGlobs(config.copy);
            if (input.branch.startsWith("-")) {
              throw new GitError(
                `invalid branch: ${input.branch}`,
                "invalid_ref",
              );
            }
            await git(
              ["check-ref-format", `refs/heads/${input.branch}`],
              repoRoot,
            );
            if (input.baseRef.startsWith("-")) {
              throw new GitError(
                `invalid baseRef: ${input.baseRef}`,
                "invalid_ref",
              );
            }
            await git(
              ["rev-parse", "--verify", `${input.baseRef}^{commit}`],
              repoRoot,
            );
            if (await branchExists(repoRoot, input.branch)) {
              throw new GitError(
                `branch already exists: ${input.branch}`,
                "branch_exists",
              );
            }
            await git(
              [
                "worktree",
                "add",
                "-b",
                input.branch,
                worktreePath,
                input.baseRef,
              ],
              repoRoot,
            );
            try {
              const copied = await copyGlobs(
                repoRoot,
                worktreePath,
                config.copy,
              );
              let setupRan = false;
              if (config.commands.length > 0) {
                const controller = new AbortController();
                const timer = setTimeout(
                  () => controller.abort(),
                  SETUP_TIMEOUT_MS,
                );
                try {
                  for (const command of config.commands) {
                    await runSetupCommand(
                      command.cursorScript
                        ? path.join(worktreePath, command.command)
                        : command.command,
                      {
                        cwd: worktreePath,
                        timeoutMs: SETUP_TIMEOUT_MS,
                        env: { ROOT_WORKTREE_PATH: repoRoot },
                        signal: controller.signal,
                      },
                    );
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
          },
        ),
      );
    },

    async archiveWorktree(input: ArchiveWorktreeInput): Promise<void> {
      const repository = await resolveRepository(input.repoRoot);
      const repoRoot = repository.repoRoot;
      const worktreePath = await resolveExistingPrefix(
        assertAbsolutePath("worktreePath", input.worktreePath),
      );
      const keepBranch = input.keepBranch ?? true;
      await locks.run(repository.repositoryIdentity, () =>
        leases.run(
          repository.repositoryIdentity,
          "archive_worktree",
          async () => {
            const listed = await listWorktreesUnlocked(repoRoot);
            const present = listed.some(
              (row) => path.resolve(row.path) === path.resolve(worktreePath),
            );
            if (present) {
              await git(
                ["worktree", "remove", "--force", worktreePath],
                repoRoot,
              );
            }
            if (!keepBranch && (await branchExists(repoRoot, input.branch))) {
              await git(["branch", "-D", "--", input.branch], repoRoot);
            }
          },
        ),
      );
    },
  };
}
