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

Mutations are serialized per `repoRoot`. Every git spawn has a timeout. Concurrent git processes are capped (default 4).

```ts
createGit(options?: { timeoutMs?: number; concurrency?: number; spawn?: GitSpawn }): GitService;

interface GitService {
  createWorktree(input: CreateWorktreeInput): Promise<CreatedWorktree>;
  listWorktrees(repoRoot: string): Promise<GitWorktree[]>;
  archiveWorktree(input: ArchiveWorktreeInput): Promise<void>;
}

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

1. Refuse nested worktree paths (inside `repoRoot`) and invalid git refs.
2. `git worktree add -b <branch> <worktreePath> <baseRef>` (fails if branch exists).
3. Copy files from `repoRoot` matching copy globs (dotfiles included; gitignore is not applied). Globs and matched paths must stay inside `repoRoot`.
4. Run setup in the new worktree with `ROOT_WORKTREE_PATH` = source `repoRoot`.
5. If copy or setup fails, remove the worktree and delete the new branch.

Invalid `watt.json` / `.cursor/worktrees.json` fails closed (`config_invalid`).

Config, first match:

1. `watt.json` at `repoRoot`: `{ "copy"?: string[], "setup"?: string | string[] }`. `copyGlobs` on the call is concatenated.
2. Else `.cursor/worktrees.json` `setup-worktree-unix` (Unix) or `setup-worktree`, as a command array or script path relative to `.cursor/`. Copy globs only from the call / `watt.json`.
3. Else no setup.

Archive is idempotent: missing worktrees are a no-op. It **keeps the branch** unless `keepBranch: false`. No unarchive in v0.

`listWorktrees` uses `git worktree list --porcelain` once. It does not `git status` each path.

### `@watt/agent`

Inject `CursorRuntime` so tests mock the SDK (default `pnpm test` has no network).

```ts
createAgent(options: { runtime: CursorRuntime; apiKey?: string }): WattAgent;

interface WattAgent {
  create(input: CreateAgentInput): Promise<WattSessionHandle>;
  resume(input: ResumeAgentInput): Promise<WattSessionHandle>;
}

interface WattSessionHandle {
  cursorAgentId: string;
  send(prompt: string): Promise<WattRun>;
}

interface WattRun {
  stream(): AsyncIterable<AgentEvent>;
  wait(): Promise<{ status: "finished" | "error" | "cancelled" }>;
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
- Never log API keys.

`createSdkRuntime()` wraps `@cursor/sdk` `Agent.create` / `resume` / `send` / `stream` / `wait` / `cancel`. Local only.

### `@watt/host`

Only public surface for a future UI.

```ts
createHost(options: {
  stateDir: string;
  worktreeRoot: string;
  apiKey?: string;
  git?: GitService;
  agent?: WattAgent;
}): Host;

type HostEvent = AgentEvent & { workspaceId: string; sessionId: string };
```

sqlite file: `{stateDir}/watt.sqlite`.

- `projects.register(repoRoot)` / `projects.get` / `projects.list`
- `workspaces.create({ projectId, slug, branch?, baseRef? })` / `list({ projectId })` / `get` / `archive({ workspaceId, keepBranch? })`
- `sessions.create({ workspaceId, model?, prompt })` / `send({ sessionId, prompt })` / `get` / `list({ workspaceId })`

`workspaces.list` reads sqlite only (cached rows). Git is used on create/archive, not on list.

Slug: `^[a-z0-9][a-z0-9._-]{0,62}$` (no `..`, no `/`). Worktree path must stay under `worktreeRoot` and outside the source repo. Create rolls back the git worktree if sqlite insert fails. Archive always attempts git remove (idempotent), then records `archivedAt`.

Default worktree path: `{worktreeRoot}/{slug}`. Default branch: `watt/{slug}`. Default `baseRef`: `HEAD`.

sqlite uses WAL, `foreign_keys=ON`, `busy_timeout=5000`, and a unique index on active `(project_id, slug)`.

Resume after process restart: `sessions.send` calls `agent.resume` with stored `cursorAgentId`.

### `@watt/cli`

Imports `@watt/host` only.

```
watt --repo <path> [--state-dir <dir>] [--worktree-root <dir>] worktree create --slug <slug> [--branch <b>] [--base <ref>]
watt --repo <path> worktree ls
watt --repo <path> worktree archive --workspace <id>
watt agent send --workspace <id> -p "<prompt>" [--model <id>]
```

`agent send` writes one JSONL `HostEvent` per line on stdout.

Default `--state-dir`: `~/.watt`. Default `--worktree-root`: parent of `--repo` (or `{stateDir}/worktrees` when `--repo` is omitted). `--repo` is required for `worktree create|ls`. `worktree archive` and `agent send` can use `--state-dir` alone.

## Persistence

| Table        | Columns                                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------ |
| `projects`   | `id`, `repo_root` (unique), `created_at`                                                         |
| `workspaces` | `id`, `project_id`, `worktree_path`, `branch`, `slug`, `base_ref`, `created_at`, `archived_at`   |
| `sessions`   | `id`, `workspace_id`, `cursor_agent_id`, `mode`, `model`, `created_at`                           |

## Tests (default `pnpm test`)

- `@watt/git`: temp repo, two worktrees, copy gitignored `.env`, archive keeps branch, branch uniqueness, lock + timeout.
- `@watt/agent`: mocked `CursorRuntime` only.
- `@watt/host`: fake git + fake agent; persist + resume mapping.
- Integration with `CURSOR_API_KEY` is **not** in the default suite.

## Code rules

Strict TypeScript, `unknown` not `any`, exhaustive switches on unions, no ACP/cloud “for later”.
