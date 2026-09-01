# Agents

Watt is a Cursor-native worktree host with libraries, a CLI, and a Svelte 5 + Tauri 2 desktop app. Desktop product UI and local terminal capability are supported. The frontend talks to `@watt/host` through the typed Rust sidecar bridge; keep filesystem and process authority in Rust. Do not add HTTP, WebSocket, Electron, ACP, or cloud agents.

## Desktop shell icons

Use **Central Icons Medium variants only** (`IconChevronRightMedium`, `IconPlusMedium`, etc.). Scale with the icon `size` prop — never pick `Small`, `Large`, or `Big` variants to tune visual weight. If no Medium export exists, use the base icon name and still scale with `size`.
