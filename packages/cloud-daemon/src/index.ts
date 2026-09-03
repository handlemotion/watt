import { createHash, timingSafeEqual } from "node:crypto";
import { access, mkdir } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import type { Host } from "@watt/host";
import {
  ProtocolError,
  toWireError,
  type HostMethod,
  type HostMethodMap,
} from "@watt/host-protocol";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { execa } from "execa";

import { readBoundedJson } from "./body.js";

export type CloudDaemonOptions = {
  host: Host;
  authToken: string;
  maxJsonBytes?: number;
  repositoryRoot?: string;
  gitBroker?: { socketPath: string; authToken: string; timeoutMs?: number };
};

const CALLABLE_METHODS = new Set<HostMethod>([
  "projects.register",
  "projects.get",
  "projects.list",
  "projects.reconcile",
  "workspaces.create",
  "workspaces.get",
  "workspaces.list",
  "workspaces.archive",
  "sessions.create",
  "sessions.get",
  "sessions.list",
  "sessions.send",
  "runs.get",
  "runs.list",
  "runs.wait",
  "runs.cancel",
  "host.capabilities",
  "changesets.pull",
  "changesets.resolve",
  "changesets.abort",
  "diagnostics.operations.get",
  "diagnostics.operations.list",
]);

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function authorized(header: string | undefined, expected: string): boolean {
  if (!header) return false;
  return timingSafeEqual(digest(header), digest(expected));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function wireStatus(code: string): 400 | 413 | 500 {
  if (code === "payload_too_large") return 413;
  if (code === "invalid_request") return 400;
  return 500;
}

async function brokerCall(
  broker: NonNullable<CloudDaemonOptions["gitBroker"]>,
  request: Record<string, unknown>,
): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(broker.socketPath);
    let response = "";
    socket.setEncoding("utf8");
    socket.setTimeout(broker.timeoutMs ?? 120_000, () => {
      socket.destroy(new Error("Git broker request timed out"));
    });
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ ...request, authToken: broker.authToken })}\n`);
    });
    socket.on("data", (chunk) => {
      response += chunk;
      if (Buffer.byteLength(response) > 256 * 1024) socket.destroy();
    });
    socket.once("error", reject);
    socket.once("end", () => {
      try {
        const value = JSON.parse(response) as {
          ok: boolean;
          result?: Record<string, string>;
          error?: { code: string; message: string };
        };
        if (!value.ok || !value.result) {
          reject(
            new ProtocolError(
              value.error?.message ?? "Git broker operation failed",
              value.error?.code ?? "git_failed",
            ),
          );
          return;
        }
        resolve(value.result);
      } catch (error) {
        reject(error);
      }
    });
  });
}

export function stripBootstrapSecrets(environment: NodeJS.ProcessEnv = process.env): void {
  for (const key of [
    "UPSTASH_BOX_API_KEY",
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_TOKEN",
    "BETTER_AUTH_SECRET",
    "CLOUD_DAEMON_TOKEN",
    "CURSOR_API_KEY",
  ]) {
    delete environment[key];
  }
}

async function routeHostCall(
  host: Host,
  method: HostMethod,
  params: Record<string, unknown>,
): Promise<unknown> {
  switch (method) {
    case "projects.register":
      return host.projects.register(String(params.repoRoot));
    case "projects.get":
      return host.projects.get(String(params.id)) ?? null;
    case "projects.list":
      return host.projects.list();
    case "projects.reconcile":
      return host.projects.reconcile(params as HostMethodMap["projects.reconcile"]["params"]);
    case "workspaces.create":
      return host.workspaces.create(params as HostMethodMap["workspaces.create"]["params"]);
    case "workspaces.get":
      return host.workspaces.get(String(params.id)) ?? null;
    case "workspaces.list":
      return host.workspaces.list(params as HostMethodMap["workspaces.list"]["params"]);
    case "workspaces.archive":
      return host.workspaces.archive(params as HostMethodMap["workspaces.archive"]["params"]);
    case "sessions.create":
      return host.sessions.create(params as HostMethodMap["sessions.create"]["params"]);
    case "sessions.get":
      return host.sessions.get(String(params.id)) ?? null;
    case "sessions.list":
      return host.sessions.list(params as HostMethodMap["sessions.list"]["params"]);
    case "sessions.send":
      return host.sessions.send(params as HostMethodMap["sessions.send"]["params"]);
    case "runs.get":
      return host.runs.get(String(params.id)) ?? null;
    case "runs.list":
      return host.runs.list(params as HostMethodMap["runs.list"]["params"]);
    case "runs.wait":
      return host.runs.wait(params as HostMethodMap["runs.wait"]["params"]);
    case "runs.cancel":
      return host.runs.cancel(params as HostMethodMap["runs.cancel"]["params"]);
    case "changesets.pull":
      return host.changesets.pull(params as HostMethodMap["changesets.pull"]["params"]);
    case "changesets.resolve":
      return host.changesets.resolve(params as HostMethodMap["changesets.resolve"]["params"]);
    case "changesets.abort":
      return host.changesets.abort(params as HostMethodMap["changesets.abort"]["params"]);
    case "host.capabilities":
      return host.capabilities();
    case "diagnostics.operations.get":
      return (
        host.diagnostics.operations.get(
          params as HostMethodMap["diagnostics.operations.get"]["params"],
        ) ?? null
      );
    case "diagnostics.operations.list":
      return host.diagnostics.operations.list(
        params as HostMethodMap["diagnostics.operations.list"]["params"],
      );
    case "runs.attach":
    case "runs.unsubscribe":
    case "cloud.prepareBase":
    case "host.close":
      throw new ProtocolError("method is not callable over JSON", "method_not_found");
  }
}

export function createCloudDaemon(options: CloudDaemonOptions): Hono {
  const maxJsonBytes = options.maxJsonBytes ?? 256 * 1024;
  const repositoryRoot = path.resolve(options.repositoryRoot ?? "/var/lib/watt/repositories");
  const app = new Hono();

  app.get("/health", async (c) =>
    c.json({
      status: "ready",
      capabilities: await options.host.capabilities(),
    }),
  );
  app.use("/v1/*", async (c, next) => {
    if (!authorized(c.req.header("x-watt-daemon-token"), options.authToken))
      return c.json({ error: { code: "unauthorized", message: "authentication required" } }, 401);
    const length = Number(c.req.header("content-length") ?? "0");
    if (!Number.isFinite(length) || length > maxJsonBytes)
      return c.json(
        {
          error: {
            code: "payload_too_large",
            message: "request body is too large",
          },
        },
        413,
      );
    await next();
  });
  app.post("/v1/host/call", async (c) => {
    try {
      const body = await readBoundedJson(c.req.raw, maxJsonBytes);
      if (
        !isRecord(body) ||
        typeof body.method !== "string" ||
        !CALLABLE_METHODS.has(body.method as HostMethod) ||
        !isRecord(body.params)
      ) {
        throw new ProtocolError("invalid host request", "invalid_request");
      }
      return c.json({
        result: await routeHostCall(options.host, body.method as HostMethod, body.params),
      });
    } catch (error) {
      const wire = toWireError(error, "internal daemon error");
      return c.json({ error: wire }, wireStatus(wire.code));
    }
  });
  app.post("/v1/git/connect", async (c) => {
    try {
      const body = await readBoundedJson(c.req.raw, maxJsonBytes);
      if (
        !isRecord(body) ||
        typeof body.repositoryId !== "string" ||
        !/^[0-9]+$/.test(body.repositoryId) ||
        typeof body.repositoryUrl !== "string" ||
        !body.repositoryUrl.startsWith("https://github.com/") ||
        typeof body.ref !== "string" ||
        typeof body.expectedSha !== "string" ||
        !/^[0-9a-f]{40}$/.test(body.expectedSha) ||
        typeof body.token !== "string"
      )
        throw new ProtocolError("invalid repository connection", "invalid_request");
      const repoRoot = path.join(repositoryRoot, body.repositoryId);
      if (options.gitBroker) {
        await brokerCall(options.gitBroker, {
          operation: "connect",
          repositoryUrl: body.repositoryUrl,
          repositoryRoot: repoRoot,
          repositoryId: body.repositoryId,
          ref: body.ref,
          expectedSha: body.expectedSha,
          githubToken: body.token,
        });
      } else {
        await mkdir(repositoryRoot, { recursive: true });
        const environment = gitEnvironment(body.token);
        if (!(await exists(repoRoot)))
          await execa("git", ["clone", "--no-checkout", "--", body.repositoryUrl, repoRoot], {
            env: environment,
            timeout: 120_000,
          });
        await execa("git", ["fetch", "--no-tags", "origin", body.ref], {
          cwd: repoRoot,
          env: environment,
          timeout: 120_000,
        });
        await execa("git", ["checkout", "--detach", "FETCH_HEAD"], {
          cwd: repoRoot,
          timeout: 120_000,
        });
        const head = (
          await execa("git", ["rev-parse", "HEAD"], {
            cwd: repoRoot,
            timeout: 120_000,
          })
        ).stdout.trim();
        if (head !== body.expectedSha)
          throw new ProtocolError(
            "repository ref did not resolve to the expected SHA",
            "needs_attention",
          );
      }
      return c.json({
        project: await options.host.projects.register(repoRoot),
      });
    } catch (error) {
      const wire = toWireError(error, "repository connection failed");
      return c.json({ error: wire }, wireStatus(wire.code));
    }
  });
  app.post("/v1/git/publish", async (c) => {
    try {
      const body = await readBoundedJson(c.req.raw, maxJsonBytes);
      if (
        !isRecord(body) ||
        typeof body.runId !== "string" ||
        typeof body.baseSha !== "string" ||
        typeof body.branch !== "string" ||
        typeof body.repositoryUrl !== "string" ||
        !body.repositoryUrl.startsWith("https://github.com/") ||
        typeof body.token !== "string"
      )
        throw new ProtocolError("invalid publication request", "invalid_request");
      const run = options.host.runs.get(body.runId);
      if (!run || !["finished", "error", "cancelled"].includes(run.status))
        throw new ProtocolError("run is not terminal", "workspace_busy");
      const session = options.host.sessions.get(run.sessionId);
      const workspace = session && options.host.workspaces.get(session.workspaceId);
      if (!workspace) throw new ProtocolError("run workspace not found", "needs_attention");
      const status = await execa("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
        cwd: workspace.worktreePath,
        timeout: 120_000,
      });
      const head = (
        await execa("git", ["rev-parse", "HEAD"], {
          cwd: workspace.worktreePath,
          timeout: 120_000,
        })
      ).stdout.trim();
      if (status.stdout.trim())
        return c.json({
          state: "needs_commit",
          baseSha: body.baseSha,
          headSha: head,
        });
      if (head === body.baseSha)
        return c.json({
          state: "no_changes",
          baseSha: body.baseSha,
          headSha: head,
        });
      const ancestor = await execa("git", ["merge-base", "--is-ancestor", body.baseSha, head], {
        cwd: workspace.worktreePath,
        reject: false,
        timeout: 120_000,
      });
      if (ancestor.exitCode !== 0)
        return c.json({
          state: "needs_attention",
          baseSha: body.baseSha,
          headSha: head,
          errorCode: "branch_diverged",
        });
      if (options.gitBroker) {
        await brokerCall(options.gitBroker, {
          operation: "publish",
          repositoryUrl: body.repositoryUrl,
          worktreePath: workspace.worktreePath,
          baseSha: body.baseSha,
          headSha: head,
          branch: body.branch,
          githubToken: body.token,
        });
      } else {
        await execa("git", ["push", "origin", `${head}:refs/heads/${body.branch}`], {
          cwd: workspace.worktreePath,
          env: gitEnvironment(body.token),
          timeout: 120_000,
        });
      }
      return c.json({
        state: "published",
        baseSha: body.baseSha,
        headSha: head,
      });
    } catch (error) {
      const wire = toWireError(error, "publication failed");
      return c.json({ error: wire }, wireStatus(wire.code));
    }
  });
  app.post("/v1/git/initialize-branch", async (c) => {
    try {
      const body = await readBoundedJson(c.req.raw, maxJsonBytes);
      if (
        !isRecord(body) ||
        typeof body.workspaceId !== "string" ||
        typeof body.baseSha !== "string" ||
        !/^[0-9a-f]{40}$/.test(body.baseSha) ||
        typeof body.branch !== "string" ||
        !/^watt\/cloud\/[0-9a-f-]{36}$/.test(body.branch) ||
        typeof body.repositoryUrl !== "string" ||
        !body.repositoryUrl.startsWith("https://github.com/") ||
        (body.seedRef !== undefined &&
          (typeof body.seedRef !== "string" ||
            !/^watt\/seed\/[A-Za-z0-9-]{8,100}$/.test(body.seedRef))) ||
        typeof body.token !== "string"
      ) {
        throw new ProtocolError("invalid cloud branch initialization", "invalid_request");
      }
      const workspace = options.host.workspaces.get(body.workspaceId);
      if (!workspace) {
        throw new ProtocolError("workspace not found", "needs_attention");
      }
      const environment = gitEnvironment(body.token);
      if (options.gitBroker) {
        const result = await brokerCall(options.gitBroker, {
          operation: "initialize",
          repositoryUrl: body.repositoryUrl,
          worktreePath: workspace.worktreePath,
          baseSha: body.baseSha,
          branch: body.branch,
          seedRef: body.seedRef,
          githubToken: body.token,
        });
        return c.json(result);
      }
      const cloudAdvertised = await execa(
        "git",
        ["ls-remote", "origin", `refs/heads/${body.branch}`],
        {
          cwd: workspace.worktreePath,
          env: environment,
          timeout: 120_000,
        },
      );
      let seedAdvertised = "";
      if (body.seedRef) {
        seedAdvertised =
          (
            await execa("git", ["ls-remote", "origin", `refs/heads/${body.seedRef}`], {
              cwd: workspace.worktreePath,
              env: environment,
              timeout: 120_000,
            })
          ).stdout.split(/\s+/, 1)[0] ?? "";
      }
      if (cloudAdvertised.stdout.split(/\s+/, 1)[0] !== body.baseSha) {
        if (body.seedRef && seedAdvertised !== body.baseSha) {
          throw new ProtocolError("seed ref does not match the expected SHA", "needs_attention");
        }
        await execa("git", ["push", "origin", `${body.baseSha}:refs/heads/${body.branch}`], {
          cwd: workspace.worktreePath,
          env: environment,
          timeout: 120_000,
        });
      }
      if (body.seedRef && seedAdvertised) {
        await execa("git", ["push", "origin", `:refs/heads/${body.seedRef}`], {
          cwd: workspace.worktreePath,
          env: environment,
          timeout: 120_000,
        });
      }
      return c.json({ branch: body.branch, baseSha: body.baseSha });
    } catch (error) {
      const wire = toWireError(error, "cloud branch initialization failed");
      return c.json({ error: wire }, wireStatus(wire.code));
    }
  });
  app.post("/v1/git/archive", async (c) => {
    try {
      const body = await readBoundedJson(c.req.raw, maxJsonBytes);
      if (
        !isRecord(body) ||
        typeof body.workspaceId !== "string" ||
        typeof body.branch !== "string" ||
        !/^watt\/cloud\/[0-9a-f-]{36}$/.test(body.branch) ||
        typeof body.repositoryUrl !== "string" ||
        !body.repositoryUrl.startsWith("https://github.com/") ||
        typeof body.token !== "string" ||
        typeof body.idempotencyKey !== "string"
      ) {
        throw new ProtocolError("invalid cloud archive", "invalid_request");
      }
      const workspace = options.host.workspaces.get(body.workspaceId);
      if (!workspace) throw new ProtocolError("workspace not found", "needs_attention");
      const busy = options.host.sessions
        .list({ workspaceId: workspace.id })
        .flatMap((session) => options.host.runs.list({ sessionId: session.id }))
        .some((run) => run.status === "queued" || run.status === "running");
      if (busy) throw new ProtocolError("workspace is busy", "workspace_busy");
      const project = options.host.projects.get(workspace.projectId);
      if (!project) throw new ProtocolError("project not found", "needs_attention");
      if (options.gitBroker) {
        await brokerCall(options.gitBroker, {
          operation: "archive",
          repositoryUrl: body.repositoryUrl,
          repositoryRoot: project.repoRoot,
          branch: body.branch,
          githubToken: body.token,
        });
      } else {
        const advertised = await execa(
          "git",
          ["ls-remote", "origin", `refs/heads/${body.branch}`],
          {
            cwd: project.repoRoot,
            env: gitEnvironment(body.token),
            timeout: 120_000,
          },
        );
        if (advertised.stdout.trim())
          await execa("git", ["push", "origin", `:refs/heads/${body.branch}`], {
            cwd: project.repoRoot,
            env: gitEnvironment(body.token),
            timeout: 120_000,
          });
      }
      const archived = await options.host.workspaces.archive({
        workspaceId: workspace.id,
        idempotencyKey: body.idempotencyKey,
      });
      return c.json({ workspace: archived, branchDeleted: true });
    } catch (error) {
      const wire = toWireError(error, "cloud archive failed");
      return c.json({ error: wire }, wireStatus(wire.code));
    }
  });
  app.get("/v1/runs/:runId/events", (c) => {
    const headerSequence = c.req.header("last-event-id");
    const querySequence = c.req.query("afterSequence");
    const parsed = Number(querySequence ?? headerSequence ?? "0");
    if (!Number.isSafeInteger(parsed) || parsed < 0)
      return c.json(
        {
          error: {
            code: "invalid_sequence",
            message: "event cursor must be a non-negative integer",
          },
        },
        400,
      );
    const runId = c.req.param("runId");
    return streamSSE(c, async (stream) => {
      const controller = new AbortController();
      stream.onAbort(() => controller.abort());
      for await (const event of options.host.runs.attach({
        runId,
        afterSequence: parsed,
        signal: controller.signal,
      })) {
        await stream.writeSSE({
          id: String(event.sequence),
          event: "run_event",
          data: JSON.stringify(event),
        });
      }
      if (!controller.signal.aborted) {
        const result = await options.host.runs.wait({ runId });
        await stream.writeSSE({
          event: "run_end",
          data: JSON.stringify(result),
        });
      }
    });
  });
  return app;
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function gitEnvironment(token: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
  };
}
