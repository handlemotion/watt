import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";

import {
  createAgent,
  createSdkRuntime,
  type AgentEvent,
  type WattAgent,
  type WattRun,
  type WattRunResult,
  type WattSessionHandle,
} from "@watt/agent";
import { createGit, isPathInside, type GitService } from "@watt/git";
import Database from "better-sqlite3";
import { ulid } from "ulid";

import { HostError, isUniqueConstraint } from "./errors.js";
import { acquireHostLease } from "./lease.js";
import { migrate } from "./migrate.js";
import { reconcileProject } from "./reconcile.js";
import { assertSlug } from "./slug.js";
import { createState, type StoredRun } from "./state.js";
import type {
  CreateHostOptions,
  Host,
  HostEvent,
  Project,
  Run,
  RunResult,
  Session,
  Workspace,
} from "./types.js";

function now(): number {
  return Date.now();
}

const DEFAULT_LEASE_TIMEOUT_MS = 5_000;

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "unknown host run failure";
}

function failure(runId: string, code: string, error: unknown): RunResult {
  return {
    runId,
    status: "error",
    error: { message: errorMessage(error), code },
  };
}

export async function createHost(options: CreateHostOptions): Promise<Host> {
  const leaseTimeoutMs = options.leaseTimeoutMs ?? DEFAULT_LEASE_TIMEOUT_MS;
  if (!Number.isFinite(leaseTimeoutMs) || leaseTimeoutMs <= 0) {
    throw new HostError("leaseTimeoutMs must be positive", "invalid_options");
  }
  await mkdir(options.stateDir, { recursive: true });
  await mkdir(options.worktreeRoot, { recursive: true });
  const stateDir = await realpath(options.stateDir);
  const worktreeRoot = await realpath(options.worktreeRoot);
  const hostLease = await acquireHostLease(stateDir, leaseTimeoutMs);
  const sqlitePath = path.join(stateDir, "watt.sqlite");
  let database: InstanceType<typeof Database>;
  try {
    database = new Database(sqlitePath);
  } catch (error) {
    await hostLease.release();
    throw error;
  }
  let state: ReturnType<typeof createState>;
  try {
    migrate(database);
    state = createState(database);
  } catch (error) {
    database.close();
    await hostLease.release();
    throw error;
  }
  const git: GitService = options.git ?? createGit();
  const agent: WattAgent =
    options.agent ??
    createAgent({ runtime: createSdkRuntime(), apiKey: options.apiKey });

  let closing = false;
  let closed = false;
  let closePromise: Promise<void> | undefined;
  const schedulers = new Map<string, Promise<void>>();
  const sessionHandles = new Map<string, WattSessionHandle>();
  const activeRuns = new Map<string, WattRun>();
  const cancelRequested = new Set<string>();
  const runVersions = new Map<string, number>();
  const runWaiters = new Map<string, Set<() => void>>();

  function assertOpen(): void {
    if (closing || closed) {
      throw new HostError("host is closed", "host_closed");
    }
  }

  function requireProject(id: string): Project {
    const value = state.getProject(id);
    if (!value) {
      throw new HostError(`unknown project: ${id}`, "unknown_project");
    }
    return value;
  }

  function requireWorkspace(id: string): Workspace {
    const value = state.getWorkspace(id);
    if (!value) {
      throw new HostError(`unknown workspace: ${id}`, "unknown_workspace");
    }
    return value;
  }

  function requireSession(id: string): Session {
    const value = state.getSession(id);
    if (!value) {
      throw new HostError(`unknown session: ${id}`, "unknown_session");
    }
    return value;
  }

  function requireRun(id: string): StoredRun {
    const value = state.getRun(id);
    if (!value) {
      throw new HostError(`unknown run: ${id}`, "unknown_run");
    }
    return value;
  }

  function notifyRun(runId: string): void {
    runVersions.set(runId, (runVersions.get(runId) ?? 0) + 1);
    const waiters = runWaiters.get(runId);
    if (!waiters) return;
    runWaiters.delete(runId);
    for (const resolve of waiters) resolve();
  }

  function waitForRunChange(runId: string, version: number): Promise<void> {
    return new Promise((resolve) => {
      const waiters = runWaiters.get(runId) ?? new Set<() => void>();
      waiters.add(resolve);
      runWaiters.set(runId, waiters);
      if ((runVersions.get(runId) ?? 0) !== version) {
        waiters.delete(resolve);
        if (waiters.size === 0) runWaiters.delete(runId);
        resolve();
      }
    });
  }

  function workspaceInfo(workspace: Workspace) {
    return {
      workspaceId: workspace.id,
      projectId: workspace.projectId,
      worktreePath: workspace.worktreePath,
      branch: workspace.branch,
      slug: workspace.slug,
    };
  }

  async function sessionHandle(
    session: Session,
    workspace: Workspace,
  ): Promise<WattSessionHandle> {
    const existing = sessionHandles.get(session.id);
    if (existing) return existing;
    const handle = await agent.resume({
      cwd: workspace.worktreePath,
      model: session.model,
      cursorAgentId: session.cursorAgentId,
      workspace: workspaceInfo(workspace),
    });
    sessionHandles.set(session.id, handle);
    return handle;
  }

  function finishRun(runId: string, result: RunResult): void {
    state.finishRun(runId, result, now());
    notifyRun(runId);
  }

  function hostResult(runId: string, result: WattRunResult): RunResult {
    const mapped: RunResult = { runId, status: result.status };
    if (result.result !== undefined) mapped.result = result.result;
    if (result.error !== undefined) mapped.error = { ...result.error };
    if (result.durationMs !== undefined) mapped.durationMs = result.durationMs;
    return mapped;
  }

  function serializeEvent(event: HostEvent): string {
    const encoded = JSON.stringify(event);
    if (encoded === undefined) {
      throw new Error("agent event is not JSON-serializable");
    }
    return encoded;
  }

  function parseEvent(encoded: string): HostEvent {
    let value: unknown;
    try {
      value = JSON.parse(encoded);
    } catch (error) {
      throw new HostError(
        "persisted run event is invalid",
        "run_event_invalid",
        {
          cause: error,
        },
      );
    }
    if (typeof value !== "object" || value === null || !("type" in value)) {
      throw new HostError(
        "persisted run event is invalid",
        "run_event_invalid",
      );
    }
    return value as HostEvent;
  }

  async function consumeRun(
    stored: StoredRun,
    run: WattRun,
    workspace: Workspace,
  ): Promise<void> {
    state.clearRunEvents(stored.value.id);
    activeRuns.set(stored.value.id, run);
    if (cancelRequested.has(stored.value.id) || closing) {
      await run.cancel().catch(() => undefined);
    }

    let sequence = 0;
    try {
      for await (const event of run.stream()) {
        sequence += 1;
        const annotated = {
          ...event,
          workspaceId: workspace.id,
          sessionId: stored.value.sessionId,
          runId: stored.value.id,
          sequence,
        } as HostEvent;
        state.insertRunEvent(
          stored.value.id,
          sequence,
          serializeEvent(annotated),
          now(),
        );
        notifyRun(stored.value.id);
      }
      finishRun(stored.value.id, hostResult(stored.value.id, await run.wait()));
    } catch (error) {
      await run.cancel().catch(() => undefined);
      finishRun(
        stored.value.id,
        failure(stored.value.id, "run_stream_failed", error),
      );
    } finally {
      activeRuns.delete(stored.value.id);
      cancelRequested.delete(stored.value.id);
    }
  }

  async function processRun(stored: StoredRun): Promise<void> {
    const session = requireSession(stored.value.sessionId);
    const workspace = requireWorkspace(session.workspaceId);
    if (workspace.archivedAt !== null) {
      finishRun(
        stored.value.id,
        failure(stored.value.id, "workspace_archived", "workspace is archived"),
      );
      return;
    }

    try {
      if (stored.cursorRunId) {
        const recovered = await agent.getRun({
          cursorRunId: stored.cursorRunId,
          cwd: workspace.worktreePath,
        });
        await consumeRun(stored, recovered, workspace);
        return;
      }
      if (stored.prompt === null) {
        throw new Error("queued run is missing its prompt");
      }
      const handle = await sessionHandle(session, workspace);
      const started = await handle.send(stored.prompt, {
        idempotencyKey: stored.value.id,
      });
      if (!state.markRunRunning(stored.value.id, started.cursorRunId, now())) {
        await started.cancel().catch(() => undefined);
        return;
      }
      notifyRun(stored.value.id);
      await consumeRun(stored, started, workspace);
    } catch (error) {
      finishRun(
        stored.value.id,
        failure(
          stored.value.id,
          stored.cursorRunId ? "run_recovery_failed" : "run_dispatch_failed",
          error,
        ),
      );
    }
  }

  async function runSessionQueue(sessionId: string): Promise<void> {
    while (!closing) {
      let next = state.getActiveRun(sessionId);
      if (!next) {
        const queued = state.getNextQueuedRun(sessionId);
        if (!queued) return;
        if (!state.markRunDispatching(queued.value.id, now())) continue;
        notifyRun(queued.value.id);
        next = requireRun(queued.value.id);
      }
      await processRun(next);
    }
  }

  function scheduleSession(sessionId: string): void {
    if (closing || schedulers.has(sessionId)) return;
    const task = runSessionQueue(sessionId)
      .catch((error: unknown) => {
        const active = state.getActiveRun(sessionId);
        if (active) {
          finishRun(
            active.value.id,
            failure(active.value.id, "run_coordinator_failed", error),
          );
        }
      })
      .finally(() => {
        if (schedulers.get(sessionId) !== task) return;
        schedulers.delete(sessionId);
        if (!closing && state.getNextQueuedRun(sessionId)) {
          scheduleSession(sessionId);
        }
      });
    schedulers.set(sessionId, task);
  }

  async function awaitResult(runId: string): Promise<RunResult> {
    for (;;) {
      if (closing) throw new HostError("host is closed", "host_closed");
      const stored = requireRun(runId);
      if (stored.result) return stored.result;
      const version = runVersions.get(runId) ?? 0;
      const latest = requireRun(runId);
      if (latest.result) return latest.result;
      await waitForRunChange(runId, version);
    }
  }

  async function cancelRun(runId: string): Promise<RunResult> {
    const stored = requireRun(runId);
    if (stored.result) return stored.result;
    if (stored.internalStatus === "queued") {
      finishRun(runId, { runId, status: "cancelled" });
      return requireRun(runId).result ?? { runId, status: "cancelled" };
    }
    cancelRequested.add(runId);
    await activeRuns
      .get(runId)
      ?.cancel()
      .catch(() => undefined);
    scheduleSession(stored.value.sessionId);
    return awaitResult(runId);
  }

  const host: Host = {
    close() {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = (async () => {
        try {
          for (const stored of state.listNonterminalRuns()) {
            if (stored.internalStatus !== "queued") {
              cancelRequested.add(stored.value.id);
            }
          }
          await Promise.all(
            [...activeRuns.values()].map((run) =>
              run.cancel().catch(() => undefined),
            ),
          );
          await Promise.all([...schedulers.values()]);
        } finally {
          for (const runId of runWaiters.keys()) notifyRun(runId);
          try {
            database.close();
          } finally {
            closed = true;
            await hostLease.release();
          }
        }
      })();
      return closePromise;
    },
    projects: {
      async register(repoRoot) {
        assertOpen();
        const resolved = await realpath(path.resolve(repoRoot));
        assertOpen();
        const existing = state.getProjectByRoot(resolved);
        if (existing) return existing;
        const row = { id: ulid(), repoRoot: resolved, createdAt: now() };
        try {
          state.insertProject(row);
        } catch (error) {
          if (isUniqueConstraint(error)) {
            const raced = state.getProjectByRoot(resolved);
            if (raced) return raced;
          }
          throw error;
        }
        return { id: row.id, repoRoot: row.repoRoot };
      },
      get(id) {
        assertOpen();
        return state.getProject(id);
      },
      list() {
        assertOpen();
        return state.listProjects();
      },
      async reconcile(input) {
        assertOpen();
        const project = requireProject(input.projectId);
        const workspaces = state.listWorkspaces(project.id, false);
        return reconcileProject(project, workspaces, () =>
          git.inspectRepository(project.repoRoot),
        );
      },
    },
    workspaces: {
      async create(input) {
        assertOpen();
        const project = requireProject(input.projectId);
        const slug = assertSlug(input.slug);
        const branch = input.branch ?? `watt/${slug}`;
        const baseRef = input.baseRef ?? "HEAD";
        const worktreePath = path.join(worktreeRoot, slug);
        if (
          !isPathInside(worktreeRoot, worktreePath) ||
          path.resolve(worktreePath) === worktreeRoot
        ) {
          throw new HostError(
            `worktree path escapes worktreeRoot: ${slug}`,
            "invalid_slug",
          );
        }
        if (isPathInside(project.repoRoot, worktreePath)) {
          throw new HostError(
            "worktreeRoot must not be inside the source repo",
            "nested_worktree",
          );
        }
        if (state.getActiveWorkspaceBySlug(project.id, slug)) {
          throw new HostError(
            `workspace slug already exists: ${slug}`,
            "slug_exists",
          );
        }
        if (state.getActiveWorkspaceByPath(worktreePath)) {
          throw new HostError(
            `workspace path already exists: ${worktreePath}`,
            "workspace_path_exists",
          );
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
        const pathCollision = state.getActiveWorkspaceByPath(resolvedPath);
        if (pathCollision) {
          await git.archiveWorktree({
            repoRoot: project.repoRoot,
            worktreePath: resolvedPath,
            branch,
            keepBranch: false,
          });
          throw new HostError(
            `workspace path already exists: ${resolvedPath}`,
            "workspace_path_exists",
          );
        }
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
          state.insertWorkspace(row);
        } catch (error) {
          await git.archiveWorktree({
            repoRoot: project.repoRoot,
            worktreePath: resolvedPath,
            branch,
            keepBranch: false,
          });
          if (isUniqueConstraint(error)) {
            if (state.getActiveWorkspaceByPath(resolvedPath)) {
              throw new HostError(
                `workspace path already exists: ${resolvedPath}`,
                "workspace_path_exists",
                { cause: error },
              );
            }
            throw new HostError(
              `workspace slug already exists: ${slug}`,
              "slug_exists",
              { cause: error },
            );
          }
          throw error;
        }
        return row;
      },
      list(input) {
        assertOpen();
        return state.listWorkspaces(
          input.projectId,
          input.includeArchived ?? false,
        );
      },
      get(id) {
        assertOpen();
        return state.getWorkspace(id);
      },
      async archive(input) {
        assertOpen();
        const workspace = requireWorkspace(input.workspaceId);
        await Promise.all(
          state
            .listNonterminalRunsForWorkspace(workspace.id)
            .map((run) => cancelRun(run.value.id)),
        );
        const project = requireProject(workspace.projectId);
        await git.archiveWorktree({
          repoRoot: project.repoRoot,
          worktreePath: workspace.worktreePath,
          branch: workspace.branch,
          keepBranch: input.keepBranch,
        });
        if (workspace.archivedAt !== null) return workspace;
        const archivedAt = now();
        state.archiveWorkspace(workspace.id, archivedAt);
        return { ...workspace, archivedAt };
      },
    },
    sessions: {
      async create(input) {
        assertOpen();
        const workspace = requireWorkspace(input.workspaceId);
        if (workspace.archivedAt !== null) {
          throw new HostError("workspace is archived", "workspace_archived");
        }
        const model = input.model ?? "composer-2.5";
        const handle = await agent.create({
          cwd: workspace.worktreePath,
          model,
          autoReview: input.autoReview,
          workspace: workspaceInfo(workspace),
        });
        assertOpen();
        const session: Session = {
          id: ulid(),
          workspaceId: workspace.id,
          cursorAgentId: handle.cursorAgentId,
          mode: "agent",
          model,
          createdAt: now(),
        };
        const run: Run = {
          id: ulid(),
          sessionId: session.id,
          status: "queued",
          createdAt: now(),
          startedAt: null,
          finishedAt: null,
        };
        state.insertSessionAndRun(session, run, input.prompt);
        sessionHandles.set(session.id, handle);
        scheduleSession(session.id);
        return { session, run };
      },
      async send(input) {
        assertOpen();
        const session = requireSession(input.sessionId);
        const workspace = requireWorkspace(session.workspaceId);
        if (workspace.archivedAt !== null) {
          throw new HostError("workspace is archived", "workspace_archived");
        }
        const run: Run = {
          id: ulid(),
          sessionId: session.id,
          status: "queued",
          createdAt: now(),
          startedAt: null,
          finishedAt: null,
        };
        state.insertRun(run, input.prompt);
        scheduleSession(session.id);
        return { session, run };
      },
      get(id) {
        assertOpen();
        return state.getSession(id);
      },
      list(input) {
        assertOpen();
        return state.listSessions(input.workspaceId);
      },
    },
    runs: {
      get(id) {
        assertOpen();
        return state.getRun(id)?.value;
      },
      list(input) {
        assertOpen();
        requireSession(input.sessionId);
        return state.listRuns(input.sessionId);
      },
      async wait(input) {
        assertOpen();
        return awaitResult(input.runId);
      },
      async cancel(input) {
        assertOpen();
        return cancelRun(input.runId);
      },
      attach(input) {
        assertOpen();
        requireRun(input.runId);
        const afterSequence = input.afterSequence ?? 0;
        if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
          throw new HostError(
            "afterSequence must be a non-negative safe integer",
            "invalid_sequence",
          );
        }
        return {
          async *[Symbol.asyncIterator]() {
            let sequence = afterSequence;
            for (;;) {
              if (closing) return;
              const version = runVersions.get(input.runId) ?? 0;
              const events = state.listRunEventsAfter(input.runId, sequence);
              for (const row of events) {
                sequence = row.sequence;
                yield parseEvent(row.event_json);
              }
              const stored = requireRun(input.runId);
              if (stored.result) return;
              if (events.length > 0) continue;
              await waitForRunChange(input.runId, version);
            }
          },
        };
      },
    },
  };

  for (const run of state.listNonterminalRuns()) {
    scheduleSession(run.value.sessionId);
  }

  return host;
}
