import type {
  AgentEvent,
  AgentMode,
  AgentRuntimeId,
  CustomTool,
  ExecutionPolicy,
  ExecutionPolicyInput,
  ModelCapability,
  ModelSelection,
  WattAgent,
} from "@watt/agent";
import type { CloudSeedResult, GitService, GitWorktree } from "@watt/git";

export type Project = { id: string; repoRoot: string };
export type Workspace = {
  id: string;
  projectId: string;
  worktreePath: string;
  branch: string;
  slug: string;
  baseRef: string;
  createdAt: number;
  archivedAt: number | null;
};
export type Session = {
  id: string;
  workspaceId: string;
  runtime: AgentRuntimeId;
  cursorAgentId: string;
  mode: AgentMode;
  model: ModelSelection;
  executionPolicy: ExecutionPolicy;
  createdAt: number;
};

export type ModelCatalogState =
  | { status: "live"; fetchedAt: number }
  | {
      status: "cached";
      fetchedAt: number;
      error: { message: string; code?: string };
    }
  | {
      status: "unavailable";
      fetchedAt: null;
      error: { message: string; code?: string };
    };

export type ExecutionPolicyControl =
  | "autoReview"
  | "sandbox"
  | "agentRetries"
  | "toolAllowlist"
  | "toolDenylist"
  | "settingSources";

export type RuntimeCapabilities = {
  id: AgentRuntimeId;
  modes: AgentMode[];
  models: ModelCapability[];
  modelCatalog: ModelCatalogState;
  executionPolicy: {
    defaults: ExecutionPolicy;
    controls: ExecutionPolicyControl[];
  };
};

export type HostCapabilities = {
  runtime: "cursor-local";
  runtimes: RuntimeCapabilities[];
  modes: AgentMode[];
  models: ModelCapability[];
  modelCatalog: ModelCatalogState;
  executionPolicy: {
    defaults: ExecutionPolicy;
    controls: ExecutionPolicyControl[];
  };
};

export type RunStatus = "queued" | "running" | "finished" | "error" | "cancelled";
export type Run = {
  id: string;
  sessionId: string;
  status: RunStatus;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
};
export type RunError = { message: string; code?: string };
export type RunResult = {
  runId: string;
  status: "finished" | "error" | "cancelled";
  result?: string;
  error?: RunError;
  durationMs?: number;
};

export type HostEvent = AgentEvent & {
  workspaceId: string;
  sessionId: string;
  runId: string;
  sequence: number;
};

export type WorkspaceOperationType = "create_workspace" | "archive_workspace";
export type CreateWorkspaceOperationPhase =
  | "intent_recorded"
  | "git_worktree_created"
  | "path_verified"
  | "workspace_row_committed"
  | "operation_completed";
export type ArchiveWorkspaceOperationPhase =
  | "intent_recorded"
  | "active_runs_handled"
  | "git_worktree_removed"
  | "branch_outcome_recorded"
  | "workspace_archived";
export type WorkspaceOperationPhase =
  | CreateWorkspaceOperationPhase
  | ArchiveWorkspaceOperationPhase;
export type WorkspaceOperationTerminalOutcome = "succeeded" | "failed" | "needs_attention";
export type WorkspaceOperationCompensationOutcome =
  | "not_required"
  | "succeeded"
  | "failed"
  | "unsafe";
export type WorkspaceOperationBranchOutcome = "kept" | "deleted" | "already_absent";
export type WorkspaceOperationDiagnostic = {
  code: string;
  message: string;
  observed?: Readonly<Record<string, unknown>>;
};

export type CreateWorkspaceOperationInputs = {
  slug: string;
  branch: string;
  baseRef: string;
  worktreePath: string;
  copyGlobs: string[];
};

export type ArchiveWorkspaceOperationInputs = {
  branch: string;
  worktreePath: string;
  keepBranch: boolean;
  expectedHead: string | null;
};

type WorkspaceOperationBase = {
  schemaVersion: 1;
  id: string;
  projectId: string;
  workspaceId: string;
  createdAt: number;
  updatedAt: number;
  lastRecoveryAt: number | null;
  recoveryAttemptCount: number;
  terminalOutcome: WorkspaceOperationTerminalOutcome | null;
  terminalAt: number | null;
  compensationOutcome: WorkspaceOperationCompensationOutcome;
  diagnostic: WorkspaceOperationDiagnostic | null;
  branchOutcome: WorkspaceOperationBranchOutcome | null;
};

export type WorkspaceOperation =
  | (WorkspaceOperationBase & {
      type: "create_workspace";
      phase: CreateWorkspaceOperationPhase;
      requestedInputs: CreateWorkspaceOperationInputs;
    })
  | (WorkspaceOperationBase & {
      type: "archive_workspace";
      phase: ArchiveWorkspaceOperationPhase;
      requestedInputs: ArchiveWorkspaceOperationInputs;
    });

