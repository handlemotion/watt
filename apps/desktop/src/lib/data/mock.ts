import type { Project, Worktree } from "$lib/types";

export const projects: Project[] = [
  {
    id: "handlemotion",
    name: "Handlemotion",
    initial: "H",
    color: "#00dc33",
  },
];

export const worktrees: Worktree[] = [
  {
    id: "wt-product-db",
    name: "Product db transformations",
    projectId: "handlemotion",
    diff: { additions: 222, deletions: 1129 },
    chats: [{ id: "chat-billing-1", name: "New billing model setup" }],
  },
  {
    id: "wt-product-db-2",
    name: "Product db transformations",
    projectId: "handlemotion",
    diff: { additions: 222, deletions: 1129 },
    chats: [
      { id: "chat-billing-2", name: "New billing model setup" },
      { id: "chat-billing-3", name: "New billing model setup" },
      { id: "chat-billing-4", name: "New billing model setup", unread: true },
    ],
  },
];

export const currentProjectId = "handlemotion";

export function projectById(
  list: readonly Project[],
  id: string,
): Project | undefined {
  return list.find((project) => project.id === id);
}
