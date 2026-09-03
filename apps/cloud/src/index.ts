import { and, eq } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { createLocalJWKSet, jwtVerify, type JWK } from "jose";
import { z } from "zod";

import { createAuth } from "./auth.js";
import { PayloadTooLargeError, readBoundedBody, readBoundedJson } from "./body.js";
import {
  account,
  jwks,
  oauthClient,
  oauthClientResource,
  oauthResource,
} from "./db/auth-schema.js";
import {
  changesets,
  cloudChats,
  cloudHosts,
  githubInstallations,
  idempotencyRecords,
  repositories,
} from "./db/schema.js";
import { createDatabase, type CloudDatabase } from "./database.js";

export { CloudHostCoordinator } from "./coordinator.js";

type Variables = {
  ownerId: string;
  userId: string;
  githubToken: string;
  database: CloudDatabase;
};
type AppEnv = { Bindings: CloudflareBindings; Variables: Variables };
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
const app = new Hono<AppEnv>();
const chatInput = z.object({
  repositoryId: z.string().min(1),
  title: z.string().min(1).max(200),
  baseRef: z.string().min(1).max(300),
  baseSha: z.string().regex(/^[0-9a-f]{40}$/),
  seedRef: z
    .string()
    .regex(/^watt\/seed\/[A-Za-z0-9-]{8,100}$/)
    .optional(),
  prompt: z.string().min(1).max(200_000),
  model: z
    .object({
      id: z.string(),
      params: z.array(z.object({ id: z.string(), value: z.string() })),
    })
    .optional(),
});
const sendInput = z.object({ prompt: z.string().min(1).max(200_000) });

const databaseMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const { client, db } = createDatabase(c.env);
  c.set("database", db);
  try {
    await next();
  } finally {
    await client.end({ timeout: 5 });
  }
};

function coordinator(env: CloudflareBindings, ownerId: string) {
  return env.CLOUD_HOST_COORDINATOR.getByName(ownerId);
}

