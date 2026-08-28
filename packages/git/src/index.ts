export { createGit } from "./create-git.js";
export { GitError, isGitError } from "./errors.js";
export { isPathInside } from "./paths.js";
export type {
  ArchiveWorktreeInput,
  CreateGitOptions,
  CreateWorktreeInput,
  CreatedWorktree,
  GitService,
  GitSpawn,
  GitSpawnResult,
  GitWorktree,
  RepositoryLeaseOwner,
  RepositorySnapshot,
  WattJson,
  WorkspaceOperationAttentionReason,
  WorkspaceOperationStepInput,
  WorkspaceOperationStepResult,
} from "./types.js";
