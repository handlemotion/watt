# Watt v0 specification

Cursor-native git worktree host. Long-lived Node process: register a repo, create/list/archive sibling worktrees, run Cursor local agents on a worktree `cwd`, stream typed events, resume sessions after process restart.

This file is the source of truth. Packages must match it.

## Goals

- Register a git checkout (**project**), create/list/archive **workspaces** (sibling worktrees), run many **sessions** per workspace.
- MCP / rules / skills load via `settingSources: ["project", "user", "plugins"]` with `cwd` = that worktree.
- Copy selected gitignored files from the source checkout; run a repo-local setup command.
- Listing workspaces reads a **cached snapshot** in sqlite. It must not `git status` (or equivalent) every historical cwd.

## Non-goals (v0)

- UI, HTTP, WebSocket, Electron, Tauri, compiled desktop binary.
- GitHub stacks (`gh stack`), nested worktrees, unarchive.
- Cloud agents, ACP, Debug mode, Ask mode.
- Phone/relay, multi-provider, Paseo/Conductor, Transitive-specific D1/Postgres provision.

## Runtime

- Node **22.13+**, TypeScript strict, pnpm workspace, Turbo.
- IDs: ULID. Paths: absolute, `realpath`’d.
- No React/UI packages. `@cursor/sdk` only in `@watt/agent`. CLI imports `@watt/host` only.
- `git` ↛ `agent` ↛ `git`. Only `host` imports both.

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
  mode: "agent";
  model: string;
  createdAt: number;
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

Mutation leases live under the canonical Git common directory and contain an atomically published owner ID, operation, PID, hostname, process-start fingerprint, repository identity, and acquisition time. Acquisition is bounded and fails with `repo_busy` plus owner details. A lease is reclaimed only when a same-host PID/start fingerprint definitively proves that its owner exited; live, foreign-host, malformed, and unverifiable owners are never expired by age. Release and reclamation verify the exact lease ID before removal.

`inspectRepository` uses `git worktree list --porcelain` exactly once and returns a canonical snapshot without taking the mutation lease. `listWorktrees` delegates to inspection and returns its worktrees. Neither operation runs `git status` per path.

### `@watt/agent`

Inject `CursorRuntime` so tests mock the SDK (default `pnpm test` has no network).

