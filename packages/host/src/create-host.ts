import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";

import { createAgent, createSdkRuntime, type AgentEvent, type WattAgent } from "@watt/agent";
import { createGit, isPathInside, type GitService } from "@watt/git";
import Database from "better-sqlite3";
import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { ulid } from "ulid";

import { HostError, isUniqueConstraint } from "./errors.js";
import { migrate } from "./migrate.js";
import { projects, sessions, workspaces } from "./schema.js";
import { assertSlug } from "./slug.js";
import type { CreateHostOptions, Host, HostEvent, Project, Session, Workspace } from "./types.js";

function now(): number {
  return Date.now();
}

function mapProject(row: typeof projects.$inferSelect): Project {
  return { id: row.id, repoRoot: row.repoRoot };
}

function mapWorkspace(row: typeof workspaces.$inferSelect): Workspace {
  return {
    id: row.id,
    projectId: row.projectId,
    worktreePath: row.worktreePath,
    branch: row.branch,
    slug: row.slug,
    baseRef: row.baseRef,
    createdAt: row.createdAt,
    archivedAt: row.archivedAt ?? null,
  };
}

function mapSession(row: typeof sessions.$inferSelect): Session {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    cursorAgentId: row.cursorAgentId,
    mode: "agent",
    model: row.model,
    createdAt: row.createdAt,
  };
}

async function annotate(
  workspaceId: string,
  sessionId: string,
  events: AsyncIterable<AgentEvent>,
): Promise<AsyncIterable<HostEvent>> {
  return {
    async *[Symbol.asyncIterator]() {
      for await (const event of events) {
        yield { ...event, workspaceId, sessionId };
      }
    },
  };
}

