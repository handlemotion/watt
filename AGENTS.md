# Agents

Watt is a Cursor-native worktree host. **[SPEC.md](./SPEC.md) is the contract.** Keep code in lockstep with it.

v0's product surface is libraries + CLI only. The Svelte + Tauri shell is distribution infrastructure: it may package the local Host and start the sidecar, but it must not expose workspace controls or other product UI. Future UI talks only to `@watt/host` through the typed Rust sidecar bridge. Do not add HTTP, WebSocket, Electron, ACP, or cloud agents.

## Desktop shell icons

Use **Central Icons Medium variants only** (`IconChevronRightMedium`, `IconPlusMedium`, etc.). Scale with the icon `size` prop — never pick `Small`, `Large`, or `Big` variants to tune visual weight. If no Medium export exists, use the base icon name and still scale with `size`.
