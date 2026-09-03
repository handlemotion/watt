import { createHash, timingSafeEqual } from "node:crypto";
import { access, chmod, chown, lchown, mkdir, readdir, realpath, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import { execa } from "execa";

type BrokerRequest = {
  authToken: string;
  operation: "connect" | "initialize" | "publish" | "archive";
  repositoryUrl: string;
  repositoryRoot?: string;
  repositoryId?: string;
  ref?: string;
  expectedSha?: string;
  worktreePath?: string;
  baseSha?: string;
  headSha?: string;
  branch?: string;
  seedRef?: string;
  githubToken: string;
};

type BrokerResponse =
  | { ok: true; result: Record<string, string> }
  | { ok: false; error: { code: string; message: string } };

const SHA = /^[0-9a-f]{40}$/;
const CLOUD_BRANCH = /^watt\/cloud\/[0-9a-f-]{36}$/;
const SEED_REF = /^watt\/seed\/[A-Za-z0-9-]{8,100}$/;
const OPERATIONS = new Set<BrokerRequest["operation"]>([
  "connect",
  "initialize",
  "publish",
  "archive",
]);

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function authorized(actual: string, expected: string): boolean {
  return timingSafeEqual(digest(actual), digest(expected));
}

function githubUrl(value: string): boolean {
  return /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(value);
}

function gitEnvironment(token: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: "/root",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "6",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
    GIT_CONFIG_KEY_1: "core.hooksPath",
    GIT_CONFIG_VALUE_1: "/dev/null",
    GIT_CONFIG_KEY_2: "credential.helper",
    GIT_CONFIG_VALUE_2: "",
    GIT_CONFIG_KEY_3: "protocol.ext.allow",
    GIT_CONFIG_VALUE_3: "never",
    GIT_CONFIG_KEY_4: "protocol.file.allow",
    GIT_CONFIG_VALUE_4: "never",
    GIT_CONFIG_KEY_5: "core.fsmonitor",
    GIT_CONFIG_VALUE_5: "false",
  };
}

async function chownTree(target: string, uid: number, gid: number): Promise<void> {
  const entries = await readdir(target, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const child = path.join(target, entry.name);
      if (entry.isDirectory()) await chownTree(child, uid, gid);
      else await lchown(child, uid, gid);
    }),
  );
  await chown(target, uid, gid);
}

function assertRepositoryPath(root: string, repositoryRoot: string): void {
  const relative = path.relative(root, repositoryRoot);
  if (relative.startsWith("..") || path.isAbsolute(relative) || !relative) {
    throw new Error("invalid_repository_path");
  }
}

async function assertResolvedPath(root: string, target: string): Promise<void> {
  assertRepositoryPath(await realpath(root), await realpath(target));
}

