# Watt v0 specification

Cursor-native git worktree host. Long-lived Node process: register a repo, create/list/archive sibling worktrees, run Cursor local agents on a worktree `cwd`, stream typed events, resume sessions after process restart.

This file is the source of truth. Packages must match it.

## Goals

- Register a git checkout (**project**), create/list/archive **workspaces** (sibling worktrees), run many **sessions** per workspace.
- MCP / rules / skills load via `settingSources: ["project", "user", "plugins"]` with `cwd` = that worktree.
- Copy selected gitignored files from the source checkout; run a repo-local setup command.
- Listing workspaces reads a **cached snapshot** in sqlite. It must not `git status` (or equivalent) every historical cwd.

## Non-goals (v0)

- Product workspace UI, Electron, automatic updates, or desktop platforms other than Apple Silicon macOS. v0's product surface remains libraries + CLI; its minimal Tauri 2 executable is distribution infrastructure allowed only to package the local Host and prove its lifecycle.
- HTTP, WebSocket, ACP, or any alternate Host backend.
- GitHub stacks (`gh stack`), nested worktrees, unarchive.
- Cloud agents, ACP, Debug mode, Ask mode.
- Phone/relay, multi-provider, Paseo/Conductor, Transitive-specific D1/Postgres provision.

## Runtime

- Node **22.13+**, TypeScript strict, pnpm workspace, Turbo.
- IDs: ULID. Paths: absolute, `realpath`’d.
- No React or product UI packages. The desktop shell is static HTML/CSS/JavaScript and may display only local Host readiness or a safe startup error. `@cursor/sdk` only in `@watt/agent`. CLI imports `@watt/host` only.
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
- **Session:** mapping to a Cursor local agent. Conversation lives in Cursor `LocalAgentStore`; watt sqlite stores the mapping.

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

Archive is idempotent: missing worktrees are a no-op. It **keeps the branch** unless `keepBranch: false`. No unarchive in v0.

Durable Host mutations use `advanceWorkspaceOperation` for phase-aware create, removal, branch-outcome, and safe create-compensation steps. The Git common directory stores a versioned operation marker containing the operation ID, repository identity, canonical path, branch, expected commit, operation type, and completed Git phase. Each step inspects and mutates under the repository lease. Recovery returns `needs_attention` instead of mutating when marker identity, worktree/path state, or the branch's expected commit does not agree. Branch deletion is an expected-OID compare-and-delete.

Mutation leases live under the canonical Git common directory and contain an atomically published owner ID, operation, PID, hostname, process-start fingerprint, repository identity, and acquisition time. Acquisition is bounded and fails with `repo_busy` plus owner details. A lease is reclaimed only when a same-host PID/start fingerprint definitively proves that its owner exited; live, foreign-host, malformed, and unverifiable owners are never expired by age. Release and reclamation verify the exact lease ID before removal.

`inspectRepository` uses `git worktree list --porcelain` exactly once and returns a canonical snapshot without taking the mutation lease. `listWorktrees` delegates to inspection and returns its worktrees. Neither operation runs `git status` per path.

### `@watt/agent`

Inject `CursorRuntime` so tests mock the SDK (default `pnpm test` has no network).

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
  stream(): AsyncIterable<AgentEvent>;
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

- Structured model selections contain a model ID and selected parameter values. The runtime catalog is discovered with `Cursor.models.list()`.
- Modes are explicitly `agent` or `plan` and are re-passed on every follow-up.
- Default execution policy is full-access/no-prompt: Auto-review off, sandbox off, agent retries on, unrestricted tools, empty denylist, and `settingSources: ["project", "user", "plugins"]`.
- Persist and reapply the complete effective execution policy on every resume. Tool denylist wins over allowlist.
- Built-in custom tool `watt_workspace_info` (no secrets). Re-pass `customTools` (builtin + caller) on **resume**.
- Custom tools preserve JSON values, text/image content, `structuredContent`, explicit `isError`, declared `outputSchema`, and tool-call context. Custom tools are trusted construction-time callbacks only.
- Map SDK stream messages → `AgentEvent` with exhaustive `never` on `AgentEvent`. Unknown SDK `type` values are ignored.
- `stream()` always `wait()`s the underlying run when the iterator completes, so watchers are released.
- Preserve Cursor run IDs and core terminal results, pass caller idempotency keys through `send`, and reacquire durable local runs through `Agent.getRun(runId, { cwd })`.
- Pin `@cursor/sdk` exactly to `1.0.29`; deliberate upgrades must keep the adapter contract tests passing.
- Never log API keys.

