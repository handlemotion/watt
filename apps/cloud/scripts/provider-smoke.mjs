const required = [
  "WATT_CLOUD_API_URL",
  "WATT_CLOUD_ACCESS_TOKEN",
  "WATT_GITHUB_REPOSITORY_ID",
  "WATT_GITHUB_INSTALLATION_ID",
  "WATT_SMOKE_BASE_SHA",
];
for (const name of required) {
  if (!process.env[name]) throw new Error(`${name} is required`);
}

const baseUrl = process.env.WATT_CLOUD_API_URL.replace(/\/$/, "");
const accessToken = process.env.WATT_CLOUD_ACCESS_TOKEN;
const headers = {
  authorization: `Bearer ${accessToken}`,
  accept: "application/json",
  "content-type": "application/json",
};

async function request(method, path, body, idempotencyKey) {
  const requestOptions = {
    method,
    headers: {
      ...headers,
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    },
  };
  if (body !== undefined) requestOptions.body = JSON.stringify(body);
  const response = await fetch(`${baseUrl}${path}`, requestOptions);
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
const firstStream = fetch(`${baseUrl}/v1/runs/${runId}/events`, {
  headers: {
    authorization: `Bearer ${accessToken}`,
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

const replay = await fetch(`${baseUrl}/v1/runs/${runId}/events?afterSequence=0`, {
  headers: {
    authorization: `Bearer ${accessToken}`,
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
