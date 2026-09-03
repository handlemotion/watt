import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { execa } from "execa";
import { describe, expect, it } from "vitest";

import { runCli } from "./program.js";

async function initRepo(parent: string): Promise<string> {
  const repo = path.join(parent, "repo");
  await mkdir(repo);
  await execa("git", ["init", "-b", "main"], { cwd: repo });
  await execa("git", ["config", "user.email", "watt@example.com"], {
    cwd: repo,
  });
  await execa("git", ["config", "user.name", "Watt"], { cwd: repo });
  await writeFile(path.join(repo, "README.md"), "watt\n");
  await execa("git", ["add", "README.md"], { cwd: repo });
  await execa("git", ["commit", "-m", "init"], { cwd: repo });
  return repo;
}

describe("watt cli", () => {
  it("creates a worktree in a temp git repo", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "watt-cli-"));
    const repo = await initRepo(parent);
    const stateDir = path.join(parent, "state");
    const worktreeRoot = path.join(parent, "trees");
    const chunks: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await runCli([
        "node",
        "watt",
        "--repo",
        repo,
        "--state-dir",
        stateDir,
        "--worktree-root",
        worktreeRoot,
        "worktree",
        "create",
        "--slug",
        "alpha",
      ]);
    } finally {
      process.stdout.write = originalWrite;
    }
    const parsed: unknown = JSON.parse(chunks.join("").trim());
    expect(parsed).toMatchObject({ slug: "alpha", branch: "watt/alpha" });
  });
});