`createSdkRuntime()` wraps `@cursor/sdk` `Agent.create` / `resume` / `getRun` / `send` / `stream` / `wait` / `cancel`. Local only.

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

`host.capabilities()` returns the local Cursor runtime, `agent` / `plan` modes, the discovered structured model catalog, supported execution-policy controls/defaults, and model-catalog state (`live`, `cached`, or `unavailable`). Successful non-empty catalogs are cached in sqlite. Discovery failure uses the last-known-good cache; without one, capabilities are degraded and new sessions/follow-ups fail `model_catalog_unavailable` before dispatch.

Model IDs and aliases are canonicalized against the catalog. Duplicate/unknown parameters and unsupported values fail before a Cursor run begins. An omitted model prefers `composer-2.5`, otherwise the first catalog entry, using a catalog variant marked default when present. A successful live catalog is authoritative: a removed model/parameter blocks new follow-ups, while already-running durable runs remain recoverable by Cursor run ID.

sqlite file: `{stateDir}/watt.sqlite`.

Only one live Host process may own a canonical `stateDir`. Acquisition is bounded and fails with `host_busy` while a live or unverifiable owner holds it. A same-host lease is reclaimed only when its PID/start fingerprint definitively proves that process exited. Closing the Host releases the lease.

- `projects.register(repoRoot)` / `projects.get` / `projects.list` / `projects.reconcile({ projectId })`
- `workspaces.create({ projectId, slug, branch?, baseRef? })` / `list({ projectId })` / `get` / `archive({ workspaceId, keepBranch? })`
- `sessions.create({ workspaceId, model?, mode?, executionPolicy?, prompt })` / `send({ sessionId, prompt })` return `{ session, run }`; `get` / `list({ workspaceId })` remain SQLite-backed.
- `runs.get` / `list({ sessionId })` / `wait({ runId })` / `cancel({ runId })` / `attach({ runId, afterSequence? })`
- `diagnostics.operations.get({ operationId })` / `list({ projectId?, workspaceId?, includeCompleted? })`

`workspaces.list` reads sqlite only (cached rows). Git is used on create/archive, not on list.

`projects.reconcile` is an explicit, read-only comparison of active SQLite workspaces against one repository snapshot. It returns the project, nullable repository identity, inspection time, and a discriminated entry list: `healthy`, `missing`, `branch_mismatch`, `untracked_worktree`, `repository_unavailable`, or `ambiguous`. Ambiguity reasons distinguish a branch found at another path, duplicate canonical paths, a persisted path outside the snapshot, and unsupported bare worktrees. Entries include the persisted workspace and/or Git candidates needed for diagnosis. Archived rows are ignored. Reconciliation never writes SQLite, mutates Git, adopts a worktree, archives a row, or deletes anything.

Slug: `^[a-z0-9][a-z0-9._-]{0,62}$` (no `..`, no `/`). Worktree path must stay under `worktreeRoot` and outside the source repo. Create compensates after ordinary failures only when its operation provenance still agrees. Archive records its requested branch policy before removing the worktree.

Every workspace create/archive receives a ULID before its first side effect and is persisted in the versioned operation journal. Create phases are `intent_recorded`, `git_worktree_created`, `path_verified`, `workspace_row_committed`, and `operation_completed`. Archive phases are `intent_recorded`, `active_runs_handled`, `git_worktree_removed`, `branch_outcome_recorded`, and `workspace_archived`. Workspace insertion/archive and their corresponding phase transitions are single SQLite transactions.

