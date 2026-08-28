import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { access } from "node:fs/promises";

import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";

import { createGit } from "./create-git.js";
import { GitError } from "./errors.js";
import type { GitSpawn } from "./types.js";
import { defaultGitSpawn } from "./spawn.js";

async function initRepo(): Promise<{ repo: string; parent: string }> {
  const parent = await mkdtemp(path.join(tmpdir(), "watt-git-"));
  const repo = path.join(parent, "repo");
  await mkdir(repo);
  await execa("git", ["init", "-b", "main"], { cwd: repo });
  await execa("git", ["config", "user.email", "watt@example.com"], { cwd: repo });
  await execa("git", ["config", "user.name", "Watt"], { cwd: repo });
  await writeFile(path.join(repo, "README.md"), "watt\n");
  await writeFile(path.join(repo, ".gitignore"), ".env\n");
  await writeFile(path.join(repo, ".env"), "SECRET=1\n");
  await execa("git", ["add", "README.md", ".gitignore"], { cwd: repo });
  await execa("git", ["commit", "-m", "init"], { cwd: repo });
  return { repo, parent };
}

const temps: string[] = [];

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("createGit", () => {
  it("creates two worktrees, copies gitignored .env, archives and keeps the branch", async () => {
    const { repo, parent } = await initRepo();
    temps.push(parent);
    const git = createGit();
    const firstPath = path.join(parent, "wt-one");
    const secondPath = path.join(parent, "wt-two");

    const first = await git.createWorktree({
      repoRoot: repo,
      worktreePath: firstPath,
      slug: "one",
      branch: "watt/one",
      baseRef: "HEAD",
      copyGlobs: [".env"],
    });
    const second = await git.createWorktree({
      repoRoot: repo,
      worktreePath: secondPath,
      slug: "two",
      branch: "watt/two",
      baseRef: "HEAD",
      copyGlobs: [".env"],
    });

    expect(first.copied).toContain(".env");
    expect(second.copied).toContain(".env");
    await access(path.join(firstPath, ".env"));
    await access(path.join(secondPath, ".env"));

    const listed = await git.listWorktrees(repo);
    expect(listed.map((row) => row.branch).sort()).toEqual(["main", "watt/one", "watt/two"].sort());

    await git.archiveWorktree({
      repoRoot: repo,
      worktreePath: firstPath,
      branch: "watt/one",
    });

    await expect(access(firstPath)).rejects.toThrow();
    await execa("git", ["show-ref", "--verify", "refs/heads/watt/one"], { cwd: repo });
  });

  it("rejects a duplicate branch", async () => {
    const { repo, parent } = await initRepo();
    temps.push(parent);
    const git = createGit();
    await git.createWorktree({
      repoRoot: repo,
      worktreePath: path.join(parent, "wt-a"),
      slug: "a",
      branch: "watt/same",
      baseRef: "HEAD",
    });
    await expect(
      git.createWorktree({
        repoRoot: repo,
        worktreePath: path.join(parent, "wt-b"),
        slug: "b",
        branch: "watt/same",
        baseRef: "HEAD",
      }),
    ).rejects.toMatchObject({ code: "branch_exists" });
  });

  it("serializes mutations on the same repo and times out hung git", async () => {
    const { repo, parent } = await initRepo();
    temps.push(parent);
    let inFlight = 0;
    let maxInFlight = 0;
    const spawn: GitSpawn = async (args, options) => {
      if (args[0] === "worktree" && args[1] === "add") {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 40));
        inFlight -= 1;
      }
      return defaultGitSpawn(args, options);
    };
    const git = createGit({ spawn });
    await Promise.all([
      git.createWorktree({
        repoRoot: repo,
        worktreePath: path.join(parent, "lock-a"),
        slug: "lock-a",
        branch: "watt/lock-a",
        baseRef: "HEAD",
      }),
      git.createWorktree({
        repoRoot: repo,
        worktreePath: path.join(parent, "lock-b"),
        slug: "lock-b",
        branch: "watt/lock-b",
        baseRef: "HEAD",
      }),
    ]);
    expect(maxInFlight).toBe(1);

    const hanging: GitSpawn = async (_args, options) => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => resolve(), 5_000);
        options.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new GitError("hung git aborted", "timeout"));
        });
      });
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    const timed = createGit({ spawn: hanging, timeoutMs: 20 });
    await expect(timed.listWorktrees(repo)).rejects.toMatchObject({ code: "timeout" });
  });

  it("rolls back the worktree when setup fails", async () => {
    const { repo, parent } = await initRepo();
    temps.push(parent);
    await writeFile(path.join(repo, "watt.json"), JSON.stringify({ setup: "false" }));
    const git = createGit();
    await expect(
      git.createWorktree({
        repoRoot: repo,
        worktreePath: path.join(parent, "wt-fail"),
        slug: "fail",
        branch: "watt/fail",
        baseRef: "HEAD",
      }),
    ).rejects.toMatchObject({ code: "setup_failed" });
    const listed = await git.listWorktrees(repo);
    expect(listed.map((row) => row.branch)).toEqual(["main"]);
    await expect(execa("git", ["show-ref", "--verify", "refs/heads/watt/fail"], { cwd: repo })).rejects.toThrow();
  });

  it("rejects copy globs that escape the repo", async () => {
    const { repo, parent } = await initRepo();
    temps.push(parent);
    await writeFile(path.join(parent, "secret"), "nope\n");
    const git = createGit();
    await expect(
      git.createWorktree({
        repoRoot: repo,
        worktreePath: path.join(parent, "wt-escape"),
        slug: "escape",
        branch: "watt/escape",
        baseRef: "HEAD",
        copyGlobs: ["../secret"],
      }),
    ).rejects.toMatchObject({ code: "path_escape" });
  });

  it("rejects a nested worktree path", async () => {
    const { repo, parent } = await initRepo();
    temps.push(parent);
    const git = createGit();
    await expect(
      git.createWorktree({
        repoRoot: repo,
        worktreePath: path.join(repo, "nested"),
        slug: "nested",
        branch: "watt/nested",
        baseRef: "HEAD",
      }),
    ).rejects.toMatchObject({ code: "nested_worktree" });
  });
});
