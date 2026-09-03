# Watt v1 specification

Cursor-native git worktree host. The Node Host registers repositories, creates/list/archives sibling worktrees, runs Cursor or Codex local agents in a worktree `cwd`, streams typed events, and resumes persisted sessions. The product surface is libraries plus the headless CLI. The Svelte 5 + Tauri 2 application is a static distribution shell only. The same Host may run locally or behind the authenticated personal cloud control plane described below.

This file is the source of truth. Packages must match it.

## Goals

- Register a git checkout (**project**), create/list/archive **workspaces** (sibling worktrees), run many **sessions** per workspace.
- MCP / rules / skills load via `settingSources: ["project", "user", "plugins"]` with `cwd` = that worktree.
- Copy selected gitignored files from the source checkout; run a repo-local setup command.
- Listing workspaces reads a **cached snapshot** in sqlite. It must not `git status` (or equivalent) every historical cwd.

## Non-goals (v1)

- Host-connected workspace controls, automatic updates, or desktop platforms other than Apple Silicon macOS. The static Svelte/Tauri shell may package the local Host and display product-shaped mock content, but no workspace operation is connected to UI.
- HTTP, WebSocket, ACP, or any alternate Host backend for the local product surface.
- GitHub stacks (`gh stack`), nested worktrees, unarchive.
- ACP, Debug mode, Ask mode.
- Phone/relay, multi-provider cloud execution, Paseo/Conductor, Transitive-specific D1/Postgres provision.

## Runtime

- Node **22.13+**, TypeScript strict, pnpm workspace, Turbo.
- IDs: ULID. Paths: absolute, `realpath`’d.
- No React or Electron. The desktop frontend is Svelte 5/Vite inside Tauri 2's system webview. `@cursor/sdk` and `@openai/codex-sdk` are isolated to `@watt/agent`. CLI imports `@watt/host` only.
- `git` ↛ `agent` ↛ `git`. Only `host` imports both.
- `desktop-sidecar` imports `host`; the Rust desktop bridge speaks only the bounded sidecar protocol.

## Domain

```ts
type Project = { id: string; repoRoot: string };
type Workspace = {
  id: string;
  projectId: string;
  worktreePath: string;
  branch: string;
  slug: string;
  baseRef: string;
  createdAt: number;
  archivedAt: number | null;
};
type Session = {
  id: string;
  workspaceId: string;
  runtime: "cursor-local" | "codex-local";
  cursorAgentId: string;
  mode: "agent" | "plan";
  model: ModelSelection;
  executionPolicy: ExecutionPolicy;
  createdAt: number;
};

type ModelSelection = {
  id: string;
  params: Array<{ id: string; value: string }>;
};

type ExecutionPolicy = {
  autoReview: boolean;
  sandbox: { enabled: boolean };
  agentRetries: boolean;
  toolAllowlist: string[] | null;
  toolDenylist: string[];
  settingSources: Array<"project" | "user" | "plugins">;
};
```

- **Project:** main checkout, not a watt worktree.
- **Workspace:** one sibling worktree, one branch.
- **Session:** mapping to one persisted local-runtime conversation. `cursorAgentId` is the provider-thread identifier retained for schema compatibility; `runtime` determines whether Cursor or Codex owns it. Watt sqlite stores the mapping, selection, policy, and run state.

## Package APIs

### `@watt/git`

Mutations are serialized per canonical Git common directory both within one Node process and across CLI processes. Every git spawn has a timeout. Concurrent git processes are capped (default 4).