After acquiring the exclusive Host state lease, startup replays incomplete and `needs_attention` operations before scheduling the general run queue. Git continuation runs under the repository lease. Exact identity matches may finish the requested mutation; missing/malformed provenance, duplicate or moved paths, bare/mismatched worktrees, changed branches, unavailable repositories, and conflicting SQLite rows remain `needs_attention`. Startup continues and exposes safe diagnostics. Recovery never deletes an uncertain worktree or branch and is idempotent across repeated crashes.

Default worktree path: `{worktreeRoot}/{slug}`. Default branch: `watt/{slug}`. Default `baseRef`: `HEAD`.

sqlite uses WAL, `foreign_keys=ON`, `busy_timeout=5000`, and unique indexes on active `(project_id, slug)` and active `worktree_path`.

Each send immediately persists a Watt ULID and queued prompt. Runs execute FIFO per session while different sessions may execute concurrently. The prompt is cleared after the private Cursor run ID is durable. Watt passes its run ULID as Cursor's idempotency key.

`runs.attach` replays persisted events after the exclusive sequence cursor, tails live events, and completes when the run is terminal. It accepts an optional internal `AbortSignal` so a transport subscriber can detach and remove its waiter without cancelling the run. The host consumes and persists streams even with no attached caller.

After process restart, queued runs resume automatically. Running rows reacquire Cursor's durable local run by ID; a dispatching row without a committed Cursor ID safely retries with the same idempotency key. Core terminal results are persisted in Watt sqlite.

Queued cancellation never dispatches. Running cancellation delegates to Cursor and waits for the terminal result. Workspace archive cancels and settles its runs before git removal. `host.close()` is asynchronous and idempotent: it rejects new work, cancels active runs, retains queued runs, ends attachments, then closes sqlite.

### `@watt/desktop-sidecar` and Rust bridge

The desktop boundary is a headless child process over stdin/stdout. It exposes the complete Host surface (capabilities, Projects, Workspaces, Sessions, Runs, workspace-operation diagnostics, and close) without adding another backend.

- Protocol v1 uses 4-byte big-endian length-prefixed UTF-8 JSON. The canonical Draft 2020-12 schema is `packages/desktop-sidecar/protocol.schema.json` and is loaded by both TypeScript and Rust; shared fixtures must produce the same validity result in both runtimes.
- Startup begins with `hello` containing a supported version range, capabilities, and Host paths. No Host lease is acquired before a compatible version is selected. Incompatibility returns `protocol_version_unsupported` with supported versions/capabilities and exits cleanly.
- Requests carry a caller-generated ULID and may complete out of order. At most 64 requests and 64 run subscriptions are active at once. `get` operations return `null` when absent.
- `runs.attach` carries a distinct subscription ULID. Its acknowledgement is written before events; persisted event sequences are strictly increasing; natural completion emits exactly one `stream_end` with the persisted `RunResult`. `runs.unsubscribe` stops only forwarding and acknowledges only after its `stream_end`; `runs.cancel` remains Host cancellation.
- Frames are at most 1 MiB, request/result/event payloads at most 768 KiB, and JSON nesting at most 64. Oversized outbound values fail `payload_too_large`; malformed framing, UTF-8, JSON, or envelopes terminate the connection without crashing the process.
- The TypeScript outbound writer is bounded to 256 frames and 8 MiB and honors writable `drain`. The Rust writer is bounded to 64 frames and 8 MiB. Each Rust run consumer is bounded to 64 events and 2 MiB; overflow unsubscribes it with `consumer_too_slow` while the Host run continues.
- Known Watt error codes and safe details cross unchanged. Unknown exceptions become `internal_error`; causes and stacks never cross the boundary. Disconnect fails pending requests with `sidecar_disconnected`, terminates local subscriptions once, and closes the Host.

### Desktop packaging shell

The `apps/desktop` Tauri 2 application is named Watt with identifier `com.handlemotion.watt`. It is a supporting distribution artifact, not part of the v0 product surface, and exposes no workspace controls.

