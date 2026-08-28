#!/usr/bin/env node

import { serveConnection } from "./server.js";

let stopping = false;
function stop(): void {
  if (stopping) return;
  stopping = true;
  process.stdin.destroy();
}

process.once("SIGINT", stop);
process.once("SIGTERM", stop);

serveConnection(process.stdin, process.stdout).catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : "unknown sidecar failure";
  process.stderr.write(`watt desktop sidecar: ${message}\n`);
  process.exitCode = 1;
});
