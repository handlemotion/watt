import { chmod, mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { startGitBroker } from "./git-broker.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function call(socketPath: string, body: object): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let response = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify(body)}\n`));
    socket.on("data", (chunk) => (response += chunk));
    socket.once("error", reject);
    socket.once("end", () => resolve(JSON.parse(response)));
  });
}

describe("root Git broker boundary", () => {
  it("uses an owner-only socket and rejects callers without the daemon secret", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "watt-git-broker-"));
    temporary.push(root);
    const socketPath = path.join(root, "broker.sock");
    const server = await startGitBroker({
      socketPath,
      authToken: "daemon-secret",
      repositoryRoot: path.join(root, "repositories"),
      worktreeRoot: path.join(root, "worktrees"),
      uid: process.getuid?.() ?? 0,
      gid: process.getgid?.() ?? 0,
    });
    try {
      expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
      await expect(call(socketPath, { authToken: "wrong", operation: "publish" })).resolves.toEqual(
        {
          ok: false,
          error: {
            code: "unauthorized",
            message: "Git broker operation failed",
          },
        },
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("clones a new numeric repository path before fetching the exact ref", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "watt-git-broker-"));
    temporary.push(root);
    const bin = path.join(root, "bin");
    const repositoryRoot = path.join(root, "repositories");
    const repositoryPath = path.join(repositoryRoot, "42");
    const socketPath = path.join(root, "broker.sock");
    const sha = "a".repeat(40);
    await mkdir(bin);
    await writeFile(
      path.join(bin, "git"),
      `#!/usr/bin/env node
import { mkdirSync } from "node:fs";
if (process.argv[2] === "clone") mkdirSync(process.argv.at(-1) + "/.git", { recursive: true });
if (process.argv[2] === "rev-parse") process.stdout.write("${sha}\\n");
`,
      { mode: 0o755 },
    );
    await chmod(path.join(bin, "git"), 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}:${originalPath}`;
    const server = await startGitBroker({
      socketPath,
      authToken: "daemon-secret",
      repositoryRoot,
      worktreeRoot: path.join(root, "worktrees"),
      uid: process.getuid?.() ?? 0,
      gid: process.getgid?.() ?? 0,
    });
    try {
      await expect(
        call(socketPath, {
          authToken: "daemon-secret",
          operation: "connect",
          repositoryUrl: "https://github.com/example/repository.git",
          repositoryRoot: repositoryPath,
          repositoryId: "42",
          ref: "refs/heads/main",
          expectedSha: sha,
          githubToken: "installation-token",
        }),
      ).resolves.toEqual({
        ok: true,
        result: { repositoryRoot: repositoryPath, head: sha },
      });
      await expect(stat(path.join(repositoryPath, ".git"))).resolves.toBeTruthy();
    } finally {
      process.env.PATH = originalPath;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("bounds privileged Git commands", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "watt-git-broker-"));
    temporary.push(root);
    const bin = path.join(root, "bin");
    const repositoryRoot = path.join(root, "repositories");
    const socketPath = path.join(root, "broker.sock");
    await mkdir(bin);
    await writeFile(path.join(bin, "git"), "#!/usr/bin/env node\nsetInterval(() => {}, 1_000);\n", {
      mode: 0o755,
    });
    await chmod(path.join(bin, "git"), 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}:${originalPath}`;
    const server = await startGitBroker({
      socketPath,
      authToken: "daemon-secret",
      repositoryRoot,
      worktreeRoot: path.join(root, "worktrees"),
      uid: process.getuid?.() ?? 0,
      gid: process.getgid?.() ?? 0,
      gitTimeoutMs: 50,
    });
    try {
      await expect(
        call(socketPath, {
          authToken: "daemon-secret",
          operation: "connect",
          repositoryUrl: "https://github.com/example/repository.git",
          repositoryRoot: path.join(repositoryRoot, "42"),
          repositoryId: "42",
          ref: "refs/heads/main",
          expectedSha: "a".repeat(40),
          githubToken: "installation-token",
        }),
      ).resolves.toEqual({
        ok: false,
        error: {
          code: "git_failed",
          message: "Git broker operation failed",
        },
      });
    } finally {
      process.env.PATH = originalPath;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
