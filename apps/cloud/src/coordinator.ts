import { DurableObject } from "cloudflare:workers";
import postgres from "postgres";

import { mapUpstashStatus, UpstashBoxClient, type PublicIngress } from "./upstash.js";

type HostRow = {
  owner_id: string;
  box_id: string | null;
  status: string;
  error_code: string | null;
  ingress_url: string | null;
  ingress_bearer_token: string | null;
  idle_deadline: number | null;
};
type RunRow = {
  run_id: string;
  installation_id: number;
  base_sha: string;
  branch: string;
  repository_url: string | null;
};
const MUTATION_LEASE_MS = 10 * 60_000;
const IDLE_PAUSE_MS = 8 * 60_000;
const POLL_INTERVAL_MS = 15_000;

export class CloudHostCoordinator extends DurableObject<CloudflareBindings> {
  #readyRequest: Promise<{ boxId: string }> | undefined;

  constructor(ctx: DurableObjectState, env: CloudflareBindings) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS _sql_schema_migrations (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')));
        CREATE TABLE IF NOT EXISTS host (owner_id TEXT PRIMARY KEY, box_id TEXT, status TEXT NOT NULL, error_code TEXT, ingress_url TEXT, ingress_bearer_token TEXT, idle_deadline INTEGER);
        CREATE TABLE IF NOT EXISTS active_runs (run_id TEXT PRIMARY KEY, installation_id INTEGER NOT NULL, base_sha TEXT NOT NULL, branch TEXT NOT NULL, repository_url TEXT, created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS mutations (operation TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, status TEXT NOT NULL, response_json TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (operation, idempotency_key));
        CREATE TABLE IF NOT EXISTS rate_limits (bucket TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL);
        INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (1);
      `);
      const hostColumns = this.ctx.storage.sql
        .exec<{ name: string }>("PRAGMA table_info(host)")
        .toArray();
      if (hostColumns.some((column) => column.name === "sandbox_id")) {
        this.ctx.storage.sql.exec("ALTER TABLE host RENAME COLUMN sandbox_id TO box_id");
      }
      if (!hostColumns.some((column) => column.name === "ingress_url")) {
        this.ctx.storage.sql.exec("ALTER TABLE host ADD COLUMN ingress_url TEXT");
      }
      if (!hostColumns.some((column) => column.name === "ingress_bearer_token")) {
        this.ctx.storage.sql.exec("ALTER TABLE host ADD COLUMN ingress_bearer_token TEXT");
      }
      if (!hostColumns.some((column) => column.name === "idle_deadline")) {
        this.ctx.storage.sql.exec("ALTER TABLE host ADD COLUMN idle_deadline INTEGER");
      }
      const activeRunColumns = this.ctx.storage.sql
        .exec<{ name: string }>("PRAGMA table_info(active_runs)")
        .toArray();
      if (!activeRunColumns.some((column) => column.name === "repository_url")) {
        this.ctx.storage.sql.exec("ALTER TABLE active_runs ADD COLUMN repository_url TEXT");
      }
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (2), (3)",
      );
    });
  }

  async takeRateLimit(
    bucket: string,
    limit: number,
    windowMs: number,
  ): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
    const now = Date.now();
    const row = this.ctx.storage.sql
      .exec<{ window_start: number; count: number }>(
        "SELECT window_start, count FROM rate_limits WHERE bucket = ?",
        bucket,
      )
      .toArray()[0];
    if (!row || now - row.window_start >= windowMs) {
      this.ctx.storage.sql.exec(
        "INSERT INTO rate_limits (bucket, window_start, count) VALUES (?, ?, 1) ON CONFLICT(bucket) DO UPDATE SET window_start = excluded.window_start, count = 1",
        bucket,
        now,
      );
      return { allowed: true, retryAfterSeconds: 0 };
    }
    if (row.count >= limit)
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((windowMs - (now - row.window_start)) / 1000)),
      };
    this.ctx.storage.sql.exec("UPDATE rate_limits SET count = count + 1 WHERE bucket = ?", bucket);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  async beginMutation(
    operation: string,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<
    | { state: "new" }
    | { state: "replay"; responseJson: string }
    | { state: "in_progress" }
    | { state: "conflict" }
  > {
    const row = this.ctx.storage.sql
      .exec<{
        request_hash: string;
        status: string;
        response_json: string | null;
        created_at: number;
      }>(
        "SELECT request_hash, status, response_json, created_at FROM mutations WHERE operation = ? AND idempotency_key = ?",
        operation,
        idempotencyKey,
      )
      .toArray()[0];
    if (row) {
      if (row.request_hash !== requestHash) return { state: "conflict" };
      if (row.status === "complete" && row.response_json)
        return { state: "replay", responseJson: row.response_json };
      if (Date.now() - row.created_at < MUTATION_LEASE_MS) return { state: "in_progress" };
    }
    const other = this.ctx.storage.sql
      .exec<{ present: number }>(
        "SELECT 1 AS present FROM mutations WHERE status = 'pending' AND created_at >= ? AND NOT (operation = ? AND idempotency_key = ?) LIMIT 1",
        Date.now() - MUTATION_LEASE_MS,
        operation,
        idempotencyKey,
      )
      .toArray()[0];
    if (other) return { state: "in_progress" };
    if (row) {
      this.ctx.storage.sql.exec(
        "UPDATE mutations SET created_at = ? WHERE operation = ? AND idempotency_key = ?",
        Date.now(),
        operation,
        idempotencyKey,
      );
    } else {
      this.ctx.storage.sql.exec(
        "INSERT INTO mutations (operation, idempotency_key, request_hash, status, response_json, created_at) VALUES (?, ?, ?, 'pending', NULL, ?)",
        operation,
        idempotencyKey,
        requestHash,
        Date.now(),
      );
    }
    return { state: "new" };
  }

  async finishMutation(
    operation: string,
    idempotencyKey: string,
    responseJson: string,
  ): Promise<void> {
    this.ctx.storage.sql.exec(
      "UPDATE mutations SET status = 'complete', response_json = ? WHERE operation = ? AND idempotency_key = ?",
      responseJson,
      operation,
      idempotencyKey,
    );
  }

  async status(ownerId: string): Promise<{ status: string; activeRuns: number }> {
    let host = this.host(ownerId);
    if (host?.box_id) {
      try {
        const box = await this.upstash().get(host.box_id);
        if (!box) {
          this.ctx.storage.sql.exec(
            "UPDATE host SET status = 'error', error_code = 'box_missing' WHERE owner_id = ?",
            ownerId,
          );
          host = { ...host, status: "error", error_code: "box_missing" };
        } else {
          const observed = mapUpstashStatus(box.status);
          if (observed !== host.status) {
            this.ctx.storage.sql.exec(
              "UPDATE host SET status = ? WHERE owner_id = ?",
              observed,
              ownerId,
            );
            host = { ...host, status: observed };
          }
        }
      } catch {
        // Preserve the last known state for transient Upstash control-plane errors.
      }
    }
    const activeRuns = this.ctx.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM active_runs")
      .one().count;
    return {
      status: host?.status ?? "stopped",
      activeRuns,
    };
  }

  async wake(ownerId: string): Promise<{ status: "ready" }> {
    await this.ensureReady(ownerId);
    return { status: "ready" };
  }

  async beginRun(
    ownerId: string,
    runId: string,
    publication: {
      installationId: number;
      baseSha: string;
      branch: string;
      repositoryUrl: string;
    },
  ): Promise<void> {
    await this.ensureReady(ownerId);
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO active_runs (run_id, installation_id, base_sha, branch, repository_url, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      runId,
      publication.installationId,
      publication.baseSha,
      publication.branch,
      publication.repositoryUrl,
      Date.now(),
    );
    this.ctx.storage.sql.exec("UPDATE host SET idle_deadline = NULL WHERE owner_id = ?", ownerId);
    await this.ctx.storage.setAlarm(Date.now() + POLL_INTERVAL_MS);
  }

  async endRun(ownerId: string, runId: string): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM active_runs WHERE run_id = ?", runId);
    await this.updateIdlePolicy(ownerId);
  }

  async installationToken(installationId: number): Promise<string> {
    return githubInstallationToken(this.env, installationId);
  }

  async proxy(ownerId: string, path: string, request: Request): Promise<Response> {
    const ingress = await this.ensureIngress(ownerId);
    const target = new URL(path, ingress.url);
    const headers = new Headers(request.headers);
    headers.set("authorization", `Bearer ${ingress.bearerToken}`);
    headers.set("x-watt-daemon-token", this.env.CLOUD_DAEMON_TOKEN);
    headers.delete("host");
    return fetch(target, {
      method: request.method,
      headers,
      body: request.body,
      redirect: "manual",
    });
  }

  async alarm(): Promise<void> {
    const host = this.ctx.storage.sql
      .exec<HostRow>(
        "SELECT owner_id, box_id, status, error_code, ingress_url, ingress_bearer_token, idle_deadline FROM host LIMIT 1",
      )
      .toArray()[0];
    if (!host) return;
    const runs = this.ctx.storage.sql
      .exec<RunRow>(
        "SELECT run_id, installation_id, base_sha, branch, repository_url FROM active_runs ORDER BY created_at",
      )
      .toArray();
    const now = Date.now();
    if (
      runs.length === 0 &&
      host.idle_deadline !== null &&
      now >= host.idle_deadline &&
      host.box_id
    ) {
      await this.pauseHost(host);
      return;
    }
    if (runs.length > 0 && host.box_id) {
      try {
        await this.upstash().heartbeat(host.box_id);
      } catch (error) {
        console.error(
          JSON.stringify({
            message: "box heartbeat failed",
            boxId: host.box_id,
            error: error instanceof Error ? error.name : "unknown",
          }),
        );
      }
    }
    for (const run of runs) {
      try {
        const response = await this.proxy(
          host.owner_id,
          "/v1/host/call",
          new Request("https://coordinator.invalid", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              method: "runs.get",
              params: { id: run.run_id },
            }),
          }),
        );
        const body = await response.json<{ result?: { status?: string } }>();
        if (body.result && ["finished", "error", "cancelled"].includes(body.result.status ?? "")) {
          if (!run.repository_url) throw new Error("publication_metadata_missing");
          const token = await githubInstallationToken(this.env, run.installation_id);
          const publication = await this.proxy(
            host.owner_id,
            "/v1/git/publish",
            new Request("https://coordinator.invalid", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                runId: run.run_id,
                baseSha: run.base_sha,
                branch: run.branch,
                repositoryUrl: run.repository_url,
                token,
              }),
            }),
          );
          if (!publication.ok) throw new Error("publication_failed");
          const result = await publication.json<{
            state?: string;
            headSha?: string;
            errorCode?: string;
          }>();
          const sql = postgres(this.env.HYPERDRIVE.connectionString, {
            prepare: false,
            max: 1,
          });
          try {
            await sql`UPDATE changesets SET state = ${result.state ?? "needs_attention"}, head_sha = ${result.headSha ?? null}, error_code = ${result.errorCode ?? (publication.ok ? null : "publication_failed")}, journal = journal || ${JSON.stringify([{ phase: "publication_finished", at: new Date().toISOString(), state: result.state ?? "needs_attention" }])}::jsonb, updated_at = now() WHERE run_id = ${run.run_id}`;
            if (result.state === "published" && result.headSha) {
              await sql`UPDATE cloud_chats SET base_sha = ${result.headSha}, updated_at = now() WHERE id = (SELECT chat_id FROM changesets WHERE run_id = ${run.run_id})`;
            }
          } finally {
            await sql.end();
          }
          this.ctx.storage.sql.exec("DELETE FROM active_runs WHERE run_id = ?", run.run_id);
        }
      } catch (error) {
        console.error(
          JSON.stringify({
            message: "run status poll failed",
            runId: run.run_id,
            error: error instanceof Error ? error.name : "unknown",
          }),
        );
      }
    }
    await this.updateIdlePolicy(host.owner_id);
  }

  private host(ownerId: string): HostRow | undefined {
    return this.ctx.storage.sql
      .exec<HostRow>(
        "SELECT owner_id, box_id, status, error_code, ingress_url, ingress_bearer_token, idle_deadline FROM host WHERE owner_id = ?",
        ownerId,
      )
      .toArray()[0];
  }

  private upstash(): UpstashBoxClient {
    return new UpstashBoxClient({ apiKey: this.env.UPSTASH_BOX_API_KEY });
  }

  private ensureReady(ownerId: string): Promise<{ boxId: string }> {
    const current = this.host(ownerId);
    if (
      current?.box_id &&
      current.status === "ready" &&
      current.ingress_url &&
      current.ingress_bearer_token
    ) {
      return Promise.resolve({ boxId: current.box_id });
    }
    this.#readyRequest ??= this.provisionReady(ownerId).finally(() => {
      this.#readyRequest = undefined;
    });
    return this.#readyRequest;
  }

  private bootstrapEnv(): Record<string, string> {
    return {
      WATT_DAEMON_TARBALL_URL: this.env.CLOUD_DAEMON_TARBALL_URL,
      WATT_DAEMON_TARBALL_SHA256: this.env.CLOUD_DAEMON_TARBALL_SHA256,
      PORT: this.env.CLOUD_DAEMON_PORT,
    };
  }

  private async provisionReady(ownerId: string): Promise<{ boxId: string }> {
    const upstash = this.upstash();
    const current = this.host(ownerId);
    let boxId = current?.box_id ?? null;
    const port = Number(this.env.CLOUD_DAEMON_PORT);
    try {
      if (!current?.box_id) {
        this.ctx.storage.sql.exec(
          "INSERT INTO host (owner_id, box_id, status, error_code, ingress_url, ingress_bearer_token, idle_deadline) VALUES (?, NULL, 'provisioning', NULL, NULL, NULL, NULL) ON CONFLICT(owner_id) DO UPDATE SET status = 'provisioning', error_code = NULL",
          ownerId,
        );
        const created = await upstash.create(ownerId, this.bootstrapEnv());
        boxId = created.id;
        this.ctx.storage.sql.exec(
          "UPDATE host SET box_id = ?, status = 'starting' WHERE owner_id = ?",
          created.id,
          ownerId,
        );
      } else {
        const existing = await upstash.get(current.box_id);
        if (!existing) {
          this.ctx.storage.sql.exec(
            "UPDATE host SET status = 'error', error_code = 'box_missing' WHERE owner_id = ?",
            ownerId,
          );
          throw new Error("box_missing");
        }
        await upstash.resume(current.box_id);
      }
      await upstash.bootstrap(boxId!, {
        daemonToken: this.env.CLOUD_DAEMON_TOKEN,
        cursorApiKey: this.env.CURSOR_API_KEY,
      });
      const ingress = await this.refreshIngress(ownerId, boxId!, port);
      await this.waitForHealth(ingress);
      this.ctx.storage.sql.exec(
        "UPDATE host SET status = 'ready', error_code = NULL WHERE owner_id = ?",
        ownerId,
      );
      return { boxId: boxId! };
    } catch (error) {
      this.ctx.storage.sql.exec(
        "INSERT INTO host (owner_id, box_id, status, error_code, ingress_url, ingress_bearer_token, idle_deadline) VALUES (?, ?, 'error', 'host_start_timeout', NULL, NULL, NULL) ON CONFLICT(owner_id) DO UPDATE SET box_id = COALESCE(excluded.box_id, box_id), status = 'error', error_code = 'host_start_timeout', ingress_url = NULL, ingress_bearer_token = NULL, idle_deadline = NULL",
        ownerId,
        boxId,
      );
      throw error;
    }
  }

  private async ensureIngress(ownerId: string): Promise<PublicIngress> {
    await this.ensureReady(ownerId);
    const host = this.host(ownerId);
    if (host?.ingress_url && host.ingress_bearer_token && host.status === "ready") {
      return {
        url: host.ingress_url,
        bearerToken: host.ingress_bearer_token,
      };
    }
    if (!host?.box_id) throw new Error("host_not_ready");
    return this.refreshIngress(ownerId, host.box_id, Number(this.env.CLOUD_DAEMON_PORT));
  }

  private async refreshIngress(
    ownerId: string,
    boxId: string,
    port: number,
  ): Promise<PublicIngress> {
    const ingress = await this.upstash().createIngress(boxId, port);
    this.ctx.storage.sql.exec(
      "UPDATE host SET ingress_url = ?, ingress_bearer_token = ? WHERE owner_id = ?",
      ingress.url,
      ingress.bearerToken,
      ownerId,
    );
    return ingress;
  }

  private async waitForHealth(ingress: PublicIngress): Promise<void> {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const response = await fetch(new URL("/health", ingress.url), {
        headers: {
          authorization: `Bearer ${ingress.bearerToken}`,
          "x-watt-daemon-token": this.env.CLOUD_DAEMON_TOKEN,
        },
        signal: AbortSignal.timeout(5_000),
      }).catch(() => undefined);
      if (response?.ok) break;
      if (Date.now() >= deadline) throw new Error("host_start_timeout");
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }

  private async pauseHost(host: HostRow): Promise<void> {
    if (!host.box_id) return;
    try {
      await this.upstash().pause(host.box_id, Number(this.env.CLOUD_DAEMON_PORT));
      this.ctx.storage.sql.exec(
        "UPDATE host SET status = 'stopped', ingress_url = NULL, ingress_bearer_token = NULL, idle_deadline = NULL WHERE owner_id = ?",
        host.owner_id,
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          message: "box pause failed",
          boxId: host.box_id,
          error: error instanceof Error ? error.name : "unknown",
        }),
      );
    }
  }

  private async updateIdlePolicy(ownerId: string): Promise<void> {
    const host = this.host(ownerId);
    if (!host?.box_id) return;
    const count = this.ctx.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM active_runs")
      .one().count;
    if (count > 0) {
      this.ctx.storage.sql.exec("UPDATE host SET idle_deadline = NULL WHERE owner_id = ?", ownerId);
      await this.ctx.storage.setAlarm(Date.now() + POLL_INTERVAL_MS);
      return;
    }
    const deadline = Date.now() + IDLE_PAUSE_MS;
    this.ctx.storage.sql.exec(
      "UPDATE host SET idle_deadline = ? WHERE owner_id = ?",
      deadline,
      ownerId,
    );
    await this.ctx.storage.setAlarm(deadline);
  }
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function githubInstallationToken(
  env: CloudflareBindings,
  installationId: number,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = base64url(
    new TextEncoder().encode(
      JSON.stringify({ iat: now - 60, exp: now + 540, iss: env.GITHUB_APP_ID }),
    ),
  );
  const pem = env.GITHUB_APP_PRIVATE_KEY.replace(
    /-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g,
    "",
  );
  const der = Uint8Array.from(atob(pem), (character) => character.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  const jwt = `${header}.${payload}.${base64url(new Uint8Array(signature))}`;
  const response = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${jwt}`,
        accept: "application/vnd.github+json",
        "user-agent": "watt-cloud-api",
      },
    },
  );
  if (!response.ok) throw new Error("git_auth_required");
  return (await response.json<{ token: string }>()).token;
}