async function ensureNativeClient(env: CloudflareBindings, db: CloudDatabase): Promise<void> {
  await db
    .insert(oauthClient)
    .values({
      id: "watt-desktop",
      clientId: "watt-desktop",
      name: "Watt desktop",
      clientSecret: null,
      redirectUris: [env.NATIVE_REDIRECT_URI],
      tokenEndpointAuthMethod: "none",
      applicationType: "native",
      grantTypes: ["authorization_code", "refresh_token"],
      responseTypes: ["code"],
      requirePKCE: true,
      scopes: ["openid", "profile", "email", "offline_access"],
      skipConsent: true,
      disabled: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoNothing();
  const resource = `${env.BETTER_AUTH_URL}/v1`;
  await db
    .insert(oauthResource)
    .values({
      id: "watt-cloud-api",
      identifier: resource,
      name: "Watt cloud API",
      allowedScopes: ["openid", "profile", "email", "offline_access"],
      disabled: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoNothing();
  await db
    .insert(oauthClientResource)
    .values({
      id: "watt-desktop-cloud-api",
      clientId: "watt-desktop",
      resourceId: resource,
      createdAt: new Date(),
    })
    .onConflictDoNothing();
}

async function verifyAccessToken(
  env: CloudflareBindings,
  db: CloudDatabase,
  token: string,
): Promise<string | undefined> {
  const rows = await db.select({ publicKey: jwks.publicKey }).from(jwks);
  const keys = rows.flatMap(({ publicKey }) => {
    try {
      return [JSON.parse(publicKey) as JWK];
    } catch {
      return [];
    }
  });
  if (keys.length === 0) return undefined;
  const verified = await jwtVerify(token, createLocalJWKSet({ keys }), {
    issuer: env.BETTER_AUTH_URL,
    audience: `${env.BETTER_AUTH_URL}/v1`,
  });
  return verified.payload.sub;
}

const GITHUB_API_ORIGIN = "https://api.github.com";

function githubHeaders(token: string): HeadersInit {
  return {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "user-agent": "watt-cloud-api",
  };
}

function nextGithubPage(response: Response): URL | undefined {
  const link = response.headers.get("link");
  if (!link) return undefined;
  for (const value of link.split(",")) {
    if (!/\brel\s*=\s*"next"/i.test(value)) continue;
    const target = value.match(/<([^>]+)>/)?.[1];
    if (!target) throw new Error("github_invalid_pagination");
    const next = new URL(target);
    if (next.origin !== GITHUB_API_ORIGIN) throw new Error("github_invalid_pagination");
    return next;
  }
  return undefined;
}

async function githubPages<T>(
  path: string,
  token: string,
  collection: string,
): Promise<{ ok: true; items: T[] } | { ok: false }> {
  let url = new URL(path, GITHUB_API_ORIGIN);
  url.searchParams.set("per_page", "100");
  const items: T[] = [];
  for (;;) {
    const response = await fetch(url, { headers: githubHeaders(token) });
    if (!response.ok) return { ok: false };
    const body = (await response.json()) as Record<string, unknown>;
    const page = body[collection];
    if (!Array.isArray(page)) throw new Error("github_invalid_response");
    items.push(...(page as T[]));
    const next = nextGithubPage(response);
    if (!next) return { ok: true, items };
    url = next;
  }
}

function error(
  code: string,
  message: string,
  status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500 | 502 = 400,
): Response {
  return Response.json({ error: { code, message } }, { status });
}

function causeCode(cause: unknown): string {
  if (cause instanceof PayloadTooLargeError) return "payload_too_large";
  if (cause instanceof Error && /^[a-z][a-z0-9_]{0,127}$/.test(cause.message)) {
    return cause.message;
  }
  return "invalid_request";
}

function errorStatus(code: string): 400 | 409 | 413 {
  if (code === "payload_too_large") return 413;
  if (code === "idempotency_conflict" || code === "mutation_in_progress") return 409;
  return 400;
}

async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function stableUuid(value: string): Promise<string> {
  const hash = (await sha256(value)).slice(0, 32).split("");
  hash[12] = "5";
  hash[16] = ((Number.parseInt(hash[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  const compact = hash.join("");
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

async function daemonJson<T>(
  stub: DurableObjectStub<import("./coordinator.js").CloudHostCoordinator>,
  ownerId: string,
  path: string,
  body: unknown,
): Promise<T> {
  const response = await stub.proxy(
    ownerId,
    path,
    new Request("https://coordinator.invalid", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  const value = await response.json<{
    result?: T;
    error?: { code: string; message: string };
    project?: T;
  }>();
  if (!response.ok || value.error) throw new Error(value.error?.code ?? "daemon_request_failed");
  return (value.result ?? value.project) as T;
}

async function requiredKey(request: Request): Promise<string> {
  const key = request.headers.get("idempotency-key");
  if (!key || key.length < 8 || key.length > 200) throw new Error("idempotency_key_required");
  return key;
}

async function idempotent<T extends JsonValue>(
  env: CloudflareBindings,
  db: CloudDatabase,
  ownerId: string,
  operation: string,
  key: string,
  input: unknown,
  execute: () => Promise<T>,
): Promise<T> {
  const requestHash = await sha256(JSON.stringify(input));
  const existing = (
    await db
      .select()
      .from(idempotencyRecords)
      .where(
        and(
          eq(idempotencyRecords.ownerId, ownerId),
          eq(idempotencyRecords.operation, operation),
          eq(idempotencyRecords.idempotencyKey, key),
        ),
      )
      .limit(1)
  )[0];
  if (existing) {
    if (existing.requestHash !== requestHash) throw new Error("idempotency_conflict");
    return existing.responseBody as T;
  }
  const stub = coordinator(env, ownerId);
  const claim = await stub.beginMutation(operation, key, requestHash);
  if (claim.state === "conflict") throw new Error("idempotency_conflict");
  if (claim.state === "in_progress") throw new Error("mutation_in_progress");
  if (claim.state === "replay") return JSON.parse(claim.responseJson) as T;
  const result = await execute();
  await db
    .insert(idempotencyRecords)
    .values({
      id: crypto.randomUUID(),
      ownerId,
      operation,
      idempotencyKey: key,
      requestHash,
      responseStatus: 200,
      responseBody: result as object,
    })
    .onConflictDoNothing();
  await stub.finishMutation(operation, key, JSON.stringify(result));
  return result;
}

app.get("/health", (c) => c.json({ status: "ready", service: "watt-cloud-api" }));
app.post("/webhooks/github", async (c) => {
  const length = Number(c.req.header("content-length") ?? "0");
  if (!Number.isFinite(length) || length > 1024 * 1024)
    return error("payload_too_large", "webhook body is too large", 413);
  const body = await readBoundedBody(c.req.raw, 1024 * 1024);
  const signature = c.req.header("x-hub-signature-256");
  if (!signature?.startsWith("sha256="))
    return error("invalid_webhook_signature", "webhook signature is invalid", 401);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(c.env.GITHUB_WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const bytes = Uint8Array.from(signature.slice(7).match(/.{1,2}/g) ?? [], (part) =>
    Number.parseInt(part, 16),
  );
  if (!(await crypto.subtle.verify("HMAC", key, bytes, Uint8Array.from(body))))
    return error("invalid_webhook_signature", "webhook signature is invalid", 401);
  return c.json({ accepted: true }, 202);
});
app.use("/api/auth/*", databaseMiddleware);
app.on(["GET", "POST"], "/api/auth/*", async (c) => {
  await ensureNativeClient(c.env, c.var.database);
  return createAuth(c.env, c.var.database).handler(c.req.raw);
});

app.use("/v1/*", databaseMiddleware);
app.use("/v1/*", async (c, next) => {
  const length = Number(c.req.header("content-length") ?? "0");
  if (!Number.isFinite(length) || length > 256 * 1024)
    return c.json(
      {
        error: {
          code: "payload_too_large",
          message: "request body is too large",
        },
      },
      413,
    );
  await next();
});

app.use("/v1/*", async (c, next) => {
  const authorization = c.req.header("authorization");
  if (!authorization?.startsWith("Bearer "))
    return c.json({ error: { code: "unauthorized", message: "authentication required" } }, 401);
  await ensureNativeClient(c.env, c.var.database);
  let userId: string | undefined;
  try {
    userId = await verifyAccessToken(c.env, c.var.database, authorization.slice(7));
  } catch {
    return c.json({ error: { code: "unauthorized", message: "invalid access token" } }, 401);
  }
  if (!userId)
    return c.json({ error: { code: "unauthorized", message: "invalid access token" } }, 401);
  const github = (
    await c.var.database
      .select()
      .from(account)
      .where(and(eq(account.userId, userId), eq(account.providerId, "github")))
      .limit(1)
  )[0];
  if (!github?.accessToken || github.accountId !== c.env.ALLOWED_GITHUB_OWNER_ID)
    return c.json(
      {
        error: { code: "forbidden", message: "GitHub owner is not allowed" },
      },
      403,
    );
  c.set("ownerId", github.accountId);
  c.set("userId", userId);
  c.set("githubToken", github.accessToken);
  const rate = await coordinator(c.env, github.accountId).takeRateLimit("api", 120, 60_000);
  if (!rate.allowed) {
    c.header("retry-after", String(rate.retryAfterSeconds));
    return c.json({ error: { code: "rate_limited", message: "too many requests" } }, 429);
  }
  await next();
});

app.get("/v1/cloud-host", async (c) => {
  const current = await coordinator(c.env, c.var.ownerId).status(c.var.ownerId);
  const status = current.status as "provisioning" | "starting" | "ready" | "stopped" | "error";
  await c.var.database
    .insert(cloudHosts)
    .values({
      id: crypto.randomUUID(),
      ownerId: c.var.ownerId,
      upstashBoxId: null,
      status,
    })
    .onConflictDoUpdate({
      target: cloudHosts.ownerId,
      set: {
        status,
        updatedAt: new Date(),
      },
    });
  return c.json({
    status: current.status,
    activeRuns: current.activeRuns,
    executionLocation: "cloud" as const,
  });
});
app.post("/v1/cloud-host/wake", async (c) => {
  const current = await coordinator(c.env, c.var.ownerId).wake(c.var.ownerId);
  await c.var.database
    .insert(cloudHosts)
    .values({
      id: crypto.randomUUID(),
      ownerId: c.var.ownerId,
      upstashBoxId: null,
      status: current.status,
      lastReadyAt: new Date(),
    })
    .onConflictDoUpdate({
      target: cloudHosts.ownerId,
      set: {
        status: current.status,
        lastReadyAt: new Date(),
        errorCode: null,
        updatedAt: new Date(),
      },
    });
  return c.json({ ...current, executionLocation: "cloud" as const });
});

app.get("/v1/repositories", async (c) =>
  c.json(
    await c.var.database.select().from(repositories).where(eq(repositories.ownerId, c.var.ownerId)),
  ),
);
app.get("/v1/repositories/discover", async (c) => {
  const installations = await githubPages<{
    id: number;
    account: { id: number; login: string };
  }>("/user/installations", c.var.githubToken, "installations");
  if (!installations.ok)
    return error("git_auth_required", "GitHub installation authorization is required", 403);
  const allowed = installations.items.filter((item) => String(item.account.id) === c.var.ownerId);
  const found: unknown[] = [];
  for (const installation of allowed) {
    const repositories = await githubPages<Record<string, unknown>>(
      `/user/installations/${installation.id}/repositories`,
      c.var.githubToken,
      "repositories",
    );
    if (repositories.ok)
      found.push(
        ...repositories.items.map((repository) => ({
          ...repository,
          installationId: installation.id,
        })),
      );
  }
  return c.json(found);
});
app.post("/v1/repositories", async (c) => {
  const body = z
    .object({
      githubRepositoryId: z.number().int().positive(),
      installationId: z.number().int().positive(),
    })
    .parse(await readBoundedJson(c.req.raw, 256 * 1024));
  const githubRepositories = await githubPages<{
    id: number;
    name: string;
    default_branch: string;
    owner: { id: number; login: string };
  }>(`/user/installations/${body.installationId}/repositories`, c.var.githubToken, "repositories");
  if (!githubRepositories.ok)
    return error("git_auth_required", "GitHub installation authorization is required", 403);
  const discovered = githubRepositories.items.find(
    (repository) => repository.id === body.githubRepositoryId,
  );
  if (!discovered || String(discovered.owner.id) !== c.var.ownerId)
    return error("repository_not_found", "repository is not available to the allowed owner", 404);
  const db = c.var.database;
  await db
    .insert(githubInstallations)
    .values({
      id: await stableUuid(`github-installation:${c.var.ownerId}`),
      ownerId: c.var.ownerId,
      installationId: body.installationId,
      accountLogin: discovered.owner.login,
    })
    .onConflictDoUpdate({
      target: githubInstallations.ownerId,
      set: {
        installationId: body.installationId,
        accountLogin: discovered.owner.login,
        updatedAt: new Date(),
      },
    });
  const row = {
    id: await stableUuid(`repository:${c.var.ownerId}:${discovered.id}`),
    ownerId: c.var.ownerId,
    githubRepositoryId: discovered.id,
    installationId: body.installationId,
    repositoryOwner: discovered.owner.login,
    name: discovered.name,
    defaultBranch: discovered.default_branch,
  };
  await db.insert(repositories).values(row).onConflictDoNothing();
  const stored = (
    await db
      .select()
      .from(repositories)
      .where(
        and(
          eq(repositories.ownerId, c.var.ownerId),
          eq(repositories.githubRepositoryId, discovered.id),
        ),
      )
      .limit(1)
  )[0];
  return c.json(stored ?? row, 201);
});

app.get("/v1/chats", async (c) =>
  c.json(
    (
      await c.var.database.select().from(cloudChats).where(eq(cloudChats.ownerId, c.var.ownerId))
    ).map((chat) => ({ ...chat, executionLocation: "cloud" })),
  ),
);
app.get("/v1/chats/:chatId", async (c) => {
  const chat = (
    await c.var.database
      .select()
      .from(cloudChats)
      .where(and(eq(cloudChats.id, c.req.param("chatId")), eq(cloudChats.ownerId, c.var.ownerId)))
      .limit(1)
  )[0];
  return chat
    ? c.json({ ...chat, executionLocation: "cloud" as const })
    : error("not_found", "cloud chat not found", 404);
});
app.post("/v1/chats/:chatId/archive", async (c) => {
  try {
    const key = await requiredKey(c.req.raw);
    const ownerId = c.var.ownerId;
    const chatId = c.req.param("chatId");
    const result = await idempotent(
      c.env,
      c.var.database,
      ownerId,
      "chats.archive",
      key,
      { chatId },
      async () => {
        const db = c.var.database;
        const chat = (
          await db
            .select()
            .from(cloudChats)
            .where(and(eq(cloudChats.id, chatId), eq(cloudChats.ownerId, ownerId)))
            .limit(1)
        )[0];
        if (!chat?.workspaceId) throw new Error("chat_not_ready");
        const repository = (
          await db
            .select()
            .from(repositories)
            .where(eq(repositories.id, chat.repositoryId))
            .limit(1)
        )[0];
        if (!repository) throw new Error("repository_not_found");
        const archivedAt = chat.archivedAt ?? new Date();
        if (!chat.archivedAt) {
          const stub = coordinator(c.env, ownerId);
          const token = await stub.installationToken(repository.installationId);
          await daemonJson(stub, ownerId, "/v1/git/archive", {
            workspaceId: chat.workspaceId,
            branch: chat.branch,
            repositoryUrl: `https://github.com/${repository.repositoryOwner}/${repository.name}.git`,
            token,
            idempotencyKey: key,
          });
          await db
            .update(cloudChats)
            .set({ archivedAt, updatedAt: archivedAt })
            .where(and(eq(cloudChats.id, chatId), eq(cloudChats.ownerId, ownerId)));
        }
        return {
          ...chat,
          createdAt: chat.createdAt.toISOString(),
          updatedAt: archivedAt.toISOString(),
          archivedAt: archivedAt.toISOString(),
          executionLocation: "cloud" as const,
        };
      },
    );
    return c.json(result);
  } catch (cause) {
    const code = causeCode(cause);
    return error(code, "cloud chat archive failed", errorStatus(code));
  }
});
app.post("/v1/chats", async (c) => {
  try {
    const body = chatInput.parse(await readBoundedJson(c.req.raw, 256 * 1024));
    const key = await requiredKey(c.req.raw);
    const ownerId = c.var.ownerId;
    const result = await idempotent(
      c.env,
      c.var.database,
      ownerId,
      "chats.create",
      key,
      body,
      async () => {
        const db = c.var.database;
        const repository = (
          await db
            .select()
            .from(repositories)
            .where(and(eq(repositories.id, body.repositoryId), eq(repositories.ownerId, ownerId)))
            .limit(1)
        )[0];
        if (!repository) throw new Error("repository_not_found");
        const id = await stableUuid(`chat:${ownerId}:${key}`);
        const branch = `watt/cloud/${id}`;
        const slug = `cloud-${id}`;
        const stub = coordinator(c.env, ownerId);
        await stub.wake(ownerId);
        const token = await stub.installationToken(repository.installationId);
        const repositoryUrl = `https://github.com/${repository.repositoryOwner}/${repository.name}.git`;
        const project = await daemonJson<{ id: string }>(stub, ownerId, "/v1/git/connect", {
          repositoryId: String(repository.githubRepositoryId),
          repositoryUrl,
          ref: body.baseRef,
          expectedSha: body.baseSha,
          token,
        });
        const workspace = await daemonJson<{ id: string }>(stub, ownerId, "/v1/host/call", {
          method: "workspaces.create",
          params: {
            projectId: project.id,
            slug,
            branch,
            baseRef: body.baseSha,
            idempotencyKey: key,
          },
        });
        await daemonJson(stub, ownerId, "/v1/git/initialize-branch", {
          workspaceId: workspace.id,
          baseSha: body.baseSha,
          branch,
          repositoryUrl,
          seedRef: body.seedRef,
          token,
        });
        const created = await daemonJson<{
          session: { id: string };
          run: { id: string };
        }>(stub, ownerId, "/v1/host/call", {
          method: "sessions.create",
          params: {
            workspaceId: workspace.id,
            prompt: body.prompt,
            model: body.model,
            idempotencyKey: key,
          },
        });
        const chat = {
          id,
          ownerId,
          repositoryId: repository.id,
          title: body.title,
          branch,
          baseRef: body.baseRef,
          baseSha: body.baseSha,
          workspaceId: workspace.id,
          sessionId: created.session.id,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        await db.insert(cloudChats).values(chat).onConflictDoNothing();
        await db
          .insert(changesets)
          .values({
            id: await stableUuid(`changeset:${created.run.id}`),
            ownerId,
            chatId: id,
            runId: created.run.id,
            state: "needs_attention",
            baseSha: body.baseSha,
            journal: [{ phase: "run_started", at: new Date().toISOString() }],
          })
          .onConflictDoNothing();
        await stub.beginRun(ownerId, created.run.id, {
          installationId: repository.installationId,
          baseSha: body.baseSha,
          branch,
          repositoryUrl,
        });
        return {
          chat: {
            ...chat,
            createdAt: chat.createdAt.toISOString(),
            updatedAt: chat.updatedAt.toISOString(),
            archivedAt: null,
            executionLocation: "cloud" as const,
          },
          run: { ...created, executionLocation: "cloud" as const },
        };
      },
    );
    return c.json(result, 201);
  } catch (cause) {
    const code = causeCode(cause);
    return error(
      code,
      code === "idempotency_key_required"
        ? "Idempotency-Key is required"
        : "cloud chat creation failed",
      errorStatus(code),
    );
  }
});
app.post("/v1/chats/:chatId/messages", async (c) => {
  try {
    const body = sendInput.parse(await readBoundedJson(c.req.raw, 256 * 1024));
    const key = await requiredKey(c.req.raw);
    const ownerId = c.var.ownerId;
    const result = await idempotent(
      c.env,
      c.var.database,
      ownerId,
      "chats.send",
      key,
      { chatId: c.req.param("chatId"), ...body },
      async () => {
        const db = c.var.database;
        const chat = (
          await db
            .select()
            .from(cloudChats)
            .where(and(eq(cloudChats.id, c.req.param("chatId")), eq(cloudChats.ownerId, ownerId)))
            .limit(1)
        )[0];
        if (!chat?.sessionId || chat.archivedAt) throw new Error("chat_not_ready");
        const repository = (
          await db
            .select()
            .from(repositories)
            .where(eq(repositories.id, chat.repositoryId))
            .limit(1)
        )[0];
        if (!repository) throw new Error("repository_not_found");
        const stub = coordinator(c.env, ownerId);
        const sent = await daemonJson<{
          session: { id: string };
          run: { id: string };
        }>(stub, ownerId, "/v1/host/call", {
          method: "sessions.send",
          params: {
            sessionId: chat.sessionId,
            prompt: body.prompt,
            idempotencyKey: key,
          },
        });
        await db
          .insert(changesets)
          .values({
            id: await stableUuid(`changeset:${sent.run.id}`),
            ownerId,
            chatId: chat.id,
            runId: sent.run.id,
            state: "needs_attention",
            baseSha: chat.baseSha,
            journal: [{ phase: "run_started", at: new Date().toISOString() }],
          })
          .onConflictDoNothing();
        await stub.beginRun(ownerId, sent.run.id, {
          installationId: repository.installationId,
          baseSha: chat.baseSha,
          branch: chat.branch,
          repositoryUrl: `https://github.com/${repository.repositoryOwner}/${repository.name}.git`,
        });
        return { ...sent, executionLocation: "cloud" as const };
      },
    );
    return c.json(result);
  } catch (cause) {
    const code = causeCode(cause);
    return error(code, "cloud message failed", errorStatus(code));
  }
});

app.post("/v1/runs/:runId/cancel", async (c) =>
  c.json(
    await daemonJson(coordinator(c.env, c.var.ownerId), c.var.ownerId, "/v1/host/call", {
      method: "runs.cancel",
      params: { runId: c.req.param("runId") },
    }),
  ),
);
app.get("/v1/runs/:runId/events", async (c) => {
  const after = c.req.query("afterSequence") ?? c.req.header("last-event-id") ?? "0";
  const response = await coordinator(c.env, c.var.ownerId).proxy(
    c.var.ownerId,
    `/v1/runs/${encodeURIComponent(c.req.param("runId"))}/events?afterSequence=${encodeURIComponent(after)}`,
    c.req.raw,
  );
  return new Response(response.body, response);
});
app.get("/v1/chats/:chatId/changesets", async (c) =>
  c.json(
    await c.var.database
      .select()
      .from(changesets)
      .where(
        and(eq(changesets.chatId, c.req.param("chatId")), eq(changesets.ownerId, c.var.ownerId)),
      ),
  ),
);
app.get("/v1/changesets/:id", async (c) => {
  const row = (
    await c.var.database
      .select()
      .from(changesets)
      .where(and(eq(changesets.id, c.req.param("id")), eq(changesets.ownerId, c.var.ownerId)))
      .limit(1)
  )[0];
  return row ? c.json(row) : error("not_found", "changeset not found", 404);
});
app.post("/v1/changesets/:id/transitions", async (c) => {
  try {
    const body = z
      .object({
        state: z.enum(["conflicted", "resolving", "applied", "needs_attention"]),
        expectedLocalSha: z
          .string()
          .regex(/^[0-9a-f]{40}$/)
          .optional(),
        headSha: z
          .string()
          .regex(/^[0-9a-f]{40}$/)
          .optional(),
        errorCode: z.string().max(128).optional(),
      })
      .parse(await readBoundedJson(c.req.raw, 256 * 1024));
    const key = await requiredKey(c.req.raw);
    const ownerId = c.var.ownerId;
    const changesetId = c.req.param("id");
    const result = await idempotent(
      c.env,
      c.var.database,
      ownerId,
      "changesets.transition",
      key,
      { changesetId, ...body },
      async () => {
        const db = c.var.database;
        const existing = (
          await db
            .select()
            .from(changesets)
            .where(and(eq(changesets.id, changesetId), eq(changesets.ownerId, ownerId)))
            .limit(1)
        )[0];
        if (!existing) throw new Error("changeset_not_found");
        const updatedAt = new Date();
        const journal: JsonValue[] = Array.isArray(existing.journal)
          ? (existing.journal as JsonValue[])
          : [];
        const updatedJournal: JsonValue[] = [
          ...journal,
          {
            phase: "local_transition",
            state: body.state,
            at: updatedAt.toISOString(),
          },
        ];
        await db
          .update(changesets)
          .set({
            state: body.state,
            expectedLocalSha: body.expectedLocalSha ?? existing.expectedLocalSha,
            headSha: body.headSha ?? existing.headSha,
            errorCode: body.errorCode ?? null,
            journal: updatedJournal,
            updatedAt,
          })
          .where(and(eq(changesets.id, changesetId), eq(changesets.ownerId, ownerId)));
        return {
          ...existing,
          state: body.state,
          expectedLocalSha: body.expectedLocalSha ?? existing.expectedLocalSha,
          headSha: body.headSha ?? existing.headSha,
          errorCode: body.errorCode ?? null,
          journal: updatedJournal,
          createdAt: existing.createdAt.toISOString(),
          updatedAt: updatedAt.toISOString(),
        };
      },
    );
    return Response.json(result);
  } catch (cause) {
    const code = causeCode(cause);
    return error(code, "changeset transition failed", errorStatus(code));
  }
});

app.onError((cause, c) => {
  if (cause instanceof PayloadTooLargeError) {
    return c.json(
      {
        error: {
          code: "payload_too_large",
          message: "request body is too large",
        },
      },
      413,
    );
  }
  console.error(
    JSON.stringify({
      message: "request failed",
      path: c.req.path,
      error: cause instanceof Error ? cause.name : "unknown",
    }),
  );
  return c.json({ error: { code: "internal_error", message: "internal cloud API error" } }, 500);
});

export default app;