```ts
createGit(options?: {
  timeoutMs?: number;
  leaseTimeoutMs?: number; // default 5000
  concurrency?: number;
  spawn?: GitSpawn;
}): GitService;

interface GitService {
  createWorktree(input: CreateWorktreeInput): Promise<CreatedWorktree>;
  inspectRepository(repoRoot: string): Promise<RepositorySnapshot>;
  listWorktrees(repoRoot: string): Promise<GitWorktree[]>;
  archiveWorktree(input: ArchiveWorktreeInput): Promise<void>;
  advanceWorkspaceOperation(input: WorkspaceOperationStepInput): Promise<WorkspaceOperationStepResult>;
}

type GitWorktree = {
  path: string; // canonical, including canonical existing prefix when missing
  pathExists: boolean;
  head: string;
  branch: string | null;
  detached: boolean;
  bare: boolean;
  locked: string | null;
  prunable: string | null;
};

type RepositorySnapshot = {
  repositoryIdentity: string; // real path of the Git common directory
  repoRoot: string;
  inspectedAt: number;
  worktrees: GitWorktree[];
};

type CreateWorktreeInput = {
  repoRoot: string;
  worktreePath: string;
  slug: string;
  branch: string;
  baseRef: string;
  copyGlobs?: string[];
};

type ArchiveWorktreeInput = {
  repoRoot: string;
  worktreePath: string;
  branch: string;
  keepBranch?: boolean; // default true
};
```

`createWorktree`:

1. Refuse nested worktree paths (inside `repoRoot`) and invalid or option-like git refs.
2. `git worktree add -b <branch> <worktreePath> <baseRef>` (fails if branch exists).
3. Copy files from `repoRoot` matching copy globs (dotfiles included; gitignore is not applied). Globs and matched paths must stay inside `repoRoot`.
4. Run setup in the new worktree with `ROOT_WORKTREE_PATH` = source `repoRoot`.
5. If copy or setup fails, remove the worktree and delete the new branch.

Invalid `watt.json` / `.cursor/worktrees.json` fails closed (`config_invalid`).

Config, first match:

1. `watt.json` at `repoRoot`: strict `{ "copy"?: string[], "setup"?: string | string[] }`; unknown keys, wrong types, empty setup commands, and non-string array members fail `config_invalid`. `copyGlobs` on the call is concatenated after `copy`.
2. Else `.cursor/worktrees.json` accepts unrelated keys and uses `setup-worktree-unix` (Unix) when present, otherwise `setup-worktree`; the selected value is fully validated as a command array or a non-empty relative script path contained within `.cursor/`. Copy globs only come from the call / `watt.json`.
3. Else no setup.

Archive is idempotent: missing worktrees are a no-op. It **keeps the branch** unless `keepBranch: false`. No unarchive in v1.

Durable Host mutations use `advanceWorkspaceOperation` for phase-aware create, removal, branch-outcome, and safe create-compensation steps. The Git common directory stores a versioned operation marker containing the operation ID, repository identity, canonical path, branch, expected commit, operation type, and completed Git phase. Each step inspects and mutates under the repository lease. Recovery returns `needs_attention` instead of mutating when marker identity, worktree/path state, or the branch's expected commit does not agree. Branch deletion is an expected-OID compare-and-delete.

Mutation leases live under the canonical Git common directory and contain an atomically published owner ID, operation, PID, hostname, process-start fingerprint, repository identity, and acquisition time. Acquisition is bounded and fails with `repo_busy` plus owner details. A lease is reclaimed only when a same-host PID/start fingerprint definitively proves that its owner exited; live, foreign-host, malformed, and unverifiable owners are never expired by age. Release and reclamation verify the exact lease ID before removal.

`inspectRepository` uses `git worktree list --porcelain` exactly once and returns a canonical snapshot without taking the mutation lease. `listWorktrees` delegates to inspection and returns its worktrees. Neither operation runs `git status` per path.

### `@watt/agent`

Both provider adapters implement the same injected `CursorRuntime` boundary so the default suite uses deterministic fakes and no network.

```ts
createAgent(options: { runtime: CursorRuntime; apiKey?: string }): WattAgent;

interface WattAgent {
  listModels(): Promise<ModelCapability[]>;
  create(input: CreateAgentInput): Promise<WattSessionHandle>;
  resume(input: ResumeAgentInput): Promise<WattSessionHandle>;
  getRun(input: { cursorRunId: string; cwd: string }): Promise<WattRun>;
}

interface WattSessionHandle {
  cursorAgentId: string;
  send(prompt: string, options?: { idempotencyKey?: string }): Promise<WattRun>;
}

interface WattRun {
  cursorRunId: string;
  stream(options?: { signal?: AbortSignal }): AsyncIterable<AgentEvent>;
  wait(): Promise<{
    status: "finished" | "error" | "cancelled";
    result?: string;
    error?: { message: string; code?: string };
    durationMs?: number;
  }>;
  cancel(): Promise<void>;
}

type AgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; callId: string; name: string; args: unknown }
  | { type: "tool_result"; callId: string; name: string; result: unknown; ok: boolean }
  | { type: "status"; status: string; message?: string }
  | { type: "error"; message: string };
```

