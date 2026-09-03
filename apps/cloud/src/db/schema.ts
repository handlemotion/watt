import { bigint, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const hostStatus = pgEnum("cloud_host_status", [
  "provisioning",
  "starting",
  "ready",
  "stopped",
  "error",
]);
export const changesetState = pgEnum("changeset_state", [
  "no_changes",
  "needs_commit",
  "published",
  "conflicted",
  "resolving",
  "applied",
  "needs_attention",
]);
const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

export const githubInstallations = pgTable(
  "github_installations",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    installationId: bigint("installation_id", { mode: "number" }).notNull(),
    accountLogin: text("account_login").notNull(),
    ...timestamps,
  },
  (table) => [uniqueIndex("github_installations_owner_unique").on(table.ownerId)],
);
export const cloudHosts = pgTable(
  "cloud_hosts",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    upstashBoxId: text("upstash_box_id"),
    status: hostStatus("status").notNull(),
    daemonUrl: text("daemon_url"),
    lastReadyAt: timestamp("last_ready_at", { withTimezone: true }),
    errorCode: text("error_code"),
    ...timestamps,
  },
  (table) => [uniqueIndex("cloud_hosts_owner_unique").on(table.ownerId)],
);
export const repositories = pgTable(
  "repositories",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    githubRepositoryId: bigint("github_repository_id", {
      mode: "number",
    }).notNull(),
    installationId: bigint("installation_id", { mode: "number" }).notNull(),
    repositoryOwner: text("repository_owner").notNull(),
    name: text("name").notNull(),
    defaultBranch: text("default_branch").notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("repositories_owner_github_unique").on(table.ownerId, table.githubRepositoryId),
  ],
);
export const cloudChats = pgTable(
  "cloud_chats",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    repositoryId: text("repository_id").notNull(),
    title: text("title").notNull(),
    branch: text("branch").notNull(),
    baseRef: text("base_ref").notNull(),
    baseSha: text("base_sha").notNull(),
    workspaceId: text("workspace_id"),
    sessionId: text("session_id"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [uniqueIndex("cloud_chats_owner_branch_unique").on(table.ownerId, table.branch)],
);
export const changesets = pgTable(
  "changesets",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    chatId: text("chat_id").notNull(),
    runId: text("run_id").notNull(),
    state: changesetState("state").notNull(),
    baseSha: text("base_sha").notNull(),
    headSha: text("head_sha"),
    expectedLocalSha: text("expected_local_sha"),
    errorCode: text("error_code"),
    journal: jsonb("journal").notNull().default([]),
    ...timestamps,
  },
  (table) => [uniqueIndex("changesets_run_unique").on(table.runId)],
);
export const idempotencyRecords = pgTable(
  "idempotency_records",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    operation: text("operation").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    responseStatus: bigint("response_status", { mode: "number" }).notNull(),
    responseBody: jsonb("response_body").notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("idempotency_owner_operation_key_unique").on(
      table.ownerId,
      table.operation,
      table.idempotencyKey,
    ),
  ],
);
