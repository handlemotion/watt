import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { execa } from "execa";
import { describe, expect, it } from "vitest";

const directory = path.dirname(fileURLToPath(import.meta.url));
const loader = path.join(directory, "block-cursor-sdk-loader.mjs");
const cli = path.join(directory, "..", "dist", "cli.js");

describe("built non-agent CLI paths", () => {
  it("do not resolve @cursor/sdk for help or cached worktree commands", async () => {
    const help = await execa(process.execPath, ["--experimental-loader", loader, cli, "--help"]);
    expect(help.stdout).toContain("Cursor-native worktree host");

    const root = await mkdtemp(path.join(tmpdir(), "watt-cli-loader-"));
    const repo = path.join(root, "repo");
    await mkdir(repo);
    const listed = await execa(process.execPath, [
      "--experimental-loader",
      loader,
      cli,
      "--repo",
      repo,
      "--state-dir",
      path.join(root, "state"),
      "--worktree-root",
      path.join(root, "worktrees"),
      "worktree",
      "ls",
    ]);
    expect(listed.stdout).toBe("[]");
  }, 15_000);
});
