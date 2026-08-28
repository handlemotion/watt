import type { Database as SqliteDatabase } from "better-sqlite3";

const VERSION = 2;

const V1_DDL = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  repo_root TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  worktree_path TEXT NOT NULL,
  branch TEXT NOT NULL,
  slug TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  archived_at INTEGER,
  FOREIGN KEY (project_id) REFERENCES projects(id)
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  cursor_agent_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS workspaces_active_slug
  ON workspaces(project_id, slug) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS workspaces_project_history
  ON workspaces(project_id, created_at);
CREATE INDEX IF NOT EXISTS sessions_workspace_history
  ON sessions(workspace_id, created_at);
`;

const V2_DDL = `
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  cursor_run_id TEXT UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('queued', 'dispatching', 'running', 'finished', 'error', 'cancelled')),
  prompt TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  result_text TEXT,
  error_message TEXT,
  error_code TEXT,
  duration_ms INTEGER,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);
CREATE TABLE run_events (
  run_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  event_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, sequence),
  FOREIGN KEY (run_id) REFERENCES runs(id)
);
CREATE INDEX runs_session_history ON runs(session_id, created_at);
CREATE INDEX runs_status_queue ON runs(status, created_at);
CREATE UNIQUE INDEX runs_session_active
  ON runs(session_id) WHERE status IN ('dispatching', 'running');
CREATE INDEX run_events_history ON run_events(run_id, sequence);
`;

export function migrate(database: SqliteDatabase): void {
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  const current = database.pragma("user_version", { simple: true });
  if (
    typeof current !== "number" ||
    !Number.isInteger(current) ||
    current < 0 ||
    current > VERSION
  ) {
    throw new Error(
      `incompatible watt.sqlite user_version: ${String(current)}`,
    );
  }
  database.transaction(() => {
    if (current < 1) {
      database.exec(V1_DDL);
      const duplicate = database
        .prepare(
          "SELECT worktree_path FROM workspaces WHERE archived_at IS NULL GROUP BY worktree_path HAVING COUNT(*) > 1 LIMIT 1",
        )
        .get() as { worktree_path: string } | undefined;
      if (duplicate) {
        throw new Error(
          `incompatible watt.sqlite: duplicate active worktree_path ${duplicate.worktree_path}`,
        );
      }
      database.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS workspaces_active_path ON workspaces(worktree_path) WHERE archived_at IS NULL",
      );
    }
    if (current < 2) database.exec(V2_DDL);
    database.pragma(`user_version = ${VERSION}`);
  })();
}
