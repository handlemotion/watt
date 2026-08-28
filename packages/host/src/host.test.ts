import { execFile } from "node:child_process";
import {
  link,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { WattAgent, WattRunResult } from "@watt/agent";
import { createGit, type GitService } from "@watt/git";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";

import { createHost } from "./create-host.js";
import { migrate } from "./migrate.js";

const execFileAsync = promisify(execFile);

async function gitCommand(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

function legacySchema(database: Database): void {
  database.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, repo_root TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
    CREATE TABLE workspaces (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, worktree_path TEXT NOT NULL, branch TEXT NOT NULL, slug TEXT NOT NULL, base_ref TEXT NOT NULL, created_at INTEGER NOT NULL, archived_at INTEGER, FOREIGN KEY (project_id) REFERENCES projects(id));
    CREATE TABLE sessions (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, cursor_agent_id TEXT NOT NULL, mode TEXT NOT NULL, model TEXT NOT NULL, created_at INTEGER NOT NULL, FOREIGN KEY (workspace_id) REFERENCES workspaces(id));
  `);
}

async function initGitRepo(root: string): Promise<string> {
  const repo = path.join(root, "repo");
  await mkdir(repo);
  await gitCommand(repo, ["init", "-b", "main"]);
  await gitCommand(repo, ["config", "user.email", "watt@example.com"]);
  await gitCommand(repo, ["config", "user.name", "Watt"]);
  await writeFile(path.join(repo, "README.md"), "watt\n");
  await gitCommand(repo, ["add", "README.md"]);
  await gitCommand(repo, ["commit", "-m", "init"]);
  return repo;
}

function fakeGit(): GitService & { created: string[]; archived: string[] } {
  const created: string[] = [];
  const archived: string[] = [];
  return {
    created,
    archived,
    async createWorktree(input) {
      created.push(input.worktreePath);
      await mkdir(input.worktreePath, { recursive: true });
      await writeFile(path.join(input.worktreePath, ".keep"), "");
      return {
        worktreePath: input.worktreePath,
        branch: input.branch,
        slug: input.slug,
        copied: [],
        setupRan: false,
      };
    },
    async listWorktrees() {
      throw new Error("listWorktrees must not be used by host.list");
    },
    async inspectRepository() {
      throw new Error("inspectRepository must not be used by host.list");
    },
    async archiveWorktree(input) {
      archived.push(input.worktreePath);
    },
  };
}

function fakeAgent(): WattAgent & {
  resumes: string[];
  idempotencyKeys: string[];
} {
  const resumes: string[] = [];
  const idempotencyKeys: string[] = [];
  const runs = new Map<string, Awaited<ReturnType<WattAgent["getRun"]>>>();
  let runNumber = 0;

  function run(text: string) {
    const cursorRunId = `cursor-run-${++runNumber}`;
    const value = {
      cursorRunId,
      async *stream() {
        yield { type: "text_delta" as const, text };
      },
      wait: async () => ({
        status: "finished" as const,
        result: `${text}-result`,
        durationMs: 5,
      }),
      cancel: async () => undefined,
    };
    runs.set(cursorRunId, value);
    return value;
  }

  return {
    resumes,
    idempotencyKeys,
    async create() {
      return {
        cursorAgentId: "cursor-agent-1",
        async send(_prompt, options) {
          if (options?.idempotencyKey) {
            idempotencyKeys.push(options.idempotencyKey);
          }
          return run("hi");
        },
      };
    },
    async resume(input) {
      resumes.push(input.cursorAgentId);
      return {
        cursorAgentId: input.cursorAgentId,
        async send(_prompt, options) {
          if (options?.idempotencyKey) {
            idempotencyKeys.push(options.idempotencyKey);
          }
          return run("resume");
        },
      };
    },
    async getRun(input) {
      const value = runs.get(input.cursorRunId);
      if (!value) throw new Error(`unknown cursor run: ${input.cursorRunId}`);
      return value;
    },
  };
}

type ControlledRun = Awaited<ReturnType<WattAgent["getRun"]>> & {
  finish: (result?: WattRunResult) => void;
};

function controlledAgent(): WattAgent & {
  starts: Array<{
    prompt: string;
    idempotencyKey: string | undefined;
    run: ControlledRun;
  }>;
  recovered: string[];
} {
  const starts: Array<{
    prompt: string;
    idempotencyKey: string | undefined;
    run: ControlledRun;
  }> = [];
  const recovered: string[] = [];
  const runs = new Map<string, ControlledRun>();
  let cursorRunNumber = 0;
  let cursorAgentNumber = 0;

  function makeRun(prompt: string): ControlledRun {
    let resolve!: (result: WattRunResult) => void;
    let settled = false;
    const result = new Promise<WattRunResult>((done) => {
      resolve = (value) => {
        if (settled) return;
        settled = true;
        done(value);
      };
    });
    const cursorRunId = `controlled-run-${++cursorRunNumber}`;
    const run: ControlledRun = {
      cursorRunId,
      async *stream() {
        yield { type: "text_delta" as const, text: prompt };
        await result;
      },
      wait: () => result,
      async cancel() {
        resolve({ status: "cancelled" });
      },
      finish(value = { status: "finished", result: `${prompt}-done` }) {
        resolve(value);
      },
    };
    runs.set(cursorRunId, run);
    return run;
  }

  function handle(cursorAgentId: string) {
    return {
      cursorAgentId,
      async send(prompt: string, options?: { idempotencyKey?: string }) {
        const run = makeRun(prompt);
        starts.push({
          prompt,
          idempotencyKey: options?.idempotencyKey,
          run,
        });
        return run;
      },
    };
  }

  return {
    starts,
    recovered,
    async create() {
      return handle(`controlled-agent-${++cursorAgentNumber}`);
    },
    async resume(input) {
      return handle(input.cursorAgentId);
    },
    async getRun(input) {
      recovered.push(input.cursorRunId);
      const run = runs.get(input.cursorRunId);
      if (!run) throw new Error(`unknown controlled run: ${input.cursorRunId}`);
      return run;
    },
  };
}

describe("createHost", () => {
  it("gives one live Host exclusive ownership of a state directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "watt-host-lease-"));
    const options = {
      stateDir: path.join(root, "state"),
      worktreeRoot: path.join(root, "trees"),
      leaseTimeoutMs: 25,
      git: fakeGit(),
      agent: fakeAgent(),
    };
    const host = await createHost(options);
    const competing = createHost(options);

    try {
      await expect(competing).rejects.toMatchObject({ code: "host_busy" });
    } finally {
      const unexpected = await competing.catch(() => undefined);
      await unexpected?.close();
    }

    await host.close();
    const reopened = await createHost(options);
    await reopened.close();
  });

  it("reclaims a Host lease whose same-host owner has exited", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "watt-host-lease-stale-"));
    const stateDir = path.join(root, "state");
    const owners = path.join(stateDir, ".watt-locks", "owners");
    await mkdir(owners, { recursive: true });
    const exited = await execFileAsync(process.execPath, [
      "-e",
      "process.stdout.write(String(process.pid))",
    ]);
    const leaseId = "exited-owner";
    const ownerPath = path.join(owners, `${leaseId}.json`);
    await writeFile(
      ownerPath,
      `${JSON.stringify({
        schemaVersion: 1,
        leaseId,
        stateDir,
        pid: Number(exited.stdout),
        hostname: hostname(),
        processStartFingerprint: "exited",
        acquiredAt: Date.now(),
      })}\n`,
    );
    await link(ownerPath, path.join(stateDir, ".watt-locks", "host.lock"));

    const host = await createHost({
      stateDir,
      worktreeRoot: path.join(root, "trees"),
      leaseTimeoutMs: 100,
      git: fakeGit(),
      agent: fakeAgent(),
    });
    await host.close();
  });

  it("migrates the unversioned schema in place without losing rows", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "watt-host-"));
    const database = new Database(path.join(root, "watt.sqlite"));
    legacySchema(database);
    database.exec(`
      INSERT INTO projects VALUES ('project', '/tmp/project', 1);
      INSERT INTO workspaces VALUES ('workspace', 'project', '/tmp/workspace', 'watt/one', 'one', 'HEAD', 2, NULL);
      INSERT INTO sessions VALUES ('session', 'workspace', 'cursor-session', 'agent', 'composer-2.5', 3);
    `);
    migrate(database);
    expect(database.pragma("user_version", { simple: true })).toBe(2);
    expect(database.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(database.pragma("busy_timeout", { simple: true })).toBe(5000);
    const workspaceIndexes = database.pragma(
      "index_list(workspaces)",
    ) as Array<{
      name: string;
      unique: number;
      partial: number;
    }>;
    const sessionIndexes = database.pragma("index_list(sessions)") as Array<{
      name: string;
    }>;
    const runIndexes = database.pragma("index_list(runs)") as Array<{
      name: string;
      unique: number;
      partial: number;
    }>;
    expect(workspaceIndexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "workspaces_project_history" }),
        expect.objectContaining({
          name: "workspaces_active_path",
          unique: 1,
          partial: 1,
        }),
      ]),
    );
    expect(sessionIndexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "sessions_workspace_history" }),
      ]),
    );
    expect(runIndexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "runs_session_history" }),
        expect.objectContaining({
          name: "runs_session_active",
          unique: 1,
          partial: 1,
        }),
      ]),
    );
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM workspaces").get(),
    ).toEqual({ count: 1 });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM sessions").get(),
    ).toEqual({ count: 1 });
    database.close();
  });

  it("fails clearly without resetting duplicate active workspace rows", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "watt-host-"));
    const database = new Database(path.join(root, "watt.sqlite"));
    legacySchema(database);
    database.exec(`
      INSERT INTO projects VALUES ('project', '/tmp/project', 1);
      INSERT INTO workspaces VALUES ('workspace-1', 'project', '/tmp/shared', 'watt/one', 'one', 'HEAD', 2, NULL);
      INSERT INTO workspaces VALUES ('workspace-2', 'project', '/tmp/shared', 'watt/two', 'two', 'HEAD', 3, NULL);
    `);

    expect(() => migrate(database)).toThrow(
      "incompatible watt.sqlite: duplicate active worktree_path /tmp/shared",
    );
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM workspaces").get(),
    ).toEqual({ count: 2 });
    expect(database.pragma("user_version", { simple: true })).toBe(0);
    database.close();
  });

  it("migrates a version 1 database to durable runs without losing history", () => {
    const database = new Database(":memory:");
    legacySchema(database);
    database.exec(`
      CREATE UNIQUE INDEX workspaces_active_slug ON workspaces(project_id, slug) WHERE archived_at IS NULL;
      CREATE UNIQUE INDEX workspaces_active_path ON workspaces(worktree_path) WHERE archived_at IS NULL;
      CREATE INDEX workspaces_project_history ON workspaces(project_id, created_at);
      CREATE INDEX sessions_workspace_history ON sessions(workspace_id, created_at);
      INSERT INTO projects VALUES ('project', '/tmp/project', 1);
      INSERT INTO workspaces VALUES ('workspace', 'project', '/tmp/workspace', 'watt/one', 'one', 'HEAD', 2, NULL);
      INSERT INTO sessions VALUES ('session', 'workspace', 'cursor-session', 'agent', 'composer-2.5', 3);
      PRAGMA user_version = 1;
    `);

    migrate(database);

    expect(database.pragma("user_version", { simple: true })).toBe(2);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM sessions").get(),
    ).toEqual({ count: 1 });
    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('runs', 'run_events') ORDER BY name",
        )
        .all(),
    ).toEqual([{ name: "run_events" }, { name: "runs" }]);
    database.close();
  });

  it("closes a newly opened database when initialization fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "watt-host-"));
    const stateDir = path.join(root, "state");
    await mkdir(stateDir);
    const sqlitePath = path.join(stateDir, "watt.sqlite");
    const database = new Database(sqlitePath);
    legacySchema(database);
    database.exec(`
      INSERT INTO projects VALUES ('project', '/tmp/project', 1);
      INSERT INTO workspaces VALUES ('workspace-1', 'project', '/tmp/shared', 'watt/one', 'one', 'HEAD', 2, NULL);
      INSERT INTO workspaces VALUES ('workspace-2', 'project', '/tmp/shared', 'watt/two', 'two', 'HEAD', 3, NULL);
    `);
    database.close();
    const close = vi.spyOn(Database.prototype, "close");

    await expect(
      createHost({
        stateDir,
        worktreeRoot: path.join(root, "worktrees"),
        git: fakeGit(),
        agent: fakeAgent(),
      }),
    ).rejects.toThrow("duplicate active worktree_path");
    expect(close).toHaveBeenCalledOnce();
    close.mockRestore();
  });

  it("persists projects/workspaces/sessions and resumes by cursorAgentId", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "watt-host-"));
    const repo = path.join(root, "repo");
    await mkdir(repo);
    const git = fakeGit();
    const agent = fakeAgent();
    const host = await createHost({
      stateDir: path.join(root, "state"),
      worktreeRoot: path.join(root, "trees"),
      git,
      agent,
    });

    const project = await host.projects.register(repo);
    const workspace = await host.workspaces.create({
      projectId: project.id,
      slug: "one",
    });
    expect(git.created).toHaveLength(1);
    expect(host.workspaces.list({ projectId: project.id })).toHaveLength(1);

    const created = await host.sessions.create({
      workspaceId: workspace.id,
      prompt: "hello",
    });
    const firstEvents = [];
    for await (const event of host.runs.attach({ runId: created.run.id })) {
      firstEvents.push(event);
    }
    expect(firstEvents[0]).toMatchObject({
      type: "text_delta",
      workspaceId: workspace.id,
      sessionId: created.session.id,
      runId: created.run.id,
      sequence: 1,
    });
    expect(await host.runs.wait({ runId: created.run.id })).toMatchObject({
      status: "finished",
      result: "hi-result",
    });

    await host.close();

    const host2 = await createHost({
      stateDir: path.join(root, "state"),
      worktreeRoot: path.join(root, "trees"),
      git,
      agent,
    });
    const listed = host2.sessions.list({ workspaceId: workspace.id });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.cursorAgentId).toBe("cursor-agent-1");

    const sent = await host2.sessions.send({
      sessionId: listed[0]?.id ?? "",
      prompt: "again",
    });
    expect(agent.resumes).toEqual(["cursor-agent-1"]);
    const resumeEvents = [];
    for await (const event of host2.runs.attach({ runId: sent.run.id })) {
      resumeEvents.push(event);
    }
    expect(resumeEvents[0]?.type).toBe("text_delta");
    await host2.close();
  });

  it("rejects path-escaping slugs and retries archive against git", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "watt-host-"));
    const repo = path.join(root, "repo");
    await mkdir(repo);
    const git = fakeGit();
    const agent = fakeAgent();
    const host = await createHost({
      stateDir: path.join(root, "state"),
      worktreeRoot: path.join(root, "trees"),
      git,
      agent,
    });
    const project = await host.projects.register(repo);
    await expect(
      host.workspaces.create({ projectId: project.id, slug: "../escape" }),
    ).rejects.toMatchObject({ code: "invalid_slug" });
    expect(git.created).toHaveLength(0);

    const workspace = await host.workspaces.create({
      projectId: project.id,
      slug: "one",
    });
    await host.workspaces.archive({ workspaceId: workspace.id });
    await host.workspaces.archive({ workspaceId: workspace.id });
    expect(git.archived).toHaveLength(2);
    await host.close();
  });

  it("reports an active worktree path collision before git work", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "watt-host-"));
    const repo = path.join(root, "repo");
    await mkdir(repo);
    const git = fakeGit();
    const host = await createHost({
      stateDir: path.join(root, "state"),
      worktreeRoot: path.join(root, "trees"),
      git,
      agent: fakeAgent(),
    });
    const project = await host.projects.register(repo);
    const workspace = await host.workspaces.create({
      projectId: project.id,
      slug: "one",
    });
    const otherRepo = path.join(root, "other-repo");
    await mkdir(otherRepo);
    const otherProject = await host.projects.register(otherRepo);
    await expect(
      host.workspaces.create({ projectId: otherProject.id, slug: "one" }),
    ).rejects.toMatchObject({
      code: "workspace_path_exists",
    });
    expect(git.created).toHaveLength(1);
    expect(host.workspaces.get(workspace.id)).toMatchObject({
      worktreePath: workspace.worktreePath,
    });
    await host.close();
  });

  it("serializes sends per session and supports replay cursors and queued cancellation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "watt-host-runs-"));
    const repo = path.join(root, "repo");
    await mkdir(repo);
    const agent = controlledAgent();
    const host = await createHost({
      stateDir: path.join(root, "state"),
      worktreeRoot: path.join(root, "trees"),
      git: fakeGit(),
      agent,
    });
    const project = await host.projects.register(repo);
    const workspace = await host.workspaces.create({
      projectId: project.id,
      slug: "runs",
    });
    const first = await host.sessions.create({
      workspaceId: workspace.id,
      prompt: "first",
    });
    await vi.waitFor(() => expect(agent.starts).toHaveLength(1));

    const [second, third] = await Promise.all([
      host.sessions.send({ sessionId: first.session.id, prompt: "second" }),
      host.sessions.send({ sessionId: first.session.id, prompt: "third" }),
    ]);
    expect(agent.starts).toHaveLength(1);
    expect(host.runs.list({ sessionId: first.session.id })).toHaveLength(3);

    const collect = async (runId: string, afterSequence?: number) => {
      const events = [];
      for await (const event of host.runs.attach({ runId, afterSequence })) {
        events.push(event);
      }
      return events;
    };
    const firstAttachment = collect(first.run.id);
    const secondAttachment = collect(first.run.id);
    agent.starts[0]?.run.finish();
    const [firstEvents, duplicateEvents] = await Promise.all([
      firstAttachment,
      secondAttachment,
    ]);
    expect(firstEvents).toEqual(duplicateEvents);
    expect(firstEvents).toMatchObject([
      {
        text: "first",
        runId: first.run.id,
        sessionId: first.session.id,
        sequence: 1,
      },
    ]);
    expect(await collect(first.run.id, 1)).toEqual([]);
    expect(await host.runs.wait({ runId: first.run.id })).toMatchObject({
      status: "finished",
      result: "first-done",
    });

    await vi.waitFor(() => expect(agent.starts).toHaveLength(2));
    expect(agent.starts[1]?.prompt).toBe("second");
    expect(agent.starts[1]?.idempotencyKey).toBe(second.run.id);
    await expect(host.runs.cancel({ runId: third.run.id })).resolves.toEqual({
      runId: third.run.id,
      status: "cancelled",
    });
    expect(agent.starts).toHaveLength(2);
    agent.starts[1]?.run.finish();
    await expect(
      host.runs.wait({ runId: second.run.id }),
    ).resolves.toMatchObject({ status: "finished" });
    await host.close();
  });

  it("runs different sessions concurrently", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "watt-host-concurrent-"));
    const repo = path.join(root, "repo");
    await mkdir(repo);
    const agent = controlledAgent();
    const host = await createHost({
      stateDir: path.join(root, "state"),
      worktreeRoot: path.join(root, "trees"),
      git: fakeGit(),
      agent,
    });
    const project = await host.projects.register(repo);
    const workspace = await host.workspaces.create({
      projectId: project.id,
      slug: "concurrent",
    });

    const [first, second] = await Promise.all([
      host.sessions.create({ workspaceId: workspace.id, prompt: "one" }),
      host.sessions.create({ workspaceId: workspace.id, prompt: "two" }),
    ]);
    await vi.waitFor(() => expect(agent.starts).toHaveLength(2));
    expect(new Set(agent.starts.map((start) => start.prompt))).toEqual(
      new Set(["one", "two"]),
    );
    for (const start of agent.starts) start.run.finish();
    await Promise.all([
      host.runs.wait({ runId: first.run.id }),
      host.runs.wait({ runId: second.run.id }),
    ]);
    await host.close();
  });

  it("cancels active work on close and resumes the durable queue after reopen", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "watt-host-close-"));
    const repo = path.join(root, "repo");
    await mkdir(repo);
    const stateDir = path.join(root, "state");
    const worktreeRoot = path.join(root, "trees");
    const git = fakeGit();
    const agent = controlledAgent();
    const host = await createHost({ stateDir, worktreeRoot, git, agent });
    const project = await host.projects.register(repo);
    const workspace = await host.workspaces.create({
      projectId: project.id,
      slug: "close",
    });
    const first = await host.sessions.create({
      workspaceId: workspace.id,
      prompt: "active",
    });
    await vi.waitFor(() => expect(agent.starts).toHaveLength(1));
    const queued = await host.sessions.send({
      sessionId: first.session.id,
      prompt: "queued",
    });

    const queuedWait = expect(
      host.runs.wait({ runId: queued.run.id }),
    ).rejects.toMatchObject({ code: "host_closed" });
    const close = host.close();
    expect(host.close()).toBe(close);
    await Promise.all([close, queuedWait]);
    expect(agent.starts).toHaveLength(1);
    expect(() => host.runs.get(first.run.id)).toThrow(
      expect.objectContaining({ code: "host_closed" }),
    );

    const reopened = await createHost({ stateDir, worktreeRoot, git, agent });
    expect(reopened.runs.get(first.run.id)?.status).toBe("cancelled");
    await vi.waitFor(() => expect(agent.starts).toHaveLength(2));
    expect(agent.starts[1]?.prompt).toBe("queued");
    agent.starts[1]?.run.finish();
    await expect(
      reopened.runs.wait({ runId: queued.run.id }),
    ).resolves.toMatchObject({ status: "finished" });
    await reopened.close();
  });

  it("recovers both mapped Cursor runs and the idempotent dispatch crash window", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "watt-host-recover-"));
    const repo = path.join(root, "repo");
    await mkdir(repo);
    const stateDir = path.join(root, "state");
    const worktreeRoot = path.join(root, "trees");
    const git = fakeGit();
    const agent = controlledAgent();
    const host = await createHost({ stateDir, worktreeRoot, git, agent });
    const project = await host.projects.register(repo);
    const workspace = await host.workspaces.create({
      projectId: project.id,
      slug: "recover",
    });
    const created = await host.sessions.create({
      workspaceId: workspace.id,
      prompt: "recover-me",
    });
    await vi.waitFor(() => expect(agent.starts).toHaveLength(1));
    agent.starts[0]?.run.finish();
    await host.runs.wait({ runId: created.run.id });
    await host.close();

    const sqlitePath = path.join(stateDir, "watt.sqlite");
    let database = new Database(sqlitePath);
    database
      .prepare(
        "UPDATE runs SET status = 'running', finished_at = NULL, result_text = NULL, error_message = NULL, error_code = NULL, duration_ms = NULL WHERE id = ?",
      )
      .run(created.run.id);
    database.close();

    const recovered = await createHost({ stateDir, worktreeRoot, git, agent });
    await expect(
      recovered.runs.wait({ runId: created.run.id }),
    ).resolves.toMatchObject({ status: "finished", result: "recover-me-done" });
    expect(agent.recovered).toEqual([agent.starts[0]?.run.cursorRunId]);
    const replayed = [];
    for await (const event of recovered.runs.attach({
      runId: created.run.id,
    })) {
      replayed.push(event);
    }
    expect(replayed).toMatchObject([{ sequence: 1, text: "recover-me" }]);
    await recovered.close();

    database = new Database(sqlitePath);
    database
      .prepare(
        "UPDATE runs SET status = 'dispatching', cursor_run_id = NULL, prompt = 'retry-me', finished_at = NULL, result_text = NULL, error_message = NULL, error_code = NULL, duration_ms = NULL WHERE id = ?",
      )
      .run(created.run.id);
    database.close();

    const retried = await createHost({ stateDir, worktreeRoot, git, agent });
    await vi.waitFor(() => expect(agent.starts).toHaveLength(2));
    expect(agent.starts[1]?.idempotencyKey).toBe(created.run.id);
    agent.starts[1]?.run.finish();
    await expect(
      retried.runs.wait({ runId: created.run.id }),
    ).resolves.toMatchObject({ status: "finished", result: "retry-me-done" });
    await retried.close();
  });

  it("cancels workspace runs before archiving the worktree", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "watt-host-archive-"));
    const repo = path.join(root, "repo");
    await mkdir(repo);
    const git = fakeGit();
    const agent = controlledAgent();
    const host = await createHost({
      stateDir: path.join(root, "state"),
      worktreeRoot: path.join(root, "trees"),
      git,
      agent,
    });
    const project = await host.projects.register(repo);
    const workspace = await host.workspaces.create({
      projectId: project.id,
      slug: "archive-runs",
    });
    const active = await host.sessions.create({
      workspaceId: workspace.id,
      prompt: "active",
    });
    await vi.waitFor(() => expect(agent.starts).toHaveLength(1));
    const queued = await host.sessions.send({
      sessionId: active.session.id,
      prompt: "queued",
    });
    await host.workspaces.archive({ workspaceId: workspace.id });
    expect(host.runs.get(active.run.id)?.status).toBe("cancelled");
    expect(host.runs.get(queued.run.id)?.status).toBe("cancelled");
    expect(git.archived).toEqual([workspace.worktreePath]);
    await host.close();
  });

  it("reconciles cached active workspaces against one non-destructive snapshot", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "watt-host-reconcile-"));
    const repo = await initGitRepo(root);
    const realGit = createGit();
    let inspections = 0;
    const git: GitService = {
      ...realGit,
      async inspectRepository(repoRoot) {
        inspections += 1;
        return realGit.inspectRepository(repoRoot);
      },
    };
    const host = await createHost({
      stateDir: path.join(root, "state"),
      worktreeRoot: path.join(root, "trees"),
      git,
      agent: fakeAgent(),
    });
    const project = await host.projects.register(repo);
    const healthy = await host.workspaces.create({
      projectId: project.id,
      slug: "healthy",
    });
    const mismatched = await host.workspaces.create({
      projectId: project.id,
      slug: "mismatched",
    });
    const deleted = await host.workspaces.create({
      projectId: project.id,
      slug: "deleted",
    });
    const moved = await host.workspaces.create({
      projectId: project.id,
      slug: "moved",
    });
    const archived = await host.workspaces.create({
      projectId: project.id,
      slug: "archived",
    });
    await host.workspaces.archive({ workspaceId: archived.id });

    await gitCommand(mismatched.worktreePath, [
      "switch",
      "-c",
      "manual/mismatched",
    ]);
    await rm(deleted.worktreePath, { recursive: true, force: true });
    const movedPath = path.join(root, "manually-moved");
    await gitCommand(repo, ["worktree", "move", moved.worktreePath, movedPath]);
    const untrackedPath = path.join(root, "manual-untracked");
    await gitCommand(repo, [
      "worktree",
      "add",
      "-b",
      "manual/untracked",
      untrackedPath,
      "HEAD",
    ]);
    const canonicalMovedPath = await realpath(movedPath);
    const canonicalUntrackedPath = await realpath(untrackedPath);

    const cachedBefore = host.workspaces.list({ projectId: project.id });
    expect(inspections).toBe(0);
    const beforePrune = await host.projects.reconcile({
      projectId: project.id,
    });
    expect(inspections).toBe(1);
    expect(beforePrune.entries).toContainEqual(
      expect.objectContaining({
        state: "missing",
        workspace: expect.objectContaining({ id: deleted.id }),
      }),
    );

    await gitCommand(repo, ["worktree", "prune", "--expire", "now"]);
    const report = await host.projects.reconcile({ projectId: project.id });
    expect(inspections).toBe(2);
    expect(report.repositoryIdentity).toBeTruthy();
    expect(report.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          state: "healthy",
          workspace: expect.objectContaining({ id: healthy.id }),
        }),
        expect.objectContaining({
          state: "branch_mismatch",
          workspace: expect.objectContaining({ id: mismatched.id }),
          worktree: expect.objectContaining({ branch: "manual/mismatched" }),
        }),
        expect.objectContaining({
          state: "missing",
          workspace: expect.objectContaining({ id: deleted.id }),
        }),
        expect.objectContaining({
          state: "ambiguous",
          reason: "branch_at_other_path",
          workspace: expect.objectContaining({ id: moved.id }),
          worktrees: [expect.objectContaining({ path: canonicalMovedPath })],
        }),
        expect.objectContaining({
          state: "untracked_worktree",
          worktree: expect.objectContaining({ path: canonicalUntrackedPath }),
        }),
      ]),
    );
    expect(
      report.entries.some(
        (entry) => "workspace" in entry && entry.workspace?.id === archived.id,
      ),
    ).toBe(false);
    expect(host.workspaces.list({ projectId: project.id })).toEqual(
      cachedBefore,
    );
    expect(inspections).toBe(2);
    await host.close();
    await rm(root, { recursive: true, force: true });
  });

  it("returns repository_unavailable as diagnostic state", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "watt-host-unavailable-"));
    const repo = await initGitRepo(root);
    const host = await createHost({
      stateDir: path.join(root, "state"),
      worktreeRoot: path.join(root, "trees"),
      git: createGit(),
      agent: fakeAgent(),
    });
    const project = await host.projects.register(repo);
    await rm(repo, { recursive: true, force: true });
    await expect(
      host.projects.reconcile({ projectId: project.id }),
    ).resolves.toMatchObject({
      repositoryIdentity: null,
      entries: [
        {
          state: "repository_unavailable",
          error: { code: "repo_not_found" },
        },
      ],
    });
    await host.close();
    await rm(root, { recursive: true, force: true });
  });
});
