# Watt

Cursor-native worktree host. See [SPEC.md](./SPEC.md).

## macOS distribution

The first packaged distribution supports Apple Silicon Macs running macOS 13 or later. Download `Watt-vX.Y.Z-aarch64.dmg` and its `.sha256` file from the matching [GitHub Release](https://github.com/handlemotion/watt/releases), then verify it before opening the DMG:

```sh
shasum -a 256 -c Watt-vX.Y.Z-aarch64.dmg.sha256
gh attestation verify Watt-vX.Y.Z-aarch64.dmg --repo handlemotion/watt
```

Drag Watt into Applications and launch it normally. The current desktop app is intentionally a lifecycle shell: it proves that the local Host starts and shuts down safely, but does not yet provide workspace product UI or automatic updates.

## Development

Watt requires Node.js 22.13+, pnpm 11.22.0, the latest stable Rust toolchain, and Xcode for Tauri desktop work.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm check:rust
pnpm desktop:sidecar
pnpm desktop:sidecar:smoke
```

After `pnpm install`, start the Tauri app with `pnpm desktop`. It builds the sidecar on first run if needed. Future views should use the existing typed Rust bridge rather than introducing another transport.

`pnpm desktop:build` produces an ad-hoc-signed Tauri app and DMG on an Apple Silicon Mac, including real packaged Host lifecycle probes. Developer ID signing and notarization happen only in the protected GitHub `release` environment, and only after a Version Packages PR merges. Add a changeset with `pnpm changeset` in any PR that should ship.