- Structured model selections contain a model ID and selected parameter values. Cursor discovers its catalog with `Cursor.models.list()`; Codex exposes Watt's pinned, namespaced local catalog.
- Cursor supports `agent` and `plan`; Codex supports `agent`. The selected runtime, model, mode, and effective execution policy are persisted and re-applied on every follow-up.
- Default execution policy is full-access/no-prompt: Auto-review off, sandbox off, agent retries on, unrestricted tools, empty denylist, and `settingSources: ["project", "user", "plugins"]`.
- Persist and reapply the complete effective execution policy on every resume. Tool denylist wins over allowlist.
- Built-in custom tool `watt_workspace_info` (no secrets). Re-pass `customTools` (builtin + caller) on **resume**.
- Custom tools preserve JSON values, text/image content, `structuredContent`, explicit `isError`, declared `outputSchema`, and tool-call context. Custom tools are trusted construction-time callbacks only.
- Map SDK stream messages → `AgentEvent` with exhaustive `never` on `AgentEvent`. Unknown SDK `type` values are ignored.
- Natural `stream()` completion always `wait()`s the underlying run so watchers are released. Aborting the optional subscriber signal stops local consumption without calling provider cancellation or waiting for terminal completion.
- Preserve Cursor run IDs and core terminal results, pass caller idempotency keys through `send`, and reacquire durable local runs through `Agent.getRun(runId, { cwd })`.
- Pin `@cursor/sdk` exactly to `1.0.29`; deliberate upgrades must keep the adapter contract tests passing.
- Never log API keys.

`createSdkRuntime()` wraps `@cursor/sdk` `Agent.create` / `resume` / `getRun` / `send` / `stream` / `wait` / `cancel`. Local only.

`createCodexRuntime()` wraps `@openai/codex-sdk` local threads. It uses the user's existing `codex login` ChatGPT authentication, maps Codex events into `AgentEvent`, and never accepts or logs an API key. Authentication failure is reported as `codex_auth_unavailable`. Codex thread IDs are persisted for follow-ups. The current SDK cannot reacquire an in-flight turn after the Watt process itself has died; that boundary fails explicitly as `run_recovery_failed` rather than inventing completion.

### `@watt/host`

Only public surface for a future UI.

```ts
createHost(options: {
  stateDir: string;
  worktreeRoot: string;
  leaseTimeoutMs?: number; // default 5000
  apiKey?: string;
  git?: GitService;
  agent?: WattAgent;
  codexAgent?: WattAgent;
  executionPolicy?: ExecutionPolicyInput;
  customTools?: CustomTool[];
}): Host;

type RunStatus = "queued" | "running" | "finished" | "error" | "cancelled";
type Run = {
  id: string;
  sessionId: string;
  status: RunStatus;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
};
type RunResult = {
  runId: string;
  status: "finished" | "error" | "cancelled";
  result?: string;
  error?: { message: string; code?: string };
  durationMs?: number;
};
type HostEvent = AgentEvent & {
  workspaceId: string;
  sessionId: string;
  runId: string;
  sequence: number;
};
```

`host.capabilities()` returns separate `cursor-local` and `codex-local` runtime capabilities, their supported modes and structured model catalogs, supported execution-policy controls/defaults, and model-catalog state (`live`, `cached`, or `unavailable`). Successful non-empty catalogs are cached per runtime in sqlite. Discovery failure uses the last-known-good cache; without one, capabilities are degraded and new sessions/follow-ups fail `model_catalog_unavailable` before dispatch.

Model IDs and aliases are canonicalized against the selected runtime's catalog. Duplicate/unknown parameters and unsupported values fail before provider dispatch. Cursor prefers `composer-2.5` when available; Codex prefers the catalog's marked default. Otherwise the first catalog entry and its default variant are used. A successful live catalog is authoritative for new sessions and follow-ups; already-running durable runs remain governed by their persisted runtime mapping.

