#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startGitBroker } from "./git-broker.js";

const authToken = process.env.CLOUD_DAEMON_TOKEN;
if (!authToken) throw new Error("CLOUD_DAEMON_TOKEN is required");
const uid = Number(process.env.WATT_UID ?? "10001");
const gid = Number(process.env.WATT_GID ?? "10001");
const socketPath = process.env.WATT_GIT_BROKER_SOCKET ?? "/run/watt/git-broker.sock";
const repositoryRoot = process.env.WATT_REPOSITORY_ROOT ?? "/var/lib/watt/repositories";
const worktreeRoot = process.env.WATT_WORKTREE_ROOT ?? "/var/lib/watt/worktrees";
const broker = await startGitBroker({
  socketPath,
  authToken,
  repositoryRoot,
  worktreeRoot,
  uid,
  gid,
});
const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.js");
const daemon = spawn(process.execPath, [cli], {
  stdio: "inherit",
  uid,
  gid,
  env: { ...process.env, WATT_GIT_BROKER_SOCKET: socketPath },
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => daemon.kill(signal));
}
const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) =>
  daemon.once("exit", (exitCode, exitSignal) => resolve([exitCode, exitSignal])),
);
await new Promise<void>((resolve) => broker.close(() => resolve()));
if (signal) process.kill(process.pid, signal);
process.exitCode = code ?? 1;
