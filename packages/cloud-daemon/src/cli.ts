#!/usr/bin/env node
import { serve } from "@hono/node-server";
import { createHost } from "@watt/host";

import { createCloudDaemon, stripBootstrapSecrets } from "./index.js";

const authToken = process.env.CLOUD_DAEMON_TOKEN;
const cursorApiKey = process.env.CURSOR_API_KEY;
if (!authToken) throw new Error("CLOUD_DAEMON_TOKEN is required");
const stateDir = process.env.WATT_STATE_DIR ?? "/var/lib/watt/state";
const worktreeRoot = process.env.WATT_WORKTREE_ROOT ?? "/var/lib/watt/worktrees";
const port = Number(process.env.PORT ?? "8788");
const gitBrokerSocket = process.env.WATT_GIT_BROKER_SOCKET;
stripBootstrapSecrets();
const host = await createHost({ stateDir, worktreeRoot, apiKey: cursorApiKey });
const server = serve({
  fetch: createCloudDaemon({
    host,
    authToken,
    ...(gitBrokerSocket ? { gitBroker: { socketPath: gitBrokerSocket, authToken } } : {}),
  }).fetch,
  port,
});

async function shutdown(): Promise<void> {
  server.close();
  await host.close();
}
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