sqlite file: `{stateDir}/watt.sqlite`.

Only one live Host process may own a canonical `stateDir`. Acquisition is bounded and fails with `host_busy` while a live or unverifiable owner holds it. A same-host lease is reclaimed only when its PID/start fingerprint definitively proves that process exited. Closing or suspending the Host releases the lease.

- `projects.register(repoRoot)` / `projects.get` / `projects.list` / `projects.reconcile({ projectId })`
- `workspaces.create({ projectId, slug, branch?, baseRef? })` / `list({ projectId })` / `get` / `archive({ workspaceId, keepBranch? })`
- `sessions.create({ workspaceId, runtime?, model?, mode?, executionPolicy?, prompt })` / `send({ sessionId, prompt })` return `{ session, run }`; `get` / `list({ workspaceId })` remain SQLite-backed. New sessions default to `cursor-local`. Follow-ups inherit the persisted runtime and cannot switch providers.
- `runs.get` / `list({ sessionId })` / `wait({ runId })` / `cancel({ runId })` / `attach({ runId, afterSequence? })`
- `diagnostics.operations.get({ operationId })` / `list({ projectId?, workspaceId?, includeCompleted? })`

`workspaces.list` reads sqlite only (cached rows). Git is used on create/archive, not on list.

`projects.reconcile` is an explicit, read-only comparison of active SQLite workspaces against one repository snapshot. It returns the project, nullable repository identity, inspection time, and a discriminated entry list: `healthy`, `missing`, `branch_mismatch`, `untracked_worktree`, `repository_unavailable`, or `ambiguous`. Ambiguity reasons distinguish a branch found at another path, duplicate canonical paths, a persisted path outside the snapshot, and unsupported bare worktrees. Entries include the persisted workspace and/or Git candidates needed for diagnosis. Archived rows are ignored. Reconciliation never writes SQLite, mutates Git, adopts a worktree, archives a row, or deletes anything.

Slug: `^[a-z0-9][a-z0-9._-]{0,62}$` (no `..`, no `/`). Worktree path must stay under `worktreeRoot` and outside the source repo. Create compensates after ordinary failures only when its operation provenance still agrees. Archive records its requested branch policy before removing the worktree.

Every workspace create/archive receives a ULID before its first side effect and is persisted in the versioned operation journal. Create phases are `intent_recorded`, `git_worktree_created`, `path_verified`, `workspace_row_committed`, and `operation_completed`. Archive phases are `intent_recorded`, `active_runs_handled`, `git_worktree_removed`, `branch_outcome_recorded`, and `workspace_archived`. Workspace insertion/archive and their corresponding phase transitions are single SQLite transactions.

After acquiring the exclusive Host state lease, startup replays incomplete and `needs_attention` operations before scheduling the general run queue. Git continuation runs under the repository lease. Exact identity matches may finish the requested mutation; missing/malformed provenance, duplicate or moved paths, bare/mismatched worktrees, changed branches, unavailable repositories, and conflicting SQLite rows remain `needs_attention`. Startup continues and exposes safe diagnostics. Recovery never deletes an uncertain worktree or branch and is idempotent across repeated crashes.

Default worktree path: `{worktreeRoot}/{slug}`. Default branch: `watt/{slug}`. Default `baseRef`: `HEAD`.

sqlite uses WAL, `foreign_keys=ON`, `busy_timeout=5000`, and unique indexes on active `(project_id, slug)` and active `worktree_path`.

Each send immediately persists a Watt ULID and queued prompt. Runs execute FIFO per session while different sessions may execute concurrently. The prompt is cleared after the private provider run ID is durable. Watt passes its run ULID as the provider idempotency key.

`runs.attach` replays persisted events after the exclusive sequence cursor, tails live events, and completes when the run is terminal. It accepts an optional internal `AbortSignal` so a transport subscriber can detach and remove its waiter without cancelling the run. The host consumes and persists streams even with no attached caller.

