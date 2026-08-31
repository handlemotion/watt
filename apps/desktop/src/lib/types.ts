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
};

export type Worktree = {
  id: string;
  name: string;
  projectId: string;
  diff?: GitDiff;
  chats: Chat[];
};
