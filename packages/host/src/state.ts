import type { Database as SqliteDatabase } from "better-sqlite3";

import type { Project, Run, RunResult, Session, Workspace } from "./types.js";

type ProjectRow = { id: string; repo_root: string; created_at: number };
type WorkspaceRow = {
  id: string;
  project_id: string;
  worktree_path: string;
  branch: string;
  slug: string;
  base_ref: string;
  created_at: number;
  archived_at: number | null;
};
type SessionRow = {
  id: string;
  workspace_id: string;
  cursor_agent_id: string;
  mode: string;
  model: string;
  created_at: number;
};
type RunRow = {
  id: string;
  session_id: string;
  cursor_run_id: string | null;
  status:
    "queued" | "dispatching" | "running" | "finished" | "error" | "cancelled";
  prompt: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  result_text: string | null;
  error_message: string | null;
  error_code: string | null;
  duration_ms: number | null;
};
type RunEventRow = { sequence: number; event_json: string };

export type StoredRun = {
  value: Run;
  internalStatus: RunRow["status"];
  cursorRunId: string | null;
  prompt: string | null;
  result: RunResult | null;
};

function project(row: ProjectRow): Project {
  return { id: row.id, repoRoot: row.repo_root };
}

function workspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    projectId: row.project_id,
    worktreePath: row.worktree_path,
    branch: row.branch,
    slug: row.slug,
    baseRef: row.base_ref,
    createdAt: row.created_at,
    archivedAt: row.archived_at,
  };
}

function session(row: SessionRow): Session {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    cursorAgentId: row.cursor_agent_id,
    mode: "agent",
    model: row.model,
    createdAt: row.created_at,
  };
}

