import { Channel, invoke } from "@tauri-apps/api/core";

import type { DesktopSnapshot } from "$lib/types";

export type TerminalEvent =
  | { type: "output"; data: number[] }
  | { type: "exit"; code: number; signal: string | null }
  | { type: "error"; message: string };

export type TerminalDescriptor = {
  terminalId: string;
  workspaceId: string;
  reused: boolean;
};

export function desktopSnapshot(): Promise<DesktopSnapshot> {
  return invoke("desktop_snapshot");
}

export function openTerminal(
  workspaceId: string,
  cols: number,
  rows: number,
  onEvent: (event: TerminalEvent) => void,
): Promise<TerminalDescriptor> {
  const channel = new Channel<TerminalEvent>();
  channel.onmessage = onEvent;
  return invoke("terminal_open", { workspaceId, cols, rows, onEvent: channel });
}

export function writeTerminal(
  terminalId: string,
  data: Uint8Array,
): Promise<void> {
  return invoke("terminal_write", { terminalId, data: Array.from(data) });
}

export function resizeTerminal(
  terminalId: string,
  cols: number,
  rows: number,
): Promise<void> {
  return invoke("terminal_resize", { terminalId, cols, rows });
}

export function restartTerminal(terminalId: string): Promise<void> {
  return invoke("terminal_restart", { terminalId });
}

export function killTerminal(terminalId: string): Promise<void> {
  return invoke("terminal_kill", { terminalId });
}
