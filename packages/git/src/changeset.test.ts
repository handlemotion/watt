import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";

import { createGit } from "./index.js";

const temporary: string[] = [];
afterEach(async () =>
  Promise.all(
    temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  ),
);

async function repository(): Promise<{
  root: string;
  base: string;
  cloud: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "watt-changeset-"));
  temporary.push(root);
  await execa("git", ["init", "-b", "main"], { cwd: root });
  await execa("git", ["config", "user.email", "watt@example.invalid"], {
    cwd: root,
  });
  await execa("git", ["config", "user.name", "Watt Test"], { cwd: root });
  await writeFile(path.join(root, "base.txt"), "base\n");
  await execa("git", ["add", "."], { cwd: root });
  await execa("git", ["commit", "-m", "base"], { cwd: root });
  const base = (await execa("git", ["rev-parse", "HEAD"], { cwd: root })).stdout;
  await execa("git", ["switch", "-c", "watt/cloud/test"], { cwd: root });
  await writeFile(path.join(root, "cloud.txt"), "cloud\n");
  await execa("git", ["add", "."], { cwd: root });
  await execa("git", ["commit", "-m", "cloud"], { cwd: root });
  const cloud = (await execa("git", ["rev-parse", "HEAD"], { cwd: root })).stdout;
  await execa("git", ["switch", "main"], { cwd: root });
  return { root, base, cloud };
}

describe("changeset integration", () => {
  it("preflights exact SHAs without touching the worktree, then applies", async () => {
    const fixture = await repository();
    const git = createGit();
    const input = {
      id: "changeset-1234",
      repoRoot: fixture.root,
      worktreePath: fixture.root,
      remote: ".",
      branch: "watt/cloud/test",
      expectedLocalSha: fixture.base,
      expectedRemoteSha: fixture.cloud,
    };
    await expect(git.changesets.preflight(input)).resolves.toEqual({
      state: "ready",
      localSha: fixture.base,
      remoteSha: fixture.cloud,
    });
    expect((await execa("git", ["rev-parse", "HEAD"], { cwd: fixture.root })).stdout).toBe(
      fixture.base,
    );
    await expect(
      git.changesets.apply({ ...input, remoteSha: fixture.cloud }),
    ).resolves.toMatchObject({ state: "applied" });
    const head = (await execa("git", ["rev-parse", "HEAD"], { cwd: fixture.root })).stdout;
    const journal = JSON.parse(
      await readFile(
        path.join(fixture.root, ".git", "watt-changesets", `${input.id}.json`),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(journal).toMatchObject({
      phase: "applied",
      localSha: fixture.base,
      remoteSha: fixture.cloud,
      head,
    });
    await expect(git.changesets.preflight(input)).resolves.toEqual({
      state: "already_applied",
      localSha: fixture.base,
      remoteSha: fixture.cloud,
      head,
    });
  }, 15_000);

  it("refuses a dirty local workspace", async () => {
    const fixture = await repository();
    await writeFile(path.join(fixture.root, "dirty.txt"), "dirty\n");
    await expect(
      createGit().changesets.preflight({
        id: "changeset-5678",
        repoRoot: fixture.root,
        worktreePath: fixture.root,
        remote: ".",
        branch: "watt/cloud/test",
        expectedLocalSha: fixture.base,
      }),
    ).rejects.toMatchObject({ code: "local_workspace_dirty" });
  });

  it("preflights conflicts without touching the worktree and aborts resolution to the exact HEAD", async () => {
    const fixture = await repository();
    await writeFile(path.join(fixture.root, "base.txt"), "local\n");
    await execa("git", ["add", "."], { cwd: fixture.root });
    await execa("git", ["commit", "-m", "local conflict"], {
      cwd: fixture.root,
    });
    const localSha = (await execa("git", ["rev-parse", "HEAD"], { cwd: fixture.root })).stdout;
    await execa("git", ["switch", "watt/cloud/test"], {
      cwd: fixture.root,
    });
    await writeFile(path.join(fixture.root, "base.txt"), "cloud\n");
    await execa("git", ["add", "."], { cwd: fixture.root });
    await execa("git", ["commit", "-m", "cloud conflict"], {
      cwd: fixture.root,
    });
    const remoteSha = (await execa("git", ["rev-parse", "HEAD"], { cwd: fixture.root })).stdout;
    await execa("git", ["switch", "main"], { cwd: fixture.root });
    const input = {
      id: "changeset-conflict",
      repoRoot: fixture.root,
      worktreePath: fixture.root,
      remote: ".",
      branch: "watt/cloud/test",
      expectedLocalSha: localSha,
      expectedRemoteSha: remoteSha,
    };
    const git = createGit();

    await expect(git.changesets.preflight(input)).resolves.toEqual({
      state: "conflicted",
      localSha,
      remoteSha,
    });
    expect(
      (
        await execa("git", ["status", "--porcelain=v1"], {
          cwd: fixture.root,
        })
      ).stdout,
    ).toBe("");
    await expect(git.changesets.resolve({ ...input, remoteSha })).resolves.toEqual({
      state: "resolving",
      head: localSha,
    });
    await expect(git.changesets.resolve({ ...input, remoteSha })).resolves.toEqual({
      state: "resolving",
      head: localSha,
    });
    await expect(
      git.changesets.abort({
        id: input.id,
        repoRoot: fixture.root,
        worktreePath: fixture.root,
        expectedLocalSha: localSha,
      }),
    ).resolves.toEqual({ state: "aborted", head: localSha });
    await expect(
      git.changesets.abort({
        id: input.id,
        repoRoot: fixture.root,
        worktreePath: fixture.root,
        expectedLocalSha: localSha,
      }),
    ).resolves.toEqual({ state: "aborted", head: localSha });
    expect(
      (
        await execa("git", ["status", "--porcelain=v1"], {
          cwd: fixture.root,
        })
      ).stdout,
    ).toBe("");
  }, 15_000);
});

describe("cloud seed publication", () => {
  it("publishes an unpushed clean HEAD to a temporary seed ref", async () => {
    const fixture = await repository();
    const bare = await mkdtemp(path.join(os.tmpdir(), "watt-seed-remote-"));
    temporary.push(bare);
    await execa("git", ["init", "--bare"], { cwd: bare });
    await execa("git", ["remote", "add", "origin", bare], {
      cwd: fixture.root,
    });
    await execa("git", ["push", "origin", "main"], { cwd: fixture.root });
    await writeFile(path.join(fixture.root, "local.txt"), "local only\n");
    await execa("git", ["add", "."], { cwd: fixture.root });
    await execa("git", ["commit", "-m", "local only"], {
      cwd: fixture.root,
    });
    const head = (await execa("git", ["rev-parse", "HEAD"], { cwd: fixture.root })).stdout;

    await expect(
      createGit().cloudSeed.prepare({
        id: "seed-12345678",
        repoRoot: fixture.root,
        worktreePath: fixture.root,
      }),
    ).resolves.toEqual({
      baseSha: head,
      baseRef: "watt/seed/seed-12345678",
      seedRef: "watt/seed/seed-12345678",
    });
    expect(
      (await execa("git", ["rev-parse", "refs/heads/watt/seed/seed-12345678"], { cwd: bare }))
        .stdout,
    ).toBe(head);
  }, 15_000);
});
