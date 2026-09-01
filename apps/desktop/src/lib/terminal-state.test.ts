import { describe, expect, it } from "vitest";

import {
  isTerminalToggle,
  nextTerminalSidebarWidth,
  retainOpenedTerminalIds,
  terminalWriteQueue,
} from "./terminal-state";

describe("terminal sidebar state", () => {
  it("only treats Command-J as the app terminal shortcut", () => {
    expect(isTerminalToggle({ key: "j", metaKey: true })).toBe(true);
    expect(isTerminalToggle({ key: "J", metaKey: true })).toBe(true);
    expect(isTerminalToggle({ key: "j", metaKey: false })).toBe(false);
  });

  it("keeps the panel within its bounds and leaves main content visible", () => {
    expect(nextTerminalSidebarWidth(600, 1_440)).toBe(640);
    expect(nextTerminalSidebarWidth(1_400, 1_440)).toBe(300);
    expect(nextTerminalSidebarWidth(400, 2_000)).toBe(640);
    expect(nextTerminalSidebarWidth(500, 1_000)).toBe(356);
  });

  it("retains opened instances across hiding and workspace switches", () => {
    expect(
      retainOpenedTerminalIds(["one", "two"], ["one", "two", "three"]),
    ).toEqual(["one", "two"]);
    expect(retainOpenedTerminalIds(["one", "removed"], ["one", "two"])).toEqual(
      ["one"],
    );
  });
});

describe("terminal writes", () => {
  it("serializes concurrent input", async () => {
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const queue = terminalWriteQueue(async (bytes) => {
      const value = new TextDecoder().decode(bytes);
      order.push(`start:${value}`);
      if (value === "first") {
        await new Promise<void>((resolve) => (releaseFirst = resolve));
      }
      order.push(`end:${value}`);
    });
    queue("first");
    queue("second");
    await Promise.resolve();
    expect(order).toEqual(["start:first"]);
    releaseFirst?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual([
      "start:first",
      "end:first",
      "start:second",
      "end:second",
    ]);
  });

  it("splits writes larger than 64 KiB", async () => {
    const sizes: number[] = [];
    const queue = terminalWriteQueue(async (bytes) => {
      sizes.push(bytes.length);
    });
    queue("a".repeat(64 * 1024 + 3));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sizes).toEqual([64 * 1024, 3]);
  });
});