After process restart, queued runs resume automatically. Running rows ask their persisted runtime to reacquire the local run by ID; a dispatching row without a committed provider ID safely retries with the same idempotency key. A runtime that cannot reacquire must fail explicitly. Core terminal results are persisted in Watt sqlite.

Queued cancellation never dispatches. Running cancellation delegates to its persisted runtime and waits for the terminal result. Workspace archive cancels and settles its runs before git removal. `host.close()` is asynchronous and idempotent: it rejects new work, cancels active runs, retains queued runs, ends attachments, then closes sqlite. `host.suspend()` is also asynchronous and idempotent: it rejects new work, detaches recoverable Cursor stream consumers without provider cancellation, cancels and settles active non-recoverable Codex turns, retains the remaining active and queued run state for recovery, ends attachments, closes sqlite, and releases the state lease. The first shutdown disposition wins.

### `@watt/desktop-sidecar` and Rust bridge

The desktop boundary is a headless child process over stdin/stdout. It exposes the complete Host surface (capabilities, Projects, Workspaces, Sessions, Runs, workspace-operation diagnostics, close, and suspend) without adding another backend.

- Protocol v1 uses 4-byte big-endian length-prefixed UTF-8 JSON. The canonical Draft 2020-12 schema is `packages/desktop-sidecar/protocol.schema.json` and is loaded by both TypeScript and Rust; shared fixtures must produce the same validity result in both runtimes.
- Startup begins with `hello` containing a supported version range, capabilities, and Host paths. No Host lease is acquired before a compatible version is selected. Incompatibility returns `protocol_version_unsupported` with supported versions/capabilities and exits cleanly.
- Requests carry a caller-generated ULID and may complete out of order. At most 64 requests and 64 run subscriptions are active at once. `get` operations return `null` when absent.
- `runs.attach` carries a distinct subscription ULID. Its acknowledgement is written before events; persisted event sequences are strictly increasing; natural completion emits exactly one `stream_end` with the persisted `RunResult`. `runs.unsubscribe` stops only forwarding and acknowledges only after its `stream_end`; `runs.cancel` remains Host cancellation.
- Frames are at most 1 MiB, request/result/event payloads at most 768 KiB, and JSON nesting at most 64. Oversized outbound values fail `payload_too_large`; malformed framing, UTF-8, JSON, or envelopes terminate the connection without crashing the process.
- The TypeScript outbound writer is bounded to 256 frames and 8 MiB and honors writable `drain`. The Rust writer is bounded to 64 frames and 8 MiB. Each Rust run consumer is bounded to 64 events and 2 MiB; overflow unsubscribes it with `consumer_too_slow` while the Host run continues.
- Known Watt error codes and safe details cross unchanged. Unknown exceptions become `internal_error`; causes and stacks never cross the boundary. Disconnect fails pending requests with `sidecar_disconnected`, terminates local subscriptions once, and closes the Host. `host.suspend` is an explicit typed method that terminates subscriptions, preserves active provider work, releases the Host lease, and then closes the transport.

### Desktop packaging shell

The `apps/desktop` Svelte 5 + Tauri 2 application is named Watt with identifier `com.handlemotion.watt`. It is a supporting distribution artifact, not part of the v1 operational product surface, and exposes no Host-connected workspace controls.

- Svelte/Vite renders the current static shell in Tauri's system webview. Its workspace, session, and run content is mock presentation only. It does not call the Host, invoke shell commands, or implement workspace operations.
- The typed Rust bridge remains the only allowed future UI-to-Host boundary. The frontend must not import Watt Node packages or introduce another transport.
- `@yao-pkg/pkg` packages the Node Host as `watt-desktop-sidecar-aarch64-apple-darwin`; the application bundle installs it beside the Tauri executable as `watt-desktop-sidecar`. Its version is pinned and its executable must complete the real protocol handshake in temporary directories before packaging.
- The installed app stores Host state under its macOS application-data directory and worktrees in that directory's `worktrees` child. Closing requests `host.close()`, waits for a bounded graceful exit, then forcibly terminates a stuck child.
- Changesets is the only versioning entry point. Shipping changes add a changeset; the Version Packages workflow updates package and Rust versions together. The synchronized desktop version must equal a stable `vMAJOR.MINOR.PATCH` release tag before packaging.
- The first distribution is an Apple Silicon DMG signed with Developer ID Application credentials, notarized and stapled by Apple, attested by GitHub, and attached to the exact existing Git tag's GitHub Release. Manual DMG upgrades are the only update path in v1.
- The protected release job obtains Apple credentials from a read-only Infisical machine identity using GitHub OIDC. Apple credentials are never stored in or synchronized to GitHub Secrets, and they are requested only after source validation succeeds.
- Node, Desktop, and Version Packages dependency installs require the repository `CENTRAL_LICENSE_KEY` secret for the licensed Svelte icon package. Each job must fail before install with a named missing-secret error and must never print the value.
- HTTP and SSE are allowed only in the cloud API and cloud daemon. WebSocket, updater, direct frontend process control outside the typed Rust bridge, and Host-connected workspace product UI remain forbidden.

