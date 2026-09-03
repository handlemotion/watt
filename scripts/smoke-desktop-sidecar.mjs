import { mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagedExecutable = path.join(
  root,
  "apps",
  "desktop",
  "src-tauri",
  "binaries",
  "watt-desktop-sidecar-aarch64-apple-darwin",
);
const executable = process.env.WATT_SIDECAR_EXECUTABLE ?? packagedExecutable;
const executableArguments = executable.endsWith(".js") ? [executable] : [];
const command = executableArguments.length === 0 ? executable : process.execPath;
const temporary = mkdtempSync(path.join(tmpdir(), "watt-sidecar-smoke-"));
const child = spawn(command, executableArguments, {
  stdio: ["pipe", "pipe", "pipe"],
});
child.stdin.on("error", () => {
  // An early process exit is reported through exitedEarly with stderr context.
});
let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString("utf8");
});
let rejectTimeout;
const timedOut = new Promise((_, reject) => {
  rejectTimeout = reject;
});
const timeout = setTimeout(() => {
  child.kill("SIGKILL");
  rejectTimeout(new Error("timed out waiting for desktop sidecar"));
}, 15_000);
const exited = new Promise((resolve) => child.once("exit", resolve));
const exitedEarly = exited.then((code) => {
  throw new Error(
    `desktop sidecar exited before completing the protocol smoke test (${code})${stderr ? `: ${stderr.trim()}` : ""}`,
  );
});

function frame(value) {
  const payload = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length);
  return Buffer.concat([header, payload]);
}

let buffered = Buffer.alloc(0);
const frames = [];
let wake;
child.stdout.on("data", (chunk) => {
  buffered = Buffer.concat([buffered, chunk]);
  while (buffered.length >= 4) {
    const length = buffered.readUInt32BE(0);
    if (buffered.length < length + 4) break;
    frames.push(JSON.parse(buffered.subarray(4, length + 4).toString("utf8")));
    buffered = buffered.subarray(length + 4);
  }
  wake?.();
  wake = undefined;
});

async function nextFrame() {
  while (frames.length === 0) {
    await Promise.race([
      new Promise((resolve) => {
        wake = resolve;
      }),
      exitedEarly,
      timedOut,
    ]);
  }
  return frames.shift();
}

try {
  child.stdin.write(
    frame({
      type: "hello",
      protocolVersionMin: 1,
      protocolVersionMax: 1,
      capabilities: [
        "host.projects.v1",
        "host.workspaces.v1",
        "host.sessions.v1",
        "host.runs.v1",
        "run-stream.v1",
        "graceful-shutdown.v1",
      ],
      host: {
        stateDir: path.join(temporary, "state"),
        worktreeRoot: path.join(temporary, "worktrees"),
      },
    }),
  );
  const hello = await nextFrame();
  if (hello.type !== "hello_ack" || hello.version !== 1) {
    throw new Error(`unexpected sidecar handshake: ${JSON.stringify(hello)}`);
  }

  const requestId = "01J00000000000000000000999";
  child.stdin.write(
    frame({
      type: "request",
      version: 1,
      requestId,
      method: "host.close",
      params: {},
    }),
  );
  const closed = await nextFrame();
  if (
    closed.type !== "result" ||
    closed.requestId !== requestId ||
    closed.result?.closed !== true
  ) {
    throw new Error(`unexpected sidecar shutdown: ${JSON.stringify(closed)}`);
  }

  child.stdin.end();
  const exitCode = await Promise.race([exited, timedOut]);
  if (exitCode !== 0) throw new Error(`sidecar exited with ${exitCode}`);
  console.log("Desktop sidecar handshake and graceful shutdown passed.");
} finally {
  clearTimeout(timeout);
  if (child.exitCode === null) child.kill("SIGKILL");
  rmSync(temporary, { recursive: true, force: true });
}
