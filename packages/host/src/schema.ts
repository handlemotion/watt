import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  repoRoot: text("repo_root").notNull().unique(),
  createdAt: integer("created_at").notNull(),
});

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  worktreePath: text("worktree_path").notNull(),
  branch: text("branch").notNull(),
  slug: text("slug").notNull(),
  baseRef: text("base_ref").notNull(),
  createdAt: integer("created_at").notNull(),
  archivedAt: integer("archived_at"),
});

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  cursorAgentId: text("cursor_agent_id").notNull(),
  mode: text("mode").notNull(),
  model: text("model").notNull(),
  createdAt: integer("created_at").notNull(),
});