## Personal cloud chats

The optional cloud path keeps the local Host contract intact. `apps/cloud` is a Cloudflare Worker using Hono. It authenticates a single allowlisted GitHub owner, stores auth and routing metadata in PlanetScale Postgres through Hyperdrive, and coordinates exactly one persistent Upstash Box per owner with a SQLite-backed `CloudHostCoordinator` Durable Object. Upstash Box is the only cloud runtime.

Inside the box, `@watt/cloud-daemon` runs unprivileged and wraps `@watt/host`. Each cloud chat owns one project clone, Watt workspace, `watt/cloud/<chat-id>` branch, session, and Cursor local agent. The cloud API reports `executionLocation: "cloud"`; the agent runtime remains `cursor-local`. Watt SQLite in the box is authoritative for projects, workspaces, sessions, runs, and sequenced events. PlanetScale stores Better Auth tables plus GitHub installations, cloud hosts, repositories, cloud chats, changesets, and idempotency records.

The Worker and daemon use authenticated JSON requests. Run attachment is replayable SSE and accepts `Last-Event-ID` or `afterSequence`; bodies are streamed without buffering. Chat create/send and changeset pull/resolve require `Idempotency-Key`. One owner coordinator serializes provision, wake, mutation replay, active-run accounting, and idle pause changes. It heartbeats the box while any run is active, persists an eight-minute idle deadline after the final run becomes terminal, and pauses the box at that deadline. The coordinator is not a second chat database.

GitHub login and selected-repository access use one GitHub App with metadata read and contents read/write only. Better Auth exposes OAuth Provider for the public native client `watt-desktop`, using authorization code + PKCE, a localhost callback, short-lived access tokens, and refresh tokens intended for macOS Keychain. Authorization must compare the authenticated immutable GitHub owner ID with the configured allowlist.

A cloud chat starts from a GitHub ref or exact clean local HEAD. Local Watt may publish an unpushed clean commit to `watt/seed/<id>` and removes the seed only after the cloud branch exists. Dirty local worktrees fail `local_workspace_dirty`. After a mutating cloud run, no file changes produce `no_changes`; a dirty worktree or no branch advance produces `needs_commit` and is not pushed; a valid clean advance is pushed automatically and recorded as `published`.

Changeset states are `no_changes`, `needs_commit`, `published`, `conflicted`, `resolving`, `applied`, and `needs_attention`. Pull requires the exact expected SHAs and a clean, idle local workspace. Conflict preflight leaves the workspace untouched and returns `conflicted`. Resolve applies the conflict and starts a resolver session in that same workspace, preferring `composer-2.5` and otherwise using the workspace model. Active local agents fail `workspace_busy`; the SDK has no safe pause or in-run steering operation. Cloud branches remain until chat archival.

Upstash, Cursor, Better Auth, and GitHub App credentials remain Worker secrets. Box files and PlanetScale must not store them. A root-owned, narrow Git broker injects GitHub credentials only into clone/fetch/push child processes. Bootstrap secrets are removed from the daemon environment before any agent is created. Logs redact prompts, repository credentials, OAuth tokens, and provider secrets.

### `@watt/cli`

Imports `@watt/host` only.

