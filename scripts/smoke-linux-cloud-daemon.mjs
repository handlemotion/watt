#!/usr/bin/env node
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageInfo = JSON.parse(
  readFileSync(path.join(root, "packages/cloud-daemon/package.json"), "utf8"),
);
const artifactDir = path.join(root, ".artifacts");
const tarball = `Watt-cloud-daemon-v${packageInfo.version}-linux-x64.tar.gz`;
const tarballPath = path.join(artifactDir, tarball);
const shaPath = `${tarballPath}.sha256`;
const shaLine = readFileSync(shaPath, "utf8").trim();
const expectedSha = shaLine.split(/\s+/)[0];

const server = createServer((request, response) => {
  if (request.url === `/${tarball}`) {
    response.writeHead(200, { "content-type": "application/gzip" });
    response.end(readFileSync(tarballPath));
    return;
  }
  response.writeHead(404).end();
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") {
  throw new Error("artifact server failed to start");
}

const authToken = "smoke-daemon-token";
const port = 8788;
const child = spawn(
  "sudo",
  ["-E", "bash", path.join(root, "packages/cloud-daemon/scripts/bootstrap.sh")],
  {
    env: {
      ...process.env,
      WATT_DAEMON_TARBALL_URL: `http://127.0.0.1:${address.port}/${tarball}`,
      WATT_DAEMON_TARBALL_SHA256: expectedSha,
      WATT_DAEMON_CONFIG_VERSION: "smoke-config-version",
      CLOUD_DAEMON_TOKEN: authToken,
      PORT: String(port),
      CURSOR_API_KEY: process.env.CURSOR_API_KEY ?? "smoke-placeholder",
    },
    stdio: "inherit",
  },
);

const exitCode = await new Promise((resolve) => child.on("exit", resolve));
server.close();
if (exitCode !== 0) {
  throw new Error(`bootstrap smoke failed with exit code ${exitCode ?? "unknown"}`);
}

// The packaged daemon's health request initializes Host and discovers its capabilities,
// exercising the runtime dependencies from the deployed artifact.
const health = await fetch(`http://127.0.0.1:${port}/health`, {
  headers: { "x-watt-daemon-token": authToken },
});
if (!health.ok) throw new Error(`health check failed: ${health.status}`);

process.stdout.write(`${JSON.stringify({ ok: true })}\n`);