```ts
createAgent(options: { runtime: CursorRuntime; apiKey?: string }): WattAgent;

interface WattAgent {
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

- Default local options: `settingSources: ["project", "user", "plugins"]`, `cwd` = worktree path, `autoReview` optional.
- Built-in custom tool `watt_workspace_info` (no secrets). Re-pass `customTools` (builtin + caller) on **resume**.
- Map SDK stream messages → `AgentEvent` with exhaustive `never` on `AgentEvent`. Unknown SDK `type` values are ignored.
- `stream()` always `wait()`s the underlying run when the iterator completes, so watchers are released.
- Preserve Cursor run IDs and core terminal results, pass caller idempotency keys through `send`, and reacquire durable local runs through `Agent.getRun(runId, { cwd })`.
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

sqlite file: `{stateDir}/watt.sqlite`.

Only one live Host process may own a canonical `stateDir`. Acquisition is bounded and fails with `host_busy` while a live or unverifiable owner holds it. A same-host lease is reclaimed only when its PID/start fingerprint definitively proves that process exited. Closing the Host releases the lease.

- `projects.register(repoRoot)` / `projects.get` / `projects.list` / `projects.reconcile({ projectId })`
- `workspaces.create({ projectId, slug, branch?, baseRef? })` / `list({ projectId })` / `get` / `archive({ workspaceId, keepBranch? })`
- `sessions.create({ workspaceId, model?, prompt })` / `send({ sessionId, prompt })` return `{ session, run }`; `get` / `list({ workspaceId })` remain SQLite-backed.
- `runs.get` / `list({ sessionId })` / `wait({ runId })` / `cancel({ runId })` / `attach({ runId, afterSequence? })`

`workspaces.list` reads sqlite only (cached rows). Git is used on create/archive, not on list.

`projects.reconcile` is an explicit, read-only comparison of active SQLite workspaces against one repository snapshot. It returns the project, nullable repository identity, inspection time, and a discriminated entry list: `healthy`, `missing`, `branch_mismatch`, `untracked_worktree`, `repository_unavailable`, or `ambiguous`. Ambiguity reasons distinguish a branch found at another path, duplicate canonical paths, a persisted path outside the snapshot, and unsupported bare worktrees. Entries include the persisted workspace and/or Git candidates needed for diagnosis. Archived rows are ignored. Reconciliation never writes SQLite, mutates Git, adopts a worktree, archives a row, or deletes anything.

Slug: `^[a-z0-9][a-z0-9._-]{0,62}$` (no `..`, no `/`). Worktree path must stay under `worktreeRoot` and outside the source repo. Create rolls back the git worktree if sqlite insert fails. Archive always attempts git remove (idempotent), then records `archivedAt`.

Default worktree path: `{worktreeRoot}/{slug}`. Default branch: `watt/{slug}`. Default `baseRef`: `HEAD`.

sqlite uses WAL, `foreign_keys=ON`, `busy_timeout=5000`, and unique indexes on active `(project_id, slug)` and active `worktree_path`.

Each send immediately persists a Watt ULID and queued prompt. Runs execute FIFO per session while different sessions may execute concurrently. The prompt is cleared after the private Cursor run ID is durable. Watt passes its run ULID as Cursor's idempotency key.

`runs.attach` replays persisted events after the exclusive sequence cursor, tails live events, and completes when the run is terminal. The host consumes and persists streams even with no attached caller.

After process restart, queued runs resume automatically. Running rows reacquire Cursor's durable local run by ID; a dispatching row without a committed Cursor ID safely retries with the same idempotency key. Core terminal results are persisted in Watt sqlite.

Queued cancellation never dispatches. Running cancellation delegates to Cursor and waits for the terminal result. Workspace archive cancels and settles its runs before git removal. `host.close()` is asynchronous and idempotent: it rejects new work, cancels active runs, retains queued runs, ends attachments, then closes sqlite.

### `@watt/cli`

Imports `@watt/host` only.

```
watt --repo <path> [--state-dir <dir>] [--worktree-root <dir>] worktree create --slug <slug> [--branch <b>] [--base <ref>]
watt --repo <path> worktree ls
watt --repo <path> worktree archive --workspace <id>
watt agent send --workspace <id> -p "<prompt>" [--model <id>]
```

`agent send` attaches to the created run and writes one JSONL `HostEvent` per line on stdout.

Default `--state-dir`: `~/.watt`. Default `--worktree-root`: parent of `--repo` (or `{stateDir}/worktrees` when `--repo` is omitted). `--repo` is required for `worktree create|ls`. `worktree archive` and `agent send` can use `--state-dir` alone.

## Persistence

| Table        | Columns                                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------------------ |
| `projects`   | `id`, `repo_root` (unique), `created_at`                                                                           |
| `workspaces` | `id`, `project_id`, `worktree_path`, `branch`, `slug`, `base_ref`, `created_at`, `archived_at`                     |
| `sessions`   | `id`, `workspace_id`, `cursor_agent_id`, `mode`, `model`, `created_at`                                             |
| `runs`       | `id`, `session_id`, private `cursor_run_id`, internal status, transient prompt, timestamps, terminal result fields |
| `run_events` | `run_id`, monotonic `sequence`, serialized `HostEvent`, `created_at`; `(run_id, sequence)` is unique               |

## Tests (default `pnpm test`)

- `@watt/git`: temp repositories/worktrees, copy gitignored `.env`, archive keeps branch, branch uniqueness, bounded Git commands, canonical inspection, and separate-process lease serialization/recovery.
- `@watt/agent`: mocked `CursorRuntime` only.
- `@watt/host`: fake/real git + fake agent; migrations, cached listing, non-destructive reconciliation drift fixtures, FIFO sends, replay/tail attachment, cancellation, results, recovery, archive ordering, and graceful close.
- Integration with `CURSOR_API_KEY` is **not** in the default suite.

## Code rules

Strict TypeScript, `unknown` not `any`, exhaustive switches on unions, no ACP/cloud “for later”.
