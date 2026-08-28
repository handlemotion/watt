import type { AgentEvent, WattAgent } from "@watt/agent";
import type { GitService, GitWorktree } from "@watt/git";

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
  cursorAgentId: string;
  mode: "agent";
  model: string;
  createdAt: number;
};

export type RunStatus =
  "queued" | "running" | "finished" | "error" | "cancelled";
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
};

export type Host = {
  close: () => Promise<void>;
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
    }) => Promise<Workspace>;
    list: (input: {
      projectId: string;
      includeArchived?: boolean;
    }) => Workspace[];
    get: (id: string) => Workspace | undefined;
    archive: (input: {
      workspaceId: string;
      keepBranch?: boolean;
    }) => Promise<Workspace>;
  };
  sessions: {
    create: (input: {
      workspaceId: string;
      model?: string;
      prompt: string;
      autoReview?: boolean;
    }) => Promise<{ session: Session; run: Run }>;
    send: (input: { sessionId: string; prompt: string }) => Promise<{
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
    }) => AsyncIterable<HostEvent>;
  };
};
