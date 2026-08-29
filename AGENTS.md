# Agents

Watt is a Cursor-native worktree host. **[SPEC.md](./SPEC.md) is the contract.** Keep code in lockstep with it.

v0's product surface is libraries + CLI only. The minimal GPUI shell is distribution infrastructure: it may package the local Host and display readiness, but it must not expose workspace controls or other product UI. Future UI talks only to `@watt/host` through the typed Rust sidecar bridge. Do not add HTTP, WebSocket, Electron, ACP, or cloud agents.