export async function createHost(options: CreateHostOptions): Promise<Host> {
  await mkdir(options.stateDir, { recursive: true });
  await mkdir(options.worktreeRoot, { recursive: true });
  const stateDir = await realpath(options.stateDir);
  const worktreeRoot = await realpath(options.worktreeRoot);
  const sqlitePath = path.join(stateDir, "watt.sqlite");
  const database = new Database(sqlitePath);
  migrate(database);
  const db = drizzle(database);
  const git: GitService = options.git ?? createGit();
  const agent: WattAgent =
    options.agent ?? createAgent({ runtime: createSdkRuntime(), apiKey: options.apiKey });

  function requireProject(id: string): Project {
    const row = db.select().from(projects).where(eq(projects.id, id)).get();
    if (!row) {
      throw new HostError(`unknown project: ${id}`, "unknown_project");
    }
    return mapProject(row);
  }

  function requireWorkspace(id: string): Workspace {
    const row = db.select().from(workspaces).where(eq(workspaces.id, id)).get();
    if (!row) {
      throw new HostError(`unknown workspace: ${id}`, "unknown_workspace");
    }
    return mapWorkspace(row);
  }

  function requireSession(id: string): Session {
    const row = db.select().from(sessions).where(eq(sessions.id, id)).get();
    if (!row) {
      throw new HostError(`unknown session: ${id}`, "unknown_session");
    }
    return mapSession(row);
  }

  return {
    close() {
      database.close();
    },
    projects: {
      async register(repoRoot) {
        const resolved = await realpath(path.resolve(repoRoot));
        const existing = db.select().from(projects).where(eq(projects.repoRoot, resolved)).get();
        if (existing) {
          return mapProject(existing);
        }
        const row = { id: ulid(), repoRoot: resolved, createdAt: now() };
        try {
          db.insert(projects).values(row).run();
        } catch (error) {
          if (isUniqueConstraint(error)) {
            const raced = db.select().from(projects).where(eq(projects.repoRoot, resolved)).get();
            if (raced) {
              return mapProject(raced);
            }
          }
          throw error;
        }
        return mapProject(row);
      },
      get(id) {
        const row = db.select().from(projects).where(eq(projects.id, id)).get();
        return row ? mapProject(row) : undefined;
      },
      list() {
        return db.select().from(projects).all().map(mapProject);
      },
    },
    workspaces: {
      async create(input) {
        const project = requireProject(input.projectId);
        const slug = assertSlug(input.slug);
        const branch = input.branch ?? `watt/${slug}`;
        const baseRef = input.baseRef ?? "HEAD";
        const worktreePath = path.join(worktreeRoot, slug);
        if (!isPathInside(worktreeRoot, worktreePath) || path.resolve(worktreePath) === worktreeRoot) {
          throw new HostError(`worktree path escapes worktreeRoot: ${slug}`, "invalid_slug");
        }
        if (isPathInside(project.repoRoot, worktreePath)) {
          throw new HostError("worktreeRoot must not be inside the source repo", "nested_worktree");
        }
        const dup = db
          .select()
          .from(workspaces)
          .where(and(eq(workspaces.projectId, project.id), eq(workspaces.slug, slug), isNull(workspaces.archivedAt)))
          .get();
        if (dup) {
          throw new HostError(`workspace slug already exists: ${slug}`, "slug_exists");
        }
        await git.createWorktree({
          repoRoot: project.repoRoot,
          worktreePath,
          slug,
          branch,
          baseRef,
          copyGlobs: input.copyGlobs,
        });
        const resolvedPath = await realpath(worktreePath);
        const row = {
          id: ulid(),
          projectId: project.id,
          worktreePath: resolvedPath,
          branch,
          slug,
          baseRef,
          createdAt: now(),
          archivedAt: null,
        };
        try {
          db.insert(workspaces).values(row).run();
        } catch (error) {
          await git.archiveWorktree({
            repoRoot: project.repoRoot,
            worktreePath: resolvedPath,
            branch,
            keepBranch: false,
          });
          if (isUniqueConstraint(error)) {
            throw new HostError(`workspace slug already exists: ${slug}`, "slug_exists", { cause: error });
          }
          throw error;
        }
        return mapWorkspace(row);
      },
      list(input) {
        const rows = input.includeArchived
          ? db.select().from(workspaces).where(eq(workspaces.projectId, input.projectId)).all()
          : db
              .select()
              .from(workspaces)
              .where(and(eq(workspaces.projectId, input.projectId), isNull(workspaces.archivedAt)))
              .all();
        return rows.map(mapWorkspace);
      },
      get(id) {
        const row = db.select().from(workspaces).where(eq(workspaces.id, id)).get();
        return row ? mapWorkspace(row) : undefined;
      },
      async archive(input) {
        const workspace = requireWorkspace(input.workspaceId);
        const project = requireProject(workspace.projectId);
        await git.archiveWorktree({
          repoRoot: project.repoRoot,
          worktreePath: workspace.worktreePath,
          branch: workspace.branch,
          keepBranch: input.keepBranch,
        });
        if (workspace.archivedAt !== null) {
          return workspace;
        }
        const archivedAt = now();
        db.update(workspaces)
          .set({ archivedAt })
          .where(eq(workspaces.id, workspace.id))
          .run();
        return { ...workspace, archivedAt };
      },
    },
    sessions: {
      async create(input) {
        const workspace = requireWorkspace(input.workspaceId);
        if (workspace.archivedAt !== null) {
          throw new HostError("workspace is archived", "workspace_archived");
        }
        const model = input.model ?? "composer-2.5";
        const handle = await agent.create({
          cwd: workspace.worktreePath,
          model,
          autoReview: input.autoReview,
          workspace: {
            workspaceId: workspace.id,
            projectId: workspace.projectId,
            worktreePath: workspace.worktreePath,
            branch: workspace.branch,
            slug: workspace.slug,
          },
        });
        const row = {
          id: ulid(),
          workspaceId: workspace.id,
          cursorAgentId: handle.cursorAgentId,
          mode: "agent",
          model,
          createdAt: now(),
        };
        db.insert(sessions).values(row).run();
        const run = await handle.send(input.prompt);
        return {
          session: mapSession(row),
          events: await annotate(workspace.id, row.id, run.stream()),
        };
      },
      async send(input) {
        const session = requireSession(input.sessionId);
        const workspace = requireWorkspace(session.workspaceId);
        if (workspace.archivedAt !== null) {
          throw new HostError("workspace is archived", "workspace_archived");
        }
        const handle = await agent.resume({
          cwd: workspace.worktreePath,
          model: session.model,
          cursorAgentId: session.cursorAgentId,
          workspace: {
            workspaceId: workspace.id,
            projectId: workspace.projectId,
            worktreePath: workspace.worktreePath,
            branch: workspace.branch,
            slug: workspace.slug,
          },
        });
        const run = await handle.send(input.prompt);
        return {
          session,
          events: await annotate(workspace.id, session.id, run.stream()),
        };
      },
      get(id) {
        const row = db.select().from(sessions).where(eq(sessions.id, id)).get();
        return row ? mapSession(row) : undefined;
      },
      list(input) {
        return db
          .select()
          .from(sessions)
          .where(eq(sessions.workspaceId, input.workspaceId))
          .all()
          .map(mapSession);
      },
    },
  };
}