```
watt [global options] capabilities
watt [global options] project ls
watt [global options] project reconcile --project <id>
watt [global options] operation get --operation <id>
watt [global options] operation ls [--project <id>] [--workspace <id>] [--include-completed]
watt --repo <path> [global options] worktree create --slug <slug> [--branch <b>] [--base <ref>]
watt --repo <path> [global options] worktree ls
watt [global options] worktree archive --workspace <id>
watt [global options] agent ls --workspace <id>
watt [global options] agent send --workspace <id> -p "<prompt>" [--runtime <cursor|chatgpt>] [--model <id>] [--model-param <id=value>...] [--mode <agent|plan>] [--detach]
watt [global options] agent send --session <id> -p "<follow-up>" [--detach]
watt [global options] run get --run <id>
watt [global options] run ls --session <id>
watt [global options] run attach --run <id> [--after-sequence <n>]
watt [global options] run wait --run <id>
watt [global options] run cancel --run <id>
```

`agent send` creates a new session with `--workspace` or sends a follow-up with `--session`; exactly one is required. `--runtime cursor|chatgpt` is accepted only for new sessions and maps to `cursor-local|codex-local`; follow-ups inherit the persisted runtime. Attached sends and `run attach` write one JSONL `HostEvent` per line followed by the terminal `RunResult`. For Cursor sessions, `--detach` waits until provider dispatch is durably recorded, writes `{ sessionId, runId }`, and suspends the Host without cancellation. Codex sends reject `--detach` before enqueueing because the current SDK cannot reacquire an in-flight run after CLI process exit. All ordinary CLI teardown uses `host.suspend()`; `run cancel` remains explicit cancellation.

Default `--state-dir`: `~/.watt`. Default `--worktree-root`: parent of `--repo` (or `{stateDir}/worktrees` when `--repo` is omitted). `--repo` is required for `worktree create|ls`. `worktree archive` and `agent send` can use `--state-dir` alone.

## Persistence

| Table              | Columns                                                                                                                                                                             |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `projects`         | `id`, `repo_root` (unique), `created_at`                                                                                                                                            |
| `workspaces`       | `id`, `project_id`, `worktree_path`, `branch`, `slug`, `base_ref`, `created_at`, `archived_at`                                                                                      |
| `sessions`         | `id`, `workspace_id`, `runtime`, `cursor_agent_id` (provider thread ID), `mode`, `model`, model parameters JSON, effective execution-policy JSON, `created_at`                      |
| `runs`             | `id`, `session_id`, private `cursor_run_id`, internal status, transient prompt, timestamps, terminal result fields                                                                  |
| `run_events`       | `run_id`, monotonic `sequence`, serialized `HostEvent`, `created_at`; `(run_id, sequence)` is unique                                                                                |
| `operations`       | schema version, operation/project/workspace identity, requested JSON, phase, timestamps/recovery attempts, terminal and compensation outcomes, branch outcome, safe diagnostic JSON |
| `capability_cache` | runtime-keyed model-catalog JSON and successful fetch time                                                                                                                          |

## Tests (default `pnpm test`)

- `@watt/git`: temp repositories/worktrees, copy gitignored `.env`, archive keeps branch, branch uniqueness, bounded Git commands, canonical inspection, operation provenance, expected-OID branch protection, ambiguity safety, and separate-process lease serialization/recovery.
- `@watt/agent`: mocked Cursor and Codex runtime boundaries only.
- `@watt/host`: fake/real git + fake agents; migrations, operation diagnostics, phase-boundary startup recovery, ambiguity safety, cached listing, non-destructive reconciliation drift fixtures, FIFO sends, replay/tail attachment, cancellation, results, archive ordering, graceful close, and suspend/recovery for both runtime identities.
- Real Cursor and Codex provider acceptance is **not** in the default suite.
- Desktop CI additionally runs Svelte checks/build, Rust formatting, clippy with warnings denied, Rust tests, a packaged arm64 sidecar handshake/shutdown smoke test, an ad-hoc-signed Tauri application build, the packaged Tauri-to-Host lifecycle smoke test, and a real Tauri window startup/shutdown probe.

## Code rules

Strict TypeScript, `unknown` not `any`, exhaustive switches on unions, no ACP/cloud “for later”.
