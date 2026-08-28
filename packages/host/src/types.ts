import type { AgentEvent, WattAgent } from "@watt/agent";
import type { GitService } from "@watt/git";

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

export type HostEvent = AgentEvent & { workspaceId: string; sessionId: string };

export type CreateHostOptions = {
  stateDir: string;
  worktreeRoot: string;
  apiKey?: string;
  git?: GitService;
  agent?: WattAgent;
};

export type Host = {
  close: () => void;
  projects: {
    register: (repoRoot: string) => Promise<Project>;
    get: (id: string) => Project | undefined;
    list: () => Project[];
  };
  workspaces: {
    create: (input: {
      projectId: string;
      slug: string;
      branch?: string;
      baseRef?: string;
      copyGlobs?: string[];
    }) => Promise<Workspace>;
    list: (input: { projectId: string; includeArchived?: boolean }) => Workspace[];
    get: (id: string) => Workspace | undefined;
    archive: (input: { workspaceId: string; keepBranch?: boolean }) => Promise<Workspace>;
  };
  sessions: {
    create: (input: {
      workspaceId: string;
      model?: string;
      prompt: string;
      autoReview?: boolean;
    }) => Promise<{ session: Session; events: AsyncIterable<HostEvent> }>;
    send: (input: { sessionId: string; prompt: string }) => Promise<{
      session: Session;
      events: AsyncIterable<HostEvent>;
    }>;
    get: (id: string) => Session | undefined;
    list: (input: { workspaceId: string }) => Session[];
  };
};
