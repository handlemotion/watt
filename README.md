# Watt

Cursor-native worktree host for local Cursor and Codex sessions, with libraries, a CLI, and a native Svelte 5 + Tauri 2 desktop app. See [SPEC.md](./SPEC.md).

## CLI dogfood

Build the workspace, create a worktree, and start a local session:

```sh
pnpm build
node packages/cli/dist/cli.js --repo /path/to/repo worktree create --slug first-run
node packages/cli/dist/cli.js agent send --workspace <workspace-id> --runtime cursor -p "Inspect this repository" --detach
node packages/cli/dist/cli.js run attach --run <run-id>
```

Use `--runtime chatgpt` for Codex; it uses the existing `codex login` authentication. Codex sends remain attached because the current SDK cannot recover an in-flight run after the CLI exits. Follow-ups retain the session's runtime:

```sh
node packages/cli/dist/cli.js agent send --session <session-id> -p "Continue with the next fix"
node packages/cli/dist/cli.js agent ls --workspace <workspace-id>
node packages/cli/dist/cli.js run ls --session <session-id>
node packages/cli/dist/cli.js run cancel --run <run-id>
```

Run `node packages/cli/dist/cli.js --help` for capabilities, reconciliation, and operation-diagnostic commands. Cursor sends support `--detach`; normal CLI exit suspends the Host without cancelling their active work. Desktop shutdown and explicit `run cancel` retain cancellation semantics.

## macOS distribution

The first packaged distribution supports Apple Silicon Macs running macOS 13 or later. Download `Watt-vX.Y.Z-aarch64.dmg` and its `.sha256` file from the matching [GitHub Release](https://github.com/handlemotion/watt/releases), then verify it before opening the DMG:

```sh
shasum -a 256 -c Watt-vX.Y.Z-aarch64.dmg.sha256
gh attestation verify Watt-vX.Y.Z-aarch64.dmg --repo handlemotion/watt
```

Drag Watt into Applications and launch it normally. The desktop app reads projects, worktrees, and sessions from the local Host and includes one native PTY-backed terminal per active worktree. Press <kbd>⌘J</kbd> to show or hide the terminal sidebar.

## Development

Watt requires Node.js 22.13+, pnpm 11.22.0, the latest stable Rust toolchain, and Xcode for Tauri desktop work.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm check:rust
pnpm desktop:sidecar
pnpm desktop:sidecar:smoke
```

Dependency installation requires `CENTRAL_LICENSE_KEY` for the licensed Svelte icon package. After install, start the Tauri app with `pnpm desktop`. It builds the sidecar on first run if needed. Desktop views use the existing typed Rust bridge rather than introducing another transport; filesystem paths and executable selection remain native-only capabilities.

`pnpm desktop:build` produces an ad-hoc-signed Tauri app and DMG on an Apple Silicon Mac, including real packaged Host lifecycle probes. Developer ID signing and notarization happen only in the protected GitHub `release` environment, and only after a Version Packages PR merges. Add a changeset with `pnpm changeset` in any PR that should ship.