- The Rust bridge remains the only desktop boundary. Frontend code receives only a readiness state and safe message; it has no shell capability and does not import Watt packages.
- `@yao-pkg/pkg` packages the Node Host as the Tauri sidecar `watt-desktop-sidecar-aarch64-apple-darwin`. Its version is pinned and its executable must complete the real protocol handshake in temporary directories before packaging.
- The installed app stores Host state under its macOS application-data directory and worktrees in that directory's `worktrees` child. Closing requests `host.close()`, waits for a bounded graceful exit, then forcibly terminates a stuck child.
- The root `package.json` version is the desktop release version and must equal the Rust package version and stable `vMAJOR.MINOR.PATCH` release tag.
- The first distribution is an Apple Silicon DMG signed with Developer ID Application credentials, notarized and stapled by Apple, attested by GitHub, and attached to the exact existing Git tag's GitHub Release. Manual DMG upgrades are the only update path in v0.
- The protected release job obtains Apple credentials from a read-only Infisical machine identity using GitHub OIDC. Apple credentials are never stored in or synchronized to GitHub Secrets, and they are requested only after source validation succeeds.
- HTTP, WebSocket, updater, direct frontend shell access, and workspace product UI remain forbidden.

### `@watt/cli`

Imports `@watt/host` only.

```
watt --repo <path> [--state-dir <dir>] [--worktree-root <dir>] worktree create --slug <slug> [--branch <b>] [--base <ref>]
watt --repo <path> worktree ls
watt --repo <path> worktree archive --workspace <id>
watt agent send --workspace <id> -p "<prompt>" [--model <id>] [--model-param <id=value>...] [--mode <agent|plan>]
```

`agent send` attaches to the created run and writes one JSONL `HostEvent` per line on stdout.

Default `--state-dir`: `~/.watt`. Default `--worktree-root`: parent of `--repo` (or `{stateDir}/worktrees` when `--repo` is omitted). `--repo` is required for `worktree create|ls`. `worktree archive` and `agent send` can use `--state-dir` alone.

## Persistence

| Table              | Columns                                                                                                                                                                             |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `projects`         | `id`, `repo_root` (unique), `created_at`                                                                                                                                            |
| `workspaces`       | `id`, `project_id`, `worktree_path`, `branch`, `slug`, `base_ref`, `created_at`, `archived_at`                                                                                      |
| `sessions`         | `id`, `workspace_id`, `cursor_agent_id`, `mode`, `model`, model parameters JSON, effective execution-policy JSON, `created_at`                                                      |
| `runs`             | `id`, `session_id`, private `cursor_run_id`, internal status, transient prompt, timestamps, terminal result fields                                                                  |
| `run_events`       | `run_id`, monotonic `sequence`, serialized `HostEvent`, `created_at`; `(run_id, sequence)` is unique                                                                                |
| `operations`       | schema version, operation/project/workspace identity, requested JSON, phase, timestamps/recovery attempts, terminal and compensation outcomes, branch outcome, safe diagnostic JSON |
| `capability_cache` | singleton model-catalog JSON and successful fetch time                                                                                                                              |

## Tests (default `pnpm test`)

- `@watt/git`: temp repositories/worktrees, copy gitignored `.env`, archive keeps branch, branch uniqueness, bounded Git commands, canonical inspection, operation provenance, expected-OID branch protection, ambiguity safety, and separate-process lease serialization/recovery.
- `@watt/agent`: mocked `CursorRuntime` only.
- `@watt/host`: fake/real git + fake agent; migrations, operation diagnostics, phase-boundary startup recovery, ambiguity safety, cached listing, non-destructive reconciliation drift fixtures, FIFO sends, replay/tail attachment, cancellation, results, archive ordering, and graceful close.
- Integration with `CURSOR_API_KEY` is **not** in the default suite.
- Desktop CI additionally runs Rust formatting, clippy with warnings denied, Rust tests, a packaged arm64 sidecar handshake/shutdown smoke test, and an ad-hoc-signed Tauri application build.

## Code rules

Strict TypeScript, `unknown` not `any`, exhaustive switches on unions, no ACP/cloud “for later”.