async function execute(
  request: BrokerRequest,
  options: {
    repositoryRoot: string;
    worktreeRoot: string;
    uid: number;
    gid: number;
    gitTimeoutMs: number;
  },
): Promise<Record<string, string>> {
  if (
    !OPERATIONS.has(request.operation) ||
    !githubUrl(request.repositoryUrl) ||
    !request.githubToken
  ) {
    throw new Error("invalid_git_request");
  }
  const environment = gitEnvironment(request.githubToken);
  if (request.operation === "connect") {
    if (
      !request.repositoryRoot ||
      !request.repositoryId ||
      !/^[0-9]+$/.test(request.repositoryId) ||
      !request.ref ||
      !request.expectedSha ||
      !SHA.test(request.expectedSha)
    ) {
      throw new Error("invalid_git_request");
    }
    assertRepositoryPath(options.repositoryRoot, request.repositoryRoot);
    if (path.basename(request.repositoryRoot) !== request.repositoryId) {
      throw new Error("invalid_repository_path");
    }
    await mkdir(path.dirname(request.repositoryRoot), { recursive: true });
    try {
      await access(path.join(request.repositoryRoot, ".git"));
    } catch {
      await execa(
        "git",
        ["clone", "--no-checkout", "--", request.repositoryUrl, request.repositoryRoot],
        { env: environment, timeout: options.gitTimeoutMs },
      );
    }
    await assertResolvedPath(options.repositoryRoot, request.repositoryRoot);
    await execa("git", ["fetch", "--no-tags", request.repositoryUrl, request.ref], {
      cwd: request.repositoryRoot,
      env: environment,
      timeout: options.gitTimeoutMs,
    });
    await execa("git", ["checkout", "--detach", "FETCH_HEAD"], {
      cwd: request.repositoryRoot,
      timeout: options.gitTimeoutMs,
    });
    const head = (
      await execa("git", ["rev-parse", "HEAD"], {
        cwd: request.repositoryRoot,
        timeout: options.gitTimeoutMs,
      })
    ).stdout.trim();
    if (head !== request.expectedSha) throw new Error("needs_attention");
    await chownTree(request.repositoryRoot, options.uid, options.gid);
    return { repositoryRoot: request.repositoryRoot, head };
  }

  if (request.operation === "archive") {
    if (!request.repositoryRoot || !request.branch || !CLOUD_BRANCH.test(request.branch)) {
      throw new Error("invalid_git_request");
    }
    assertRepositoryPath(options.repositoryRoot, request.repositoryRoot);
    await assertResolvedPath(options.repositoryRoot, request.repositoryRoot);
    const advertised = await execa(
      "git",
      ["ls-remote", request.repositoryUrl, `refs/heads/${request.branch}`],
      {
        cwd: request.repositoryRoot,
        env: environment,
        timeout: options.gitTimeoutMs,
      },
    );
    if (advertised.stdout.trim()) {
      await execa("git", ["push", request.repositoryUrl, `:refs/heads/${request.branch}`], {
        cwd: request.repositoryRoot,
        env: environment,
        timeout: options.gitTimeoutMs,
      });
    }
    return { branch: request.branch };
  }

  if (
    !request.worktreePath ||
    !request.baseSha ||
    !SHA.test(request.baseSha) ||
    !request.branch ||
    !CLOUD_BRANCH.test(request.branch)
  ) {
    throw new Error("invalid_git_request");
  }
  assertRepositoryPath(options.worktreeRoot, request.worktreePath);
  await assertResolvedPath(options.worktreeRoot, request.worktreePath);
  if (request.operation === "initialize") {
    if (request.seedRef && !SEED_REF.test(request.seedRef)) {
      throw new Error("invalid_git_request");
    }
    const cloudAdvertised = await execa(
      "git",
      ["ls-remote", request.repositoryUrl, `refs/heads/${request.branch}`],
      {
        cwd: request.worktreePath,
        env: environment,
        timeout: options.gitTimeoutMs,
      },
    );
    let seedAdvertised = "";
    if (request.seedRef) {
      seedAdvertised =
        (
          await execa(
            "git",
            ["ls-remote", request.repositoryUrl, `refs/heads/${request.seedRef}`],
            {
              cwd: request.worktreePath,
              env: environment,
              timeout: options.gitTimeoutMs,
            },
          )
        ).stdout.split(/\s+/, 1)[0] ?? "";
    }
    if (cloudAdvertised.stdout.split(/\s+/, 1)[0] !== request.baseSha) {
      if (request.seedRef && seedAdvertised !== request.baseSha) {
        throw new Error("needs_attention");
      }
      await execa(
        "git",
        ["push", request.repositoryUrl, `${request.baseSha}:refs/heads/${request.branch}`],
        {
          cwd: request.worktreePath,
          env: environment,
          timeout: options.gitTimeoutMs,
        },
      );
    }
    if (request.seedRef && seedAdvertised) {
      await execa("git", ["push", request.repositoryUrl, `:refs/heads/${request.seedRef}`], {
        cwd: request.worktreePath,
        env: environment,
        timeout: options.gitTimeoutMs,
      });
    }
    return { branch: request.branch, baseSha: request.baseSha };
  }

  if (!request.headSha || !SHA.test(request.headSha)) {
    throw new Error("invalid_git_request");
  }
  await execa(
    "git",
    ["push", request.repositoryUrl, `${request.headSha}:refs/heads/${request.branch}`],
    {
      cwd: request.worktreePath,
      env: environment,
      timeout: options.gitTimeoutMs,
    },
  );
  return { branch: request.branch, headSha: request.headSha };
}

export async function startGitBroker(options: {
  socketPath: string;
  authToken: string;
  repositoryRoot: string;
  worktreeRoot: string;
  uid: number;
  gid: number;
  gitTimeoutMs?: number;
  socketTimeoutMs?: number;
}): Promise<net.Server> {
  await mkdir(path.dirname(options.socketPath), { recursive: true });
  await rm(options.socketPath, { force: true });
  const server = net.createServer((socket) => {
    let body = "";
    socket.setEncoding("utf8");
    socket.setTimeout(options.socketTimeoutMs ?? 10_000, () => socket.destroy());
    socket.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > 256 * 1024) socket.destroy();
      const newline = body.indexOf("\n");
      if (newline < 0) return;
      socket.pause();
      void (async () => {
        let response: BrokerResponse;
        try {
          const request = JSON.parse(body.slice(0, newline)) as BrokerRequest;
          if (!authorized(request.authToken ?? "", options.authToken)) {
            throw new Error("unauthorized");
          }
          response = {
            ok: true,
            result: await execute(request, {
              ...options,
              gitTimeoutMs: options.gitTimeoutMs ?? 120_000,
            }),
          };
        } catch (error) {
          const code = error instanceof Error ? error.message : "git_failed";
          response = {
            ok: false,
            error: {
              code: /^[a-z_]+$/.test(code) ? code : "git_failed",
              message: "Git broker operation failed",
            },
          };
        }
        socket.end(`${JSON.stringify(response)}\n`);
      })();
    });
  });
  server.maxConnections = 32;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  await chown(options.socketPath, options.uid, options.gid);
  await chmod(options.socketPath, 0o600);
  return server;
}
