const MAX_WRITE_BYTES = 64 * 1024;

export function terminalWriteQueue(
  send: (bytes: Uint8Array) => Promise<void>,
): (data: string) => void {
  const encoder = new TextEncoder();
  let pending = Promise.resolve();
  return (data: string) => {
    const bytes = encoder.encode(data);
    for (let offset = 0; offset < bytes.length; offset += MAX_WRITE_BYTES) {
      const chunk = bytes.slice(offset, offset + MAX_WRITE_BYTES);
      pending = pending.then(() => send(chunk)).catch(() => undefined);
    }
  };
}

export function nextTerminalSidebarWidth(
  pointerX: number,
  viewportWidth: number,
  leftSidebarWidth = 324,
): number {
  const dynamicMaximum = Math.max(
    0,
    Math.min(640, viewportWidth - leftSidebarWidth - 320),
  );
  const minimum = Math.min(300, dynamicMaximum);
  return Math.round(
    Math.min(dynamicMaximum, Math.max(minimum, viewportWidth - pointerX)),
  );
}

export function isTerminalToggle(
  event: Pick<KeyboardEvent, "key" | "metaKey">,
): boolean {
  return event.metaKey && event.key.toLowerCase() === "j";
}

export function retainOpenedTerminalIds(
  openedIds: readonly string[],
  activeIds: readonly string[],
): string[] {
  const active = new Set(activeIds);
  return openedIds.filter((id) => active.has(id));
}