function storedRun(row: RunRow): StoredRun {
  const status = row.status === "dispatching" ? "queued" : row.status;
  const value: Run = {
    id: row.id,
    sessionId: row.session_id,
    status,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
  let result: RunResult | null = null;
  if (
    row.status === "finished" ||
    row.status === "error" ||
    row.status === "cancelled"
  ) {
    result = { runId: row.id, status: row.status };
    if (row.result_text !== null) result.result = row.result_text;
    if (row.error_message !== null) {
      result.error = { message: row.error_message };
      if (row.error_code !== null) result.error.code = row.error_code;
    }
    if (row.duration_ms !== null) result.durationMs = row.duration_ms;
  }
  return {
    value,
    internalStatus: row.status,
    cursorRunId: row.cursor_run_id,
    prompt: row.prompt,
    result,
  };
}

const RUN_COLUMNS =
  "id, session_id, cursor_run_id, status, prompt, created_at, started_at, finished_at, result_text, error_message, error_code, duration_ms";

/** The one SQLite-specific persistence boundary used by the host workflow. */
export function createState(database: SqliteDatabase) {
  const statements = {
    projectById: database.prepare(
      "SELECT id, repo_root, created_at FROM projects WHERE id = ?",
    ),
    projectByRoot: database.prepare(
      "SELECT id, repo_root, created_at FROM projects WHERE repo_root = ?",
    ),
    projects: database.prepare(
      "SELECT id, repo_root, created_at FROM projects ORDER BY created_at",
    ),
    insertProject: database.prepare(
      "INSERT INTO projects (id, repo_root, created_at) VALUES (?, ?, ?)",
    ),
    workspaceById: database.prepare(
      "SELECT id, project_id, worktree_path, branch, slug, base_ref, created_at, archived_at FROM workspaces WHERE id = ?",
    ),
    activeWorkspaceBySlug: database.prepare(
      "SELECT id, project_id, worktree_path, branch, slug, base_ref, created_at, archived_at FROM workspaces WHERE project_id = ? AND slug = ? AND archived_at IS NULL",
    ),
    activeWorkspaceByPath: database.prepare(
      "SELECT id, project_id, worktree_path, branch, slug, base_ref, created_at, archived_at FROM workspaces WHERE worktree_path = ? AND archived_at IS NULL",
    ),
    workspacesForProject: database.prepare(
      "SELECT id, project_id, worktree_path, branch, slug, base_ref, created_at, archived_at FROM workspaces WHERE project_id = ? ORDER BY created_at",
    ),
    activeWorkspacesForProject: database.prepare(
      "SELECT id, project_id, worktree_path, branch, slug, base_ref, created_at, archived_at FROM workspaces WHERE project_id = ? AND archived_at IS NULL ORDER BY created_at",
    ),
    insertWorkspace: database.prepare(
      "INSERT INTO workspaces (id, project_id, worktree_path, branch, slug, base_ref, created_at, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)",
    ),
    archiveWorkspace: database.prepare(
      "UPDATE workspaces SET archived_at = ? WHERE id = ?",
    ),
    sessionById: database.prepare(
      "SELECT id, workspace_id, cursor_agent_id, mode, model, created_at FROM sessions WHERE id = ?",
    ),
    sessionsForWorkspace: database.prepare(
      "SELECT id, workspace_id, cursor_agent_id, mode, model, created_at FROM sessions WHERE workspace_id = ? ORDER BY created_at",
    ),
    insertSession: database.prepare(
      "INSERT INTO sessions (id, workspace_id, cursor_agent_id, mode, model, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ),
    runById: database.prepare(`SELECT ${RUN_COLUMNS} FROM runs WHERE id = ?`),
    runsForSession: database.prepare(
      `SELECT ${RUN_COLUMNS} FROM runs WHERE session_id = ? ORDER BY created_at, rowid`,
    ),
    nextQueuedRun: database.prepare(
      `SELECT ${RUN_COLUMNS} FROM runs WHERE session_id = ? AND status = 'queued' ORDER BY created_at, rowid LIMIT 1`,
    ),
    activeRunForSession: database.prepare(
      `SELECT ${RUN_COLUMNS} FROM runs WHERE session_id = ? AND status IN ('dispatching', 'running') ORDER BY created_at, rowid LIMIT 1`,
    ),
    nonterminalRuns: database.prepare(
      `SELECT ${RUN_COLUMNS} FROM runs WHERE status IN ('queued', 'dispatching', 'running') ORDER BY created_at, rowid`,
    ),
    nonterminalRunsForWorkspace: database.prepare(
      `SELECT ${RUN_COLUMNS} FROM runs WHERE session_id IN (SELECT id FROM sessions WHERE workspace_id = ?) AND status IN ('queued', 'dispatching', 'running') ORDER BY created_at, rowid`,
    ),
    insertRun: database.prepare(
      "INSERT INTO runs (id, session_id, cursor_run_id, status, prompt, created_at, started_at, finished_at, result_text, error_message, error_code, duration_ms) VALUES (?, ?, NULL, 'queued', ?, ?, NULL, NULL, NULL, NULL, NULL, NULL)",
    ),
    markRunDispatching: database.prepare(
      "UPDATE runs SET status = 'dispatching', started_at = COALESCE(started_at, ?) WHERE id = ? AND status = 'queued'",
    ),
    markRunRunning: database.prepare(
      "UPDATE runs SET status = 'running', cursor_run_id = ?, prompt = NULL, started_at = COALESCE(started_at, ?) WHERE id = ? AND status = 'dispatching'",
    ),
    finishRun: database.prepare(
      "UPDATE runs SET status = ?, prompt = NULL, finished_at = ?, result_text = ?, error_message = ?, error_code = ?, duration_ms = ? WHERE id = ? AND status IN ('queued', 'dispatching', 'running')",
    ),
    clearRunEvents: database.prepare("DELETE FROM run_events WHERE run_id = ?"),
    insertRunEvent: database.prepare(
      "INSERT INTO run_events (run_id, sequence, event_json, created_at) VALUES (?, ?, ?, ?)",
    ),
    runEventsAfter: database.prepare(
      "SELECT sequence, event_json FROM run_events WHERE run_id = ? AND sequence > ? ORDER BY sequence",
    ),
  };

  const insertSessionAndRun = database.transaction(
    (sessionValue: Session, runValue: Run, prompt: string) => {
      statements.insertSession.run(
        sessionValue.id,
        sessionValue.workspaceId,
        sessionValue.cursorAgentId,
        sessionValue.mode,
        sessionValue.model,
        sessionValue.createdAt,
      );
      statements.insertRun.run(
        runValue.id,
        runValue.sessionId,
        prompt,
        runValue.createdAt,
      );
    },
  );

  return {
    getProject(id: string): Project | undefined {
      const row = statements.projectById.get(id) as ProjectRow | undefined;
      return row && project(row);
    },
    getProjectByRoot(repoRoot: string): Project | undefined {
      const row = statements.projectByRoot.get(repoRoot) as
        ProjectRow | undefined;
      return row && project(row);
    },
    listProjects(): Project[] {
      return (statements.projects.all() as ProjectRow[]).map(project);
    },
    insertProject(value: Project & { createdAt: number }): void {
      statements.insertProject.run(value.id, value.repoRoot, value.createdAt);
    },
    getWorkspace(id: string): Workspace | undefined {
      const row = statements.workspaceById.get(id) as WorkspaceRow | undefined;
      return row && workspace(row);
    },
    getActiveWorkspaceBySlug(
      projectId: string,
      slug: string,
    ): Workspace | undefined {
      const row = statements.activeWorkspaceBySlug.get(projectId, slug) as
        WorkspaceRow | undefined;
      return row && workspace(row);
    },
    getActiveWorkspaceByPath(worktreePath: string): Workspace | undefined {
      const row = statements.activeWorkspaceByPath.get(worktreePath) as
        WorkspaceRow | undefined;
      return row && workspace(row);
    },
    listWorkspaces(projectId: string, includeArchived: boolean): Workspace[] {
      const rows = (
        includeArchived
          ? statements.workspacesForProject.all(projectId)
          : statements.activeWorkspacesForProject.all(projectId)
      ) as WorkspaceRow[];
      return rows.map(workspace);
    },
    insertWorkspace(value: Workspace): void {
      statements.insertWorkspace.run(
        value.id,
        value.projectId,
        value.worktreePath,
        value.branch,
        value.slug,
        value.baseRef,
        value.createdAt,
      );
    },
    archiveWorkspace(id: string, archivedAt: number): void {
      statements.archiveWorkspace.run(archivedAt, id);
    },
    getSession(id: string): Session | undefined {
      const row = statements.sessionById.get(id) as SessionRow | undefined;
      return row && session(row);
    },
    listSessions(workspaceId: string): Session[] {
      return (
        statements.sessionsForWorkspace.all(workspaceId) as SessionRow[]
      ).map(session);
    },
    insertSession(value: Session): void {
      statements.insertSession.run(
        value.id,
        value.workspaceId,
        value.cursorAgentId,
        value.mode,
        value.model,
        value.createdAt,
      );
    },
    insertSessionAndRun(
      sessionValue: Session,
      runValue: Run,
      prompt: string,
    ): void {
      insertSessionAndRun(sessionValue, runValue, prompt);
    },
    getRun(id: string): StoredRun | undefined {
      const row = statements.runById.get(id) as RunRow | undefined;
      return row && storedRun(row);
    },
    listRuns(sessionId: string): Run[] {
      return (statements.runsForSession.all(sessionId) as RunRow[]).map(
        (row) => storedRun(row).value,
      );
    },
    insertRun(value: Run, prompt: string): void {
      statements.insertRun.run(
        value.id,
        value.sessionId,
        prompt,
        value.createdAt,
      );
    },
    getNextQueuedRun(sessionId: string): StoredRun | undefined {
      const row = statements.nextQueuedRun.get(sessionId) as RunRow | undefined;
      return row && storedRun(row);
    },
    getActiveRun(sessionId: string): StoredRun | undefined {
      const row = statements.activeRunForSession.get(sessionId) as
        RunRow | undefined;
      return row && storedRun(row);
    },
    listNonterminalRuns(): StoredRun[] {
      return (statements.nonterminalRuns.all() as RunRow[]).map(storedRun);
    },
    listNonterminalRunsForWorkspace(workspaceId: string): StoredRun[] {
      return (
        statements.nonterminalRunsForWorkspace.all(workspaceId) as RunRow[]
      ).map(storedRun);
    },
    markRunDispatching(id: string, startedAt: number): boolean {
      return statements.markRunDispatching.run(startedAt, id).changes === 1;
    },
    markRunRunning(
      id: string,
      cursorRunId: string,
      startedAt: number,
    ): boolean {
      return (
        statements.markRunRunning.run(cursorRunId, startedAt, id).changes === 1
      );
    },
    finishRun(id: string, result: RunResult, finishedAt: number): boolean {
      return (
        statements.finishRun.run(
          result.status,
          finishedAt,
          result.result ?? null,
          result.error?.message ?? null,
          result.error?.code ?? null,
          result.durationMs ?? null,
          id,
        ).changes === 1
      );
    },
    clearRunEvents(id: string): void {
      statements.clearRunEvents.run(id);
    },
    insertRunEvent(
      runId: string,
      sequence: number,
      eventJson: string,
      createdAt: number,
    ): void {
      statements.insertRunEvent.run(runId, sequence, eventJson, createdAt);
    },
    listRunEventsAfter(runId: string, sequence: number): RunEventRow[] {
      return statements.runEventsAfter.all(runId, sequence) as RunEventRow[];
    },
  };
}
