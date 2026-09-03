import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { access, link, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { WattAgent, WattRunResult } from "@watt/agent";
import { AgentError, DEFAULT_CODEX_CATALOG } from "@watt/agent";
import { createGit, type GitService } from "@watt/git";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";

import { createHost } from "./create-host.js";
import { migrate } from "./migrate.js";

const execFileAsync = promisify(execFile);

function fakeModels() {
  return [
    {
      id: "composer-2.5",
      displayName: "Composer 2.5",
      aliases: [],
      parameters: [],
      variants: [{ displayName: "Default", params: [], isDefault: true }],
    },
  ];
}

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
  const branches = new Map<string, string>();
  return {
    created,
    archived,
    async createWorktree(input) {
      created.push(input.worktreePath);
      branches.set(input.worktreePath, input.branch);
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
    async inspectRepository(repoRoot) {
      return {
        repositoryIdentity: "/fake/repository",
        repoRoot,
        inspectedAt: Date.now(),
        worktrees: [...branches].map(([worktreePath, branch]) => ({
          path: worktreePath,
          pathExists: true,
          head: "fake-head",
          branch,
          detached: false,
          bare: false,
          locked: null,
          prunable: null,
        })),
      };
    },
    async archiveWorktree(input) {
      archived.push(input.worktreePath);
      branches.delete(input.worktreePath);
    },
    async advanceWorkspaceOperation(input) {
      if (input.type === "create_workspace") {
        if (input.target === "create_compensated") {
          archived.push(input.worktreePath);
          branches.delete(input.worktreePath);
          await rm(input.worktreePath, { recursive: true, force: true });
        } else {
          created.push(input.worktreePath);
          branches.set(input.worktreePath, input.branch);
          await mkdir(input.worktreePath, { recursive: true });
          await writeFile(path.join(input.worktreePath, ".keep"), "");
        }
        return {
          state: "advanced",
          repositoryIdentity: "/fake/repository",
          worktreePath: input.worktreePath,
          expectedHead: "fake-head",
        };
      }
      if (input.target === "git_worktree_removed") {
        archived.push(input.worktreePath);
        branches.delete(input.worktreePath);
        await rm(input.worktreePath, { recursive: true, force: true });
        return {
          state: "advanced",
          repositoryIdentity: "/fake/repository",
          worktreePath: input.worktreePath,
          expectedHead: "fake-head",
        };
      }
      return {
        state: "advanced",
        repositoryIdentity: "/fake/repository",
        worktreePath: input.worktreePath,
        expectedHead: "fake-head",
        branchOutcome: input.keepBranch ? "kept" : "deleted",
      };
    },
    changesets: {
      async preflight(input) {
        return {
          state: "ready",
          localSha: input.expectedLocalSha,
          remoteSha: input.expectedRemoteSha ?? "fake-remote-head",
        };
      },
      async apply(input) {
        return { state: "applied", head: input.remoteSha };
      },
      async resolve(input) {
        return { state: "applied", head: input.remoteSha };
      },
      async abort(input) {
        return { state: "aborted", head: input.expectedLocalSha };
      },
    },
    cloudSeed: {
      async prepare(input) {
        return {
          baseSha: input.expectedLocalSha ?? "fake-local-head",
          baseRef: input.expectedLocalSha ?? "fake-local-head",
        };
      },
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
    async listModels() {
      return fakeModels();
    },
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

function fakeCodexAgent(): WattAgent & { creates: number } {
  const agent = fakeAgent();
  let creates = 0;
  return {
    ...agent,
    creates,
    async listModels() {
      return DEFAULT_CODEX_CATALOG;
    },
    async create() {
      creates += 1;
      this.creates = creates;
      return {
        cursorAgentId: "codex-thread-1",
        async send(_prompt, options) {
          if (options?.idempotencyKey) {
            agent.idempotencyKeys.push(options.idempotencyKey);
          }
          return {
            cursorRunId: options?.idempotencyKey ?? `codex-run-${String(creates)}`,
            async *stream() {
              yield { type: "text_delta" as const, text: "codex" };
            },
            wait: async () => ({
              status: "finished" as const,
              result: "codex-result",
              durationMs: 5,
            }),
            cancel: async () => undefined,
          };
        },
      };
    },
  };
}

type ControlledRun = Awaited<ReturnType<WattAgent["getRun"]>> & {
  finish: (result?: WattRunResult) => void;
};

function controlledAgent(
  models: ReturnType<typeof fakeModels> | typeof DEFAULT_CODEX_CATALOG = fakeModels(),
  dispatchGate?: Promise<void>,
): WattAgent & {
  starts: Array<{
    prompt: string;
    idempotencyKey: string | undefined;
    run: ControlledRun;
  }>;
  recovered: string[];
  cancelled: string[];
  dispatching: string[];
} {
  const starts: Array<{
    prompt: string;
    idempotencyKey: string | undefined;
    run: ControlledRun;
  }> = [];
  const recovered: string[] = [];
  const cancelled: string[] = [];
  const dispatching: string[] = [];
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
      async *stream(options) {
        yield { type: "text_delta" as const, text: prompt };
        if (!options?.signal) {
          await result;
          return;
        }
        if (options.signal.aborted) return;
        let removeAbortListener = () => {};
        await Promise.race([
          result,
          new Promise<void>((done) => {
            const onAbort = () => done();
            options.signal?.addEventListener("abort", onAbort, { once: true });
            removeAbortListener = () => options.signal?.removeEventListener("abort", onAbort);
          }),
        ]);
        removeAbortListener();
      },
      wait: () => result,
      async cancel() {
        cancelled.push(cursorRunId);
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
        dispatching.push(prompt);
        await dispatchGate;
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
    cancelled,
    dispatching,
    async listModels() {
      return models;
    },
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

  it("prevents separate CLI- and sidecar-shaped processes from sharing recovery ownership", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "watt-host-process-lease-"));
    const stateDir = path.join(root, "state");
    const owners = path.join(stateDir, ".watt-locks", "owners");
    await mkdir(owners, { recursive: true });
    const child = spawn(
      process.execPath,
      ["-e", "process.stdout.write(String(process.pid)); setInterval(() => {}, 1000)"],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    const [pidChunk] = (await once(child.stdout!, "data")) as [Buffer];
    const pid = Number(pidChunk.toString());
    let fingerprint: string;
    if (process.platform === "linux") {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      fingerprint = `linux:${fields[19]}`;
    } else {
      const result = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)]);
      fingerprint = `${process.platform}:${result.stdout.trim()}`;
    }
    const leaseId = "live-sidecar-owner";
    const ownerPath = path.join(owners, `${leaseId}.json`);
    await writeFile(
      ownerPath,
      `${JSON.stringify({
        schemaVersion: 1,
        leaseId,
        stateDir,
        pid,
        hostname: hostname(),
        processStartFingerprint: fingerprint,
        acquiredAt: Date.now(),
      })}\n`,
    );
    await link(ownerPath, path.join(stateDir, ".watt-locks", "host.lock"));

    try {
      await expect(
        createHost({
          stateDir,
          worktreeRoot: path.join(root, "trees"),
          leaseTimeoutMs: 25,
          git: fakeGit(),
          agent: fakeAgent(),
        }),
      ).rejects.toMatchObject({ code: "host_busy" });
    } finally {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
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
    expect(database.pragma("user_version", { simple: true })).toBe(5);
    expect(database.prepare("SELECT runtime FROM sessions WHERE id = 'session'").get()).toEqual({
      runtime: "cursor-local",
    });
    expect(database.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(database.pragma("busy_timeout", { simple: true })).toBe(5000);
    const workspaceIndexes = database.pragma("index_list(workspaces)") as Array<{
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
    const operationIndexes = database.pragma("index_list(operations)") as Array<{
      name: string;
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
      expect.arrayContaining([expect.objectContaining({ name: "sessions_workspace_history" })]),
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
    expect(operationIndexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "operations_project_history" }),
        expect.objectContaining({ name: "operations_workspace_history" }),
        expect.objectContaining({ name: "operations_recovery", partial: 1 }),
      ]),
    );
    expect(() =>
      database
        .prepare(
          `INSERT INTO operations (
            schema_version, id, type, project_id, workspace_id,
            requested_json, phase, created_at, updated_at
          ) VALUES (1, 'invalid-operation', 'create_workspace', 'project',
            'workspace', '{}', 'active_runs_handled', 4, 4)`,
        )
        .run(),
    ).toThrow();
    expect(database.prepare("SELECT COUNT(*) AS count FROM workspaces").get()).toEqual({
      count: 1,
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM sessions").get()).toEqual({ count: 1 });
    const migratedSession = database
      .prepare("SELECT model_params_json, execution_policy_json FROM sessions WHERE id = 'session'")
      .get() as {
      model_params_json: string;
      execution_policy_json: string;
    };
    expect(JSON.parse(migratedSession.model_params_json)).toEqual([]);
    expect(JSON.parse(migratedSession.execution_policy_json)).toEqual({
      autoReview: false,
      sandbox: { enabled: false },
      agentRetries: true,
      toolAllowlist: null,
      toolDenylist: [],
      settingSources: ["project", "user", "plugins"],
    });
    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'capability_cache'",
        )
        .get(),
    ).toEqual({ name: "capability_cache" });
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
    expect(database.prepare("SELECT COUNT(*) AS count FROM workspaces").get()).toEqual({
      count: 2,
    });
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

    expect(database.pragma("user_version", { simple: true })).toBe(5);
    expect(database.prepare("SELECT COUNT(*) AS count FROM sessions").get()).toEqual({ count: 1 });
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

  it("surfaces completed operation history without adding it to cached workspace reads", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "watt-host-diagnostics-"));
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
      slug: "diagnostics",
    });

    expect(host.diagnostics.operations.list({ projectId: project.id })).toEqual([]);
    const completed = host.diagnostics.operations.list({
      projectId: project.id,
      includeCompleted: true,
    });
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      type: "create_workspace",
      workspaceId: workspace.id,
      phase: "operation_completed",
      terminalOutcome: "succeeded",
    });
    expect(host.diagnostics.operations.get({ operationId: completed[0]!.id })).toEqual(
      completed[0],
    );
    expect(git.created).toHaveLength(1);
    expect(host.workspaces.list({ projectId: project.id })).toEqual([workspace]);
    expect(git.created).toHaveLength(1);
    await host.close();
  });

  it("recovers rewound create and archive phases idempotently on startup", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "watt-host-operation-recovery-"));
    const repo = await initGitRepo(root);
    const stateDir = path.join(root, "state");
    const worktreeRoot = path.join(root, "trees");
    const git = createGit();
    const agent = fakeAgent();
    let host = await createHost({ stateDir, worktreeRoot, git, agent });
    const project = await host.projects.register(repo);
    const workspace = await host.workspaces.create({
      projectId: project.id,
      slug: "recover-operation",
    });
    const createOperation = host.diagnostics.operations.list({
      workspaceId: workspace.id,
      includeCompleted: true,
    })[0]!;
    await host.close();

    const createPhases = [
      "intent_recorded",
      "git_worktree_created",
      "path_verified",
      "workspace_row_committed",
      "operation_completed",
    ] as const;
    for (const [index, phase] of createPhases.entries()) {
      const database = new Database(path.join(stateDir, "watt.sqlite"));
      database.pragma("foreign_keys = ON");
      if (
        phase === "intent_recorded" ||
        phase === "git_worktree_created" ||
        phase === "path_verified"
      ) {
        database.prepare("DELETE FROM workspaces WHERE id = ?").run(workspace.id);
      }
      database
        .prepare(
          "UPDATE operations SET phase = ?, terminal_outcome = NULL, terminal_at = NULL WHERE id = ?",
        )
        .run(phase, createOperation.id);
      database.close();

      host = await createHost({ stateDir, worktreeRoot, git, agent });
      expect(host.workspaces.get(workspace.id)).toMatchObject({
        archivedAt: null,
      });
      expect(host.diagnostics.operations.get({ operationId: createOperation.id })).toMatchObject({
        phase: "operation_completed",
        terminalOutcome: "succeeded",
        recoveryAttemptCount: index + 1,
      });
      if (index < createPhases.length - 1) await host.close();
    }
    await host.workspaces.archive({ workspaceId: workspace.id });
    const archiveOperation = host.diagnostics.operations
      .list({ workspaceId: workspace.id, includeCompleted: true })
      .find((operation) => operation.type === "archive_workspace")!;
    await host.close();
    const archivePhases = [
      "intent_recorded",
      "active_runs_handled",
      "git_worktree_removed",
      "branch_outcome_recorded",
      "workspace_archived",
    ] as const;
    for (const [index, phase] of archivePhases.entries()) {
      const database = new Database(path.join(stateDir, "watt.sqlite"));
      if (phase !== "workspace_archived") {
        database.prepare("UPDATE workspaces SET archived_at = NULL WHERE id = ?").run(workspace.id);
      }
      database
        .prepare(
          "UPDATE operations SET phase = ?, terminal_outcome = NULL, terminal_at = NULL WHERE id = ?",
        )
        .run(phase, archiveOperation.id);
      database.close();

      host = await createHost({ stateDir, worktreeRoot, git, agent });
      expect(host.workspaces.get(workspace.id)).toMatchObject({
        archivedAt: expect.any(Number),
      });
      expect(host.diagnostics.operations.get({ operationId: archiveOperation.id })).toMatchObject({
        phase: "workspace_archived",
        terminalOutcome: "succeeded",
        recoveryAttemptCount: index + 1,
      });
      await host.close();
    }
    host = await createHost({ stateDir, worktreeRoot, git, agent });
    expect(host.diagnostics.operations.get({ operationId: archiveOperation.id })).toMatchObject({
      recoveryAttemptCount: 5,
      terminalOutcome: "succeeded",
    });
    await host.close();
    await rm(root, { recursive: true, force: true });
  });

  it("marks mismatched recovery as needs_attention without deleting Git state", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "watt-host-operation-attention-"));
    const repo = await initGitRepo(root);
    const stateDir = path.join(root, "state");
    const worktreeRoot = path.join(root, "trees");
    const git = createGit();
    const agent = fakeAgent();
    let host = await createHost({ stateDir, worktreeRoot, git, agent });
    const project = await host.projects.register(repo);
    const workspace = await host.workspaces.create({
      projectId: project.id,
      slug: "attention",
    });
    const operation = host.diagnostics.operations.list({
      workspaceId: workspace.id,
      includeCompleted: true,
    })[0]!;
    await host.close();
    await gitCommand(workspace.worktreePath, ["switch", "-c", "manual/attention"]);

    const database = new Database(path.join(stateDir, "watt.sqlite"));
    database.pragma("foreign_keys = ON");
    database.prepare("DELETE FROM workspaces WHERE id = ?").run(workspace.id);
    database
      .prepare(
        "UPDATE operations SET phase = 'git_worktree_created', terminal_outcome = NULL, terminal_at = NULL WHERE id = ?",
      )
      .run(operation.id);
    database.close();

    host = await createHost({ stateDir, worktreeRoot, git, agent });
    expect(host.diagnostics.operations.get({ operationId: operation.id })).toMatchObject({
      terminalOutcome: "needs_attention",
      compensationOutcome: "unsafe",
    });
    expect(host.workspaces.get(workspace.id)).toBeUndefined();
    await access(workspace.worktreePath);
    expect((await git.listWorktrees(repo))[1]).toMatchObject({
      branch: "manual/attention",
    });
    await host.close();
    await rm(root, { recursive: true, force: true });
  });

  it("revalidates Git identity after a persisted path_verified create phase", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "watt-host-path-verified-drift-"));
    const repo = await initGitRepo(root);
    const stateDir = path.join(root, "state");
    const worktreeRoot = path.join(root, "trees");
    const git = createGit();
    const agent = fakeAgent();
    let host = await createHost({ stateDir, worktreeRoot, git, agent });
    const project = await host.projects.register(repo);
    const workspace = await host.workspaces.create({
      projectId: project.id,
      slug: "path-verified-drift",
    });
    const operation = host.diagnostics.operations.list({
      workspaceId: workspace.id,
      includeCompleted: true,
    })[0]!;
    await host.close();

    await gitCommand(workspace.worktreePath, ["switch", "-c", "manual/path-verified-drift"]);
    const database = new Database(path.join(stateDir, "watt.sqlite"));
    database.pragma("foreign_keys = ON");
    database.prepare("DELETE FROM workspaces WHERE id = ?").run(workspace.id);
    database
      .prepare(
        "UPDATE operations SET phase = 'path_verified', terminal_outcome = NULL, terminal_at = NULL WHERE id = ?",
      )
      .run(operation.id);
    database.close();

    host = await createHost({ stateDir, worktreeRoot, git, agent });
    expect(host.workspaces.get(workspace.id)).toBeUndefined();
    expect(host.diagnostics.operations.get({ operationId: operation.id })).toMatchObject({
      terminalOutcome: "needs_attention",
      compensationOutcome: "unsafe",
      diagnostic: { code: "worktree_mismatch" },
    });
    expect((await git.listWorktrees(repo))[1]).toMatchObject({
      branch: "manual/path-verified-drift",
    });
    await host.close();
    await rm(root, { recursive: true, force: true });
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
    const [firstEvents, duplicateEvents] = await Promise.all([firstAttachment, secondAttachment]);
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
    await expect(host.runs.wait({ runId: second.run.id })).resolves.toMatchObject({
      status: "finished",
    });
    await host.close();
  });

  it("aborts an idle run attachment without cancelling the run", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "watt-host-attach-abort-"));
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
      slug: "abort-attach",
    });
    const created = await host.sessions.create({
      workspaceId: workspace.id,
      prompt: "still-running",
    });
    await vi.waitFor(() => expect(agent.starts).toHaveLength(1));

    const controller = new AbortController();
    const iterator = host.runs
      .attach({
        runId: created.run.id,
        afterSequence: 1,
        signal: controller.signal,
      })
      [Symbol.asyncIterator]();
    const pending = iterator.next();
    controller.abort();

    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    expect(host.runs.get(created.run.id)?.status).toBe("running");
    agent.starts[0]?.run.finish();
    await expect(host.runs.wait({ runId: created.run.id })).resolves.toMatchObject({
      status: "finished",
    });
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
    expect(new Set(agent.starts.map((start) => start.prompt))).toEqual(new Set(["one", "two"]));
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

    const queuedWait = expect(host.runs.wait({ runId: queued.run.id })).rejects.toMatchObject({
      code: "host_closed",
    });
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
    await expect(reopened.runs.wait({ runId: queued.run.id })).resolves.toMatchObject({
      status: "finished",
    });
    await reopened.close();
  });

  it("suspends and recovers an active Cursor run without cancelling it", async () => {
    const runtime = "cursor-local" as const;
    const root = await mkdtemp(path.join(tmpdir(), `watt-host-suspend-${runtime}-`));
    const repo = path.join(root, "repo");
    await mkdir(repo);
    const stateDir = path.join(root, "state");
    const worktreeRoot = path.join(root, "trees");
    const git = fakeGit();
    const cursor = controlledAgent();
    const codex = controlledAgent(DEFAULT_CODEX_CATALOG);
    const activeAgent = runtime === "codex-local" ? codex : cursor;
    const options = {
      stateDir,
      worktreeRoot,
      git,
      agent: cursor,
      codexAgent: codex,
    };
    const host = await createHost(options);
    const project = await host.projects.register(repo);
    const workspace = await host.workspaces.create({
      projectId: project.id,
      slug: `suspend-${runtime}`,
    });
    const created = await host.sessions.create({
      workspaceId: workspace.id,
      prompt: `continue-${runtime}`,
      runtime,
    });
    await vi.waitFor(() => expect(activeAgent.starts).toHaveLength(1));

    const suspended = host.suspend();
    expect(host.suspend()).toBe(suspended);
    await suspended;
    expect(activeAgent.cancelled).toEqual([]);
    expect(() => host.runs.get(created.run.id)).toThrow(
      expect.objectContaining({ code: "host_closed" }),
    );

    const reopened = await createHost(options);
    await vi.waitFor(() => expect(activeAgent.recovered).toHaveLength(1));
    expect(reopened.runs.get(created.run.id)?.status).toBe("running");
    activeAgent.starts[0]?.run.finish();
    await expect(reopened.runs.wait({ runId: created.run.id })).resolves.toMatchObject({
      status: "finished",
    });
    expect(activeAgent.cancelled).toEqual([]);
    await reopened.close();
  });

  it("cancels and settles an active Codex run before suspending", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "watt-host-suspend-codex-"));
    const repo = path.join(root, "repo");
    await mkdir(repo);
    const stateDir = path.join(root, "state");
    const worktreeRoot = path.join(root, "trees");
    const git = fakeGit();
    const cursor = controlledAgent();
    let releaseDispatch!: () => void;
    const dispatchGate = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    const codex = controlledAgent(DEFAULT_CODEX_CATALOG, dispatchGate);
    const options = {
      stateDir,
      worktreeRoot,
      git,
      agent: cursor,
      codexAgent: codex,
    };
    const host = await createHost(options);
    const project = await host.projects.register(repo);
    const workspace = await host.workspaces.create({
      projectId: project.id,
      slug: "suspend-codex",
    });
    const created = await host.sessions.create({
      workspaceId: workspace.id,
      prompt: "cancel-codex",
      runtime: "codex-local",
    });
    await vi.waitFor(() => expect(codex.dispatching).toHaveLength(1));

    const suspended = host.suspend();
    releaseDispatch();
    await suspended;
    expect(codex.cancelled).toEqual([codex.starts[0]?.run.cursorRunId]);

    const reopened = await createHost(options);
    expect(reopened.runs.get(created.run.id)?.status).toBe("cancelled");
    expect(codex.recovered).toEqual([]);
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
    await expect(recovered.runs.wait({ runId: created.run.id })).resolves.toMatchObject({
      status: "finished",
      result: "recover-me-done",
    });
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
    await expect(retried.runs.wait({ runId: created.run.id })).resolves.toMatchObject({
      status: "finished",
      result: "retry-me-done",
    });
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
    inspections = 0;

    await gitCommand(mismatched.worktreePath, ["switch", "-c", "manual/mismatched"]);
    await rm(deleted.worktreePath, { recursive: true, force: true });
    const movedPath = path.join(root, "manually-moved");
    await gitCommand(repo, ["worktree", "move", moved.worktreePath, movedPath]);
    const untrackedPath = path.join(root, "manual-untracked");
    await gitCommand(repo, ["worktree", "add", "-b", "manual/untracked", untrackedPath, "HEAD"]);
    const canonicalMovedPath = await realpath(movedPath);
    const canonicalUntrackedPath = await realpath(untrackedPath);

    const setupInspections = inspections;
    const cachedBefore = host.workspaces.list({ projectId: project.id });
    expect(inspections).toBe(setupInspections);
    const beforePrune = await host.projects.reconcile({
      projectId: project.id,
    });
    expect(inspections).toBe(setupInspections + 1);
    expect(beforePrune.entries).toContainEqual(
      expect.objectContaining({
        state: "missing",
        workspace: expect.objectContaining({ id: deleted.id }),
      }),
    );

    await gitCommand(repo, ["worktree", "prune", "--expire", "now"]);
    const report = await host.projects.reconcile({ projectId: project.id });
    expect(inspections).toBe(setupInspections + 2);
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
      report.entries.some((entry) => "workspace" in entry && entry.workspace?.id === archived.id),
    ).toBe(false);
    expect(host.workspaces.list({ projectId: project.id })).toEqual(cachedBefore);
    expect(inspections).toBe(setupInspections + 2);
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
    await expect(host.projects.reconcile({ projectId: project.id })).resolves.toMatchObject({
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

  it("persists structured model, Plan mode, and effective policy across resume", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "watt-host-policy-"));
    const repo = path.join(root, "repo");
    await mkdir(repo);
    const agent = fakeAgent();
    const createSpy = vi.spyOn(agent, "create");
    const resumeSpy = vi.spyOn(agent, "resume");
    const trustedTool = {
      name: "trusted_tool",
      description: "trusted construction-time tool",
      execute: () => ({ ok: true }),
    };
    const options = {
      stateDir: path.join(root, "state"),
      worktreeRoot: path.join(root, "trees"),
      git: fakeGit(),
      agent,
      executionPolicy: { toolDenylist: ["delete"] },
      customTools: [trustedTool],
    };
    const host = await createHost(options);
    const capabilities = await host.capabilities();
    expect(capabilities).toMatchObject({
      runtime: "cursor-local",
      modes: ["agent", "plan"],
      modelCatalog: { status: "live" },
      executionPolicy: {
        defaults: {
          autoReview: false,
          sandbox: { enabled: false },
          agentRetries: true,
          toolAllowlist: null,
          toolDenylist: ["delete"],
          settingSources: ["project", "user", "plugins"],
        },
      },
    });
    const project = await host.projects.register(repo);
    const workspace = await host.workspaces.create({
      projectId: project.id,
      slug: "policy",
    });
    const created = await host.sessions.create({
      workspaceId: workspace.id,
      prompt: "plan it",
      mode: "plan",
      executionPolicy: {
        toolAllowlist: ["read", "mcp"],
        toolDenylist: ["shell"],
      },
    });
    expect(created.session).toMatchObject({
      mode: "plan",
      model: { id: "composer-2.5", params: [] },
      executionPolicy: {
        autoReview: false,
        sandbox: { enabled: false },
        agentRetries: true,
        toolAllowlist: ["read", "mcp"],
        toolDenylist: ["shell"],
      },
    });
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "plan",
        model: { id: "composer-2.5", params: [] },
        executionPolicy: created.session.executionPolicy,
        customTools: [trustedTool],
      }),
    );
    await host.runs.wait({ runId: created.run.id });
    await host.close();

    const reopened = await createHost(options);
    const sent = await reopened.sessions.send({
      sessionId: created.session.id,
      prompt: "continue",
    });
    await reopened.runs.wait({ runId: sent.run.id });
    expect(resumeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "plan",
        model: { id: "composer-2.5", params: [] },
        executionPolicy: created.session.executionPolicy,
        customTools: [trustedTool],
      }),
    );
    expect(reopened.sessions.get(created.session.id)).toEqual(created.session);
    await reopened.close();
  });

  it("rejects duplicate or builtin custom tools at Host construction", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "watt-host-tools-"));
    const base = {
      stateDir: path.join(root, "state"),
      worktreeRoot: path.join(root, "trees"),
      git: fakeGit(),
      agent: fakeAgent(),
    };
    const tool = {
      name: "duplicate",
      description: "duplicate",
      execute: () => "ok",
    };
    await expect(createHost({ ...base, customTools: [tool, tool] })).rejects.toMatchObject({
      code: "invalid_options",
    });
    await expect(
      createHost({
        ...base,
        customTools: [
          {
            ...tool,
            name: "watt_workspace_info",
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "invalid_options" });
  });

  it("persists and replays structured custom-tool results without flattening", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "watt-host-tool-results-"));
    const repo = path.join(root, "repo");
    await mkdir(repo);
    const agent = fakeAgent();
    const structuredResult = {
      content: [{ type: "text", text: "tool failed" }],
      structuredContent: { reason: "expected" },
      isError: true,
    };
    vi.spyOn(agent, "create").mockResolvedValue({
      cursorAgentId: "structured-agent",
      async send() {
        return {
          cursorRunId: "structured-run",
          async *stream() {
            yield {
              type: "tool_result" as const,
              callId: "call-1",
              name: "trusted_tool",
              result: structuredResult,
              ok: false,
            };
          },
          wait: async () => ({ status: "finished" as const }),
          cancel: async () => undefined,
        };
      },
    });
    const options = {
      stateDir: path.join(root, "state"),
      worktreeRoot: path.join(root, "trees"),
      git: fakeGit(),
      agent,
    };
    const host = await createHost(options);
    const project = await host.projects.register(repo);
    const workspace = await host.workspaces.create({
      projectId: project.id,
      slug: "tool-results",
    });
    const created = await host.sessions.create({
      workspaceId: workspace.id,
      prompt: "use tool",
    });
    const liveEvents = [];
    for await (const event of host.runs.attach({ runId: created.run.id })) {
      liveEvents.push(event);
    }
    expect(liveEvents).toContainEqual(
      expect.objectContaining({
        type: "tool_result",
        result: structuredResult,
        ok: false,
      }),
    );
    await host.close();

    const reopened = await createHost(options);
    const replayed = [];
    for await (const event of reopened.runs.attach({ runId: created.run.id })) {
      replayed.push(event);
    }
    expect(replayed).toEqual(liveEvents);
    await reopened.close();
  });

  it("uses the persisted model catalog on discovery failure and fails closed without one", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "watt-host-catalog-"));
    const agent = fakeAgent();
    const options = {
      stateDir: path.join(root, "state"),
      worktreeRoot: path.join(root, "trees"),
      git: fakeGit(),
      agent,
    };
    const host = await createHost(options);
    const live = await host.capabilities();
    expect(live.modelCatalog.status).toBe("live");
    await host.close();

    vi.spyOn(agent, "listModels").mockRejectedValue(new Error("offline"));
    const cachedHost = await createHost(options);
    await expect(cachedHost.capabilities()).resolves.toMatchObject({
      models: [expect.objectContaining({ id: "composer-2.5" })],
      modelCatalog: {
        status: "cached",
        fetchedAt: live.modelCatalog.fetchedAt,
        error: { message: "offline" },
      },
    });
    await cachedHost.close();

    const emptyRoot = await mkdtemp(path.join(tmpdir(), "watt-host-no-catalog-"));
    const unavailable = await createHost({
      stateDir: path.join(emptyRoot, "state"),
      worktreeRoot: path.join(emptyRoot, "trees"),
      git: fakeGit(),
      agent,
    });
    await expect(unavailable.capabilities()).resolves.toMatchObject({
      models: [],
      modelCatalog: { status: "unavailable", fetchedAt: null },
    });
    const repo = path.join(emptyRoot, "repo");
    await mkdir(repo);
    const project = await unavailable.projects.register(repo);
    const workspace = await unavailable.workspaces.create({
      projectId: project.id,
      slug: "unavailable",
    });
    await expect(
      unavailable.sessions.create({
        workspaceId: workspace.id,
        prompt: "blocked",
      }),
    ).rejects.toMatchObject({ code: "model_catalog_unavailable" });
    await unavailable.close();
  });

  it("rejects unsupported selections and model disappearance before dispatch", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "watt-host-models-"));
    const repo = path.join(root, "repo");
    await mkdir(repo);
    const agent = fakeAgent();
    const models = vi.spyOn(agent, "listModels").mockResolvedValue([
      {
        id: "model-a",
        displayName: "Model A",
        aliases: ["a"],
        parameters: [
          {
            id: "effort",
            values: [{ value: "low" }, { value: "high" }],
          },
        ],
        variants: [],
      },
    ]);
    const createSpy = vi.spyOn(agent, "create");
    const host = await createHost({
      stateDir: path.join(root, "state"),
      worktreeRoot: path.join(root, "trees"),
      git: fakeGit(),
      agent,
    });
    const project = await host.projects.register(repo);
    const workspace = await host.workspaces.create({
      projectId: project.id,
      slug: "models",
    });
    await expect(
      host.sessions.create({
        workspaceId: workspace.id,
        prompt: "bad",
        model: { id: "a", params: [{ id: "effort", value: "medium" }] },
      }),
    ).rejects.toMatchObject({ code: "unsupported_model_parameter" });
    expect(createSpy).not.toHaveBeenCalled();

    const created = await host.sessions.create({
      workspaceId: workspace.id,
      prompt: "good",
      model: { id: "a", params: [{ id: "effort", value: "high" }] },
    });
    expect(created.session.model).toEqual({
      id: "model-a",
      params: [{ id: "effort", value: "high" }],
    });
    await host.runs.wait({ runId: created.run.id });
    models.mockResolvedValue([
      {
        id: "model-b",
        displayName: "Model B",
        aliases: [],
        parameters: [],
        variants: [],
      },
    ]);
    await expect(
      host.sessions.send({ sessionId: created.session.id, prompt: "again" }),
    ).rejects.toMatchObject({ code: "model_unavailable" });
    await host.close();
  });

  it("fails a persisted queued follow-up without dispatch when its model disappears", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "watt-host-queued-model-"));
    const repo = path.join(root, "repo");
    await mkdir(repo);
    const agent = controlledAgent();
    const models = vi.spyOn(agent, "listModels");
    const options = {
      stateDir: path.join(root, "state"),
      worktreeRoot: path.join(root, "trees"),
      git: fakeGit(),
      agent,
    };
    const host = await createHost(options);
    const project = await host.projects.register(repo);
    const workspace = await host.workspaces.create({
      projectId: project.id,
      slug: "queued-model",
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
    await host.close();
    expect(agent.starts).toHaveLength(1);

    models.mockResolvedValue([
      {
        id: "replacement",
        displayName: "Replacement",
        aliases: [],
        parameters: [],
        variants: [],
      },
    ]);
    const reopened = await createHost(options);
    await expect(reopened.runs.wait({ runId: queued.run.id })).resolves.toMatchObject({
      status: "error",
      error: { code: "model_unavailable" },
    });
    expect(agent.starts).toHaveLength(1);
    await reopened.close();
  });

  it("dispatches Codex sessions to the Codex agent and rejects plan mode", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "watt-host-codex-"));
    const repo = path.join(root, "repo");
    await mkdir(repo);
    const cursor = fakeAgent();
    const codex = fakeCodexAgent();
    const createSpy = vi.spyOn(codex, "create");
    const cursorCreate = vi.spyOn(cursor, "create");
    const host = await createHost({
      stateDir: path.join(root, "state"),
      worktreeRoot: path.join(root, "trees"),
      git: fakeGit(),
      agent: cursor,
      codexAgent: codex,
    });
    const capabilities = await host.capabilities();
    expect(capabilities.runtimes.map((runtime) => runtime.id)).toEqual([
      "cursor-local",
      "codex-local",
    ]);
    expect(capabilities.runtimes.find((runtime) => runtime.id === "codex-local")).toMatchObject({
      modes: ["agent"],
      executionPolicy: { controls: ["sandbox"] },
      models: expect.arrayContaining([expect.objectContaining({ id: "codex:gpt-5.5" })]),
    });
    const project = await host.projects.register(repo);
    const workspace = await host.workspaces.create({
      projectId: project.id,
      slug: "codex",
    });
    await expect(
      host.sessions.create({
        workspaceId: workspace.id,
        runtime: "codex-local",
        mode: "plan",
        prompt: "plan",
      }),
    ).rejects.toMatchObject({ code: "mode_unsupported" });
    expect(createSpy).not.toHaveBeenCalled();

    const created = await host.sessions.create({
      workspaceId: workspace.id,
      runtime: "codex-local",
      prompt: "implement",
    });
    expect(created.session).toMatchObject({
      runtime: "codex-local",
      cursorAgentId: "codex-thread-1",
      model: { id: "codex:gpt-5.5" },
    });
    expect(cursorCreate).not.toHaveBeenCalled();
    expect(createSpy).toHaveBeenCalledOnce();
    await expect(host.runs.wait({ runId: created.run.id })).resolves.toMatchObject({
      status: "finished",
      result: "codex-result",
    });
    const followUp = await host.sessions.send({
      sessionId: created.session.id,
      prompt: "continue",
    });
    expect(await host.runs.wait({ runId: followUp.run.id })).toEqual({
      runId: followUp.run.id,
      status: "finished",
      result: "codex-result",
      durationMs: 5,
    });
    expect(createSpy).toHaveBeenCalledOnce();
    expect(cursorCreate).not.toHaveBeenCalled();
    await host.close();
    await rm(root, { recursive: true, force: true });
  });

  it("fails Codex sessions with codex_auth_unavailable when the catalog reports it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "watt-host-codex-auth-"));
    const repo = path.join(root, "repo");
    await mkdir(repo);
    const cursor = fakeAgent();
    const error = Object.assign(new Error("not logged in"), {
      code: "codex_auth_unavailable",
    });
    const host = await createHost({
      stateDir: path.join(root, "state"),
      worktreeRoot: path.join(root, "trees"),
      git: fakeGit(),
      agent: cursor,
      codexAgent: {
        ...fakeCodexAgent(),
        async listModels() {
          throw error;
        },
      },
    });
    const project = await host.projects.register(repo);
    const workspace = await host.workspaces.create({
      projectId: project.id,
      slug: "auth",
    });
    await expect(
      host.sessions.create({
        workspaceId: workspace.id,
        runtime: "codex-local",
        prompt: "go",
      }),
    ).rejects.toMatchObject({ code: "codex_auth_unavailable" });
    await host.close();
    await rm(root, { recursive: true, force: true });
  });

  it("fails Codex sessions with codex_auth_unavailable when startThread fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "watt-host-codex-create-auth-"));
    const repo = path.join(root, "repo");
    await mkdir(repo);
    const cursor = fakeAgent();
    const host = await createHost({
      stateDir: path.join(root, "state"),
      worktreeRoot: path.join(root, "trees"),
      git: fakeGit(),
      agent: cursor,
      codexAgent: {
        ...fakeCodexAgent(),
        async create() {
          throw new AgentError("Run `codex login`", "codex_auth_unavailable");
        },
      },
    });
    const project = await host.projects.register(repo);
    const workspace = await host.workspaces.create({
      projectId: project.id,
      slug: "create-auth",
    });
    await expect(
      host.sessions.create({
        workspaceId: workspace.id,
        runtime: "codex-local",
        prompt: "go",
      }),
    ).rejects.toMatchObject({
      name: "HostError",
      code: "codex_auth_unavailable",
    });
    await host.close();
    await rm(root, { recursive: true, force: true });
  });

  it("replays changeset pulls durably and refuses integration while a workspace is busy", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "watt-host-changeset-"));
    const repo = path.join(root, "repo");
    await mkdir(repo);
    const git = fakeGit();
    const preflight = vi.spyOn(git.changesets, "preflight");
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
      slug: "changeset",
    });
    const input = {
      changesetId: "changeset-12345678",
      workspaceId: workspace.id,
      remote: "origin",
      branch: "watt/cloud/chat",
      expectedLocalSha: "a".repeat(40),
      expectedRemoteSha: "b".repeat(40),
      idempotencyKey: "pull-12345678",
    };

    const first = await host.changesets.pull(input);
    await expect(host.changesets.pull(input)).resolves.toEqual(first);
    expect(preflight).toHaveBeenCalledTimes(1);
    await expect(
      host.changesets.pull({ ...input, branch: "watt/cloud/other" }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });

    await host.sessions.create({
      workspaceId: workspace.id,
      prompt: "stay active",
    });
    await vi.waitFor(() => expect(agent.starts).toHaveLength(1));
    await expect(
      host.changesets.pull({
        ...input,
        idempotencyKey: "pull-busy-12345678",
      }),
    ).rejects.toMatchObject({ code: "workspace_busy" });
    await host.close();
  });

  it("bounds the idempotency key used for conflict resolvers", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "watt-host-resolver-key-"));
    const repo = path.join(root, "repo");
    await mkdir(repo);
    const git = fakeGit();
    vi.spyOn(git.changesets, "resolve").mockResolvedValue({
      state: "resolving",
      head: "b".repeat(40),
    });
    const host = await createHost({
      stateDir: path.join(root, "state"),
      worktreeRoot: path.join(root, "trees"),
      git,
      agent: fakeAgent(),
    });
    const project = await host.projects.register(repo);
    const workspace = await host.workspaces.create({
      projectId: project.id,
      slug: "resolver-key",
    });

    await expect(
      host.changesets.resolve({
        changesetId: "changeset-12345678",
        workspaceId: workspace.id,
        remote: "origin",
        branch: "watt/cloud/chat",
        expectedLocalSha: "a".repeat(40),
        expectedRemoteSha: "b".repeat(40),
        remoteSha: "b".repeat(40),
        idempotencyKey: "r".repeat(200),
      }),
    ).resolves.toMatchObject({ state: "resolving" });

    await host.close();
    const database = new Database(path.join(root, "state", "watt.sqlite"));
    const replay = database
      .prepare("SELECT idempotency_key FROM mutation_replays WHERE operation = 'sessions.create'")
      .get() as { idempotency_key: string } | undefined;
    expect(replay?.idempotency_key).toHaveLength(200);
    expect(replay?.idempotency_key.endsWith(":resolver")).toBe(true);
    database.close();
    await rm(root, { recursive: true, force: true });
  });
});
