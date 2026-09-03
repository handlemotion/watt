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
  pathExists: boolean;
  head: string;
  branch: string | null;
  detached: boolean;
  bare: boolean;
  locked: string | null;
  prunable: string | null;
};

export type RepositorySnapshot = {
  repositoryIdentity: string;
  repoRoot: string;
  inspectedAt: number;
  worktrees: GitWorktree[];
};

export type RepositoryLeaseOwner = {
  schemaVersion: 1;
  leaseId: string;
  repositoryIdentity: string;
  operation:
    | "create_worktree"
    | "archive_worktree"
    | "recover_workspace_operation"
    | "integrate_changeset"
    | "publish_cloud_seed";
  operationId?: string;
  pid: number;
  hostname: string;
  processStartFingerprint: string;
  acquiredAt: number;
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
  operationId?: string;
};

export type ArchiveWorktreeInput = {
  repoRoot: string;
  worktreePath: string;
  branch: string;
  keepBranch?: boolean;
  operationId?: string;
};

export type WorkspaceOperationStepInput =
  | {
      operationId: string;
      type: "create_workspace";
      target: "git_worktree_created" | "create_compensated";
      repoRoot: string;
      worktreePath: string;
      slug: string;
      branch: string;
      baseRef: string;
      copyGlobs?: string[];
    }
  | {
      operationId: string;
      type: "archive_workspace";
      target: "git_worktree_removed" | "branch_outcome_recorded";
      repoRoot: string;
      worktreePath: string;
      branch: string;
      keepBranch: boolean;
      expectedHead?: string | null;
    };

export type WorkspaceOperationAttentionReason =
  | "operation_marker_missing"
  | "operation_marker_invalid"
  | "operation_identity_mismatch"
  | "repository_identity_mismatch"
  | "duplicate_canonical_path"
  | "path_exists_outside_snapshot"
  | "worktree_missing"
  | "worktree_mismatch"
  | "branch_changed"
  | "unsupported_bare_worktree";

export type WorkspaceOperationStepResult =
  | {
      state: "advanced";
      repositoryIdentity: string;
      worktreePath: string;
      expectedHead: string | null;
      branchOutcome?: "kept" | "deleted" | "already_absent";
    }
  | {
      state: "needs_attention";
      reason: WorkspaceOperationAttentionReason;
      repositoryIdentity: string;
      observed?: Readonly<Record<string, unknown>>;
    };

export type WattJson = {
  copy?: string[];
  setup?: string | string[];
};

export type GitService = {
  createWorktree: (input: CreateWorktreeInput) => Promise<CreatedWorktree>;
  inspectRepository: (repoRoot: string) => Promise<RepositorySnapshot>;
  listWorktrees: (repoRoot: string) => Promise<GitWorktree[]>;
  archiveWorktree: (input: ArchiveWorktreeInput) => Promise<void>;
  advanceWorkspaceOperation: (
    input: WorkspaceOperationStepInput,
  ) => Promise<WorkspaceOperationStepResult>;
  changesets: {
    preflight: (input: ChangesetIntegrationInput) => Promise<ChangesetPreflightResult>;
    apply: (
      input: ChangesetIntegrationInput & { remoteSha: string },
    ) => Promise<{ state: "applied" | "conflicted"; head: string }>;
    resolve: (
      input: ChangesetIntegrationInput & { remoteSha: string },
    ) => Promise<{ state: "resolving" | "applied"; head: string }>;
    abort: (
      input: Pick<
        ChangesetIntegrationInput,
        "id" | "repoRoot" | "worktreePath" | "expectedLocalSha"
      >,
    ) => Promise<{ state: "aborted"; head: string }>;
  };
  cloudSeed: {
    prepare: (input: CloudSeedInput) => Promise<CloudSeedResult>;
  };
};

export type CloudSeedInput = {
  id: string;
  repoRoot: string;
  worktreePath: string;
  remote?: string;
  expectedLocalSha?: string;
};

export type CloudSeedResult = {
  baseSha: string;
  baseRef: string;
  seedRef?: string;
};

export type ChangesetIntegrationInput = {
  id: string;
  repoRoot: string;
  worktreePath: string;
  remote: string;
  branch: string;
  expectedLocalSha: string;
  expectedRemoteSha?: string;
};
export type ChangesetPreflightResult =
  | { state: "ready"; localSha: string; remoteSha: string }
  | { state: "conflicted"; localSha: string; remoteSha: string }
  | {
      state: "already_applied";
      localSha: string;
      remoteSha: string;
      head: string;
    }
  | { state: "advanced_local"; actualLocalSha: string };

export type CreateGitOptions = {
  timeoutMs?: number;
  leaseTimeoutMs?: number;
  concurrency?: number;
  spawn?: GitSpawn;
};
