export type Project = {
  id: string;
  name: string;
  initial: string;
  color: string;
};

export type GitDiff = {
  additions: number;
  deletions: number;
};

export type Chat = {
  id: string;
  name: string;
  unread?: boolean;
  draft?: string;
  isNew?: boolean;
};

export type Worktree = {
  id: string;
  name: string;
  projectId: string;
  diff?: GitDiff;
  pullRequest?: string;
  chats: Chat[];
};

export type HostStatus = "starting" | "ready" | "error";

export type DesktopSession = {
  id: string;
  workspaceId: string;
  runtime: string;
  mode: string;
  createdAt: number;
};

export type DesktopWorkspace = {
  id: string;
  projectId: string;
  worktreePath: string;
  branch: string;
  slug: string;
  baseRef: string;
  createdAt: number;
  archivedAt: number | null;
  sessions: DesktopSession[];
};

export type DesktopProject = {
  id: string;
  name: string;
  repoRoot: string;
  workspaces: DesktopWorkspace[];
};

export type DesktopSnapshot = {
  host: { status: HostStatus; message: string };
  projects: DesktopProject[];
};
