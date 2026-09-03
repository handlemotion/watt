const required = [
  "WATT_CLOUD_API_URL",
  "WATT_CLOUD_ACCESS_TOKEN",
  "WATT_CLOUD_REFRESH_TOKEN",
  "WATT_GITHUB_REPOSITORY_ID",
  "WATT_GITHUB_INSTALLATION_ID",
  "WATT_SMOKE_BASE_SHA",
];
for (const name of required) {
  if (!process.env[name]) throw new Error(`${name} is required`);
}

const baseUrl = process.env.WATT_CLOUD_API_URL.replace(/\/$/, "");
let accessToken = process.env.WATT_CLOUD_ACCESS_TOKEN;
let refreshToken = process.env.WATT_CLOUD_REFRESH_TOKEN;
let accessTokenExpiresAt = 0;

async function refreshAccessToken() {
  const response = await fetch(`${baseUrl}/api/auth/oauth2/token`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: "watt-desktop",
      refresh_token: refreshToken,
      resource: `${baseUrl}/v1`,
    }),
  });
  const value = await response.json().catch(() => undefined);
  if (
    !response.ok ||
    !value ||
    typeof value.access_token !== "string" ||
    typeof value.refresh_token !== "string"
  ) {
    throw new Error(`OAuth refresh failed: ${response.status} ${JSON.stringify(value)}`);
  }
  accessToken = value.access_token;
  refreshToken = value.refresh_token;
  const expiresIn =
    typeof value.expires_in === "number" && Number.isFinite(value.expires_in)
      ? value.expires_in
      : 900;
  accessTokenExpiresAt = Date.now() + Math.max(60, expiresIn - 60) * 1000;
}

async function ensureAccessToken() {
  if (Date.now() < accessTokenExpiresAt) return;
  await refreshAccessToken();
}

async function authorizedFetch(path, init = {}) {
  await ensureAccessToken();
  const send = () => {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${accessToken}`);
    return fetch(`${baseUrl}${path}`, { ...init, headers });
  };
  let response = await send();
  if (response.status === 401) {
    await refreshAccessToken();
    response = await send();
  }
  return response;
}

async function request(method, path, body, idempotencyKey) {
  const requestOptions = {
    method,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    },
  };
  if (body !== undefined) requestOptions.body = JSON.stringify(body);
  const response = await authorizedFetch(path, requestOptions);
  const value = await response.json();
  if (!response.ok) {
    throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(value)}`);
  }
  return value;
}

async function waitFor(check, timeoutMs, intervalMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await check();
    if (result) return result;
    if (Date.now() >= deadline) throw new Error("provider smoke timed out");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

const nonce = crypto.randomUUID();
const repository = await request("POST", "/v1/repositories", {
  githubRepositoryId: Number(process.env.WATT_GITHUB_REPOSITORY_ID),
  installationId: Number(process.env.WATT_GITHUB_INSTALLATION_ID),
});
await request("POST", "/v1/cloud-host/wake");
const created = await request(
  "POST",
  "/v1/chats",
  {
    repositoryId: repository.id,
    title: `Provider smoke ${nonce}`,
    baseRef: process.env.WATT_SMOKE_BASE_REF ?? "main",
    baseSha: process.env.WATT_SMOKE_BASE_SHA,
    prompt: `This is an infrastructure smoke test. Run 'sleep 540', then create provider-smoke-${nonce}.txt containing '${nonce}', commit it with message 'test: provider smoke ${nonce}', and do not rewrite existing history.`,
  },
  `provider-smoke-${nonce}`,
);
const runId = created.run.run.id;

const disconnected = new AbortController();
const firstStream = authorizedFetch(`/v1/runs/${runId}/events`, {
  headers: {
    accept: "text/event-stream",
  },
  signal: disconnected.signal,
});
await Promise.race([
  firstStream.then((response) => response.body?.getReader().read()),
  new Promise((resolve) => setTimeout(resolve, 10_000)),
]);
disconnected.abort();

await new Promise((resolve) => setTimeout(resolve, 9 * 60_000));
const active = await request("GET", "/v1/cloud-host");
if (active.status !== "ready" || active.activeRuns < 1) {
  throw new Error(`sandbox did not remain active: ${JSON.stringify(active)}`);
}

const changeset = await waitFor(async () => {
  const rows = await request("GET", `/v1/chats/${created.chat.id}/changesets`);
  const current = rows.find((row) => row.runId === runId);
  return current?.state === "published" ? current : undefined;
}, 15 * 60_000);

await new Promise((resolve) => setTimeout(resolve, 9 * 60_000));
const stopped = await request("GET", "/v1/cloud-host");
if (stopped.status !== "stopped") {
  throw new Error(`sandbox did not stop after the idle interval: ${JSON.stringify(stopped)}`);
}
await request("POST", "/v1/cloud-host/wake");

const replay = await authorizedFetch(`/v1/runs/${runId}/events?afterSequence=0`, {
  headers: {
    accept: "text/event-stream",
  },
});
const replayBody = await replay.text();
if (
  !replay.ok ||
  !replayBody.includes("event: run_event") ||
  !replayBody.includes("event: run_end")
) {
  throw new Error("persisted run events did not replay after wake");
}
await request(
  "POST",
  `/v1/chats/${created.chat.id}/archive`,
  undefined,
  `provider-smoke-archive-${nonce}`,
);

process.stdout.write(
  `${JSON.stringify({ ok: true, chatId: created.chat.id, runId, changesetId: changeset.id })}\n`,
);