export type ReconciliationEntry =
  | { state: "healthy"; workspace: Workspace; worktree: GitWorktree }
  | { state: "missing"; workspace: Workspace }
  | {
      state: "branch_mismatch";
      workspace: Workspace;
      worktree: GitWorktree;
    }
  | { state: "untracked_worktree"; worktree: GitWorktree }
  | {
      state: "repository_unavailable";
      project: Project;
      error: { code: string; message: string };
    }
  | {
      state: "ambiguous";
      reason:
        | "branch_at_other_path"
        | "duplicate_canonical_path"
        | "path_exists_outside_snapshot"
        | "unsupported_bare_worktree";
      workspace?: Workspace;
      worktrees: GitWorktree[];
    };

export type ProjectReconciliation = {
  project: Project;
  repositoryIdentity: string | null;
  inspectedAt: number;
  entries: ReconciliationEntry[];
};

export type CreateHostOptions = {
  stateDir: string;
  worktreeRoot: string;
  leaseTimeoutMs?: number;
  apiKey?: string;
  git?: GitService;
  agent?: WattAgent;
  codexAgent?: WattAgent;
  executionPolicy?: ExecutionPolicyInput;
  customTools?: CustomTool[];
};

export type ChangesetIntegrationInput = {
  changesetId: string;
  workspaceId: string;
  remote: string;
  branch: string;
  expectedLocalSha: string;
  expectedRemoteSha?: string;
  idempotencyKey: string;
};

export type ChangesetPullResult =
  | { state: "applied"; localSha: string; remoteSha: string; head: string }
  | { state: "conflicted"; localSha: string; remoteSha: string }
  | { state: "needs_attention"; actualLocalSha: string };

export type ChangesetResolveResult =
  | { state: "applied"; head: string }
  | {
      state: "resolving";
      head: string;
      resolver: { session: Session; run: Run };
    };

export type ChangesetAbortResult = { state: "conflicted"; head: string };

export type Host = {
  capabilities: () => Promise<HostCapabilities>;
  close: () => Promise<void>;
  suspend: () => Promise<void>;
  projects: {
    register: (repoRoot: string) => Promise<Project>;
    get: (id: string) => Project | undefined;
    list: () => Project[];
    reconcile: (input: { projectId: string }) => Promise<ProjectReconciliation>;
  };
  workspaces: {
    create: (input: {
      projectId: string;
      slug: string;
      branch?: string;
      baseRef?: string;
      copyGlobs?: string[];
      idempotencyKey?: string;
    }) => Promise<Workspace>;
    list: (input: { projectId: string; includeArchived?: boolean }) => Workspace[];
    get: (id: string) => Workspace | undefined;
    archive: (input: {
      workspaceId: string;
      keepBranch?: boolean;
      idempotencyKey?: string;
    }) => Promise<Workspace>;
  };
  sessions: {
    create: (input: {
      workspaceId: string;
      runtime?: AgentRuntimeId;
      model?: ModelSelection;
      mode?: AgentMode;
      prompt: string;
      executionPolicy?: ExecutionPolicyInput;
      idempotencyKey?: string;
    }) => Promise<{ session: Session; run: Run }>;
    send: (input: { sessionId: string; prompt: string; idempotencyKey?: string }) => Promise<{
      session: Session;
      run: Run;
    }>;
    get: (id: string) => Session | undefined;
    list: (input: { workspaceId: string }) => Session[];
  };
  runs: {
    get: (id: string) => Run | undefined;
    list: (input: { sessionId: string }) => Run[];
    wait: (input: { runId: string }) => Promise<RunResult>;
    cancel: (input: { runId: string }) => Promise<RunResult>;
    attach: (input: {
      runId: string;
      afterSequence?: number;
      signal?: AbortSignal;
    }) => AsyncIterable<HostEvent>;
  };
  cloud: {
    prepareBase: (input: {
      seedId: string;
      workspaceId: string;
      remote?: string;
      expectedLocalSha?: string;
      idempotencyKey?: string;
    }) => Promise<CloudSeedResult>;
  };
  changesets: {
    pull: (input: ChangesetIntegrationInput) => Promise<ChangesetPullResult>;
    resolve: (
      input: ChangesetIntegrationInput & { remoteSha: string },
    ) => Promise<ChangesetResolveResult>;
    abort: (input: {
      changesetId: string;
      workspaceId: string;
      expectedLocalSha: string;
      idempotencyKey?: string;
    }) => Promise<ChangesetAbortResult>;
  };
  diagnostics: {
    operations: {
      get: (input: { operationId: string }) => WorkspaceOperation | undefined;
      list: (input?: {
        projectId?: string;
        workspaceId?: string;
        includeCompleted?: boolean;
      }) => WorkspaceOperation[];
    };
  };
};
