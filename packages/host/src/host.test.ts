import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { WattAgent } from "@watt/agent";
import type { GitService } from "@watt/git";
import { describe, expect, it } from "vitest";

import { createHost } from "./create-host.js";

function fakeGit(): GitService & { created: string[]; archived: string[] } {
  const created: string[] = [];
  const archived: string[] = [];
  return {
    created,
    archived,
    async createWorktree(input) {
      created.push(input.worktreePath);
      await mkdir(input.worktreePath, { recursive: true });
      await writeFile(path.join(input.worktreePath, ".keep"), "");
      return {
        worktreePath: input.worktreePath,
        branch: input.branch,
        slug: input.slug,
        copied: [],
        setupRan: false,
      };
    },
    async listWorktrees() {
      throw new Error("listWorktrees must not be used by host.list");
    },
    async archiveWorktree(input) {
      archived.push(input.worktreePath);
    },
  };
}

function fakeAgent(): WattAgent & { resumes: string[] } {
  const resumes: string[] = [];
  return {
    resumes,
    async create() {
      return {
        cursorAgentId: "cursor-agent-1",
        async send() {
          return {
            async *stream() {
              yield { type: "text_delta" as const, text: "hi" };
            },
            wait: async () => ({ status: "finished" as const }),
            cancel: async () => undefined,
          };
        },
      };
    },
    async resume(input) {
      resumes.push(input.cursorAgentId);
      return {
        cursorAgentId: input.cursorAgentId,
        async send() {
          return {
            async *stream() {
              yield { type: "text_delta" as const, text: "resume" };
            },
            wait: async () => ({ status: "finished" as const }),
            cancel: async () => undefined,
          };
        },
      };
    },
  };
}

describe("createHost", () => {
  it("persists projects/workspaces/sessions and resumes by cursorAgentId", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "watt-host-"));
    const repo = path.join(root, "repo");
    await mkdir(repo);
    const git = fakeGit();
    const agent = fakeAgent();
    const host = await createHost({
      stateDir: path.join(root, "state"),
      worktreeRoot: path.join(root, "trees"),
      git,
      agent,
    });

    const project = await host.projects.register(repo);
    const workspace = await host.workspaces.create({ projectId: project.id, slug: "one" });
    expect(git.created).toHaveLength(1);
    expect(host.workspaces.list({ projectId: project.id })).toHaveLength(1);

    const created = await host.sessions.create({ workspaceId: workspace.id, prompt: "hello" });
    const firstEvents = [];
    for await (const event of created.events) {
      firstEvents.push(event);
    }
    expect(firstEvents[0]).toMatchObject({
      type: "text_delta",
      workspaceId: workspace.id,
      sessionId: created.session.id,
    });

    host.close();

    const host2 = await createHost({
      stateDir: path.join(root, "state"),
      worktreeRoot: path.join(root, "trees"),
      git,
      agent,
    });
    const listed = host2.sessions.list({ workspaceId: workspace.id });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.cursorAgentId).toBe("cursor-agent-1");

    const sent = await host2.sessions.send({ sessionId: listed[0]?.id ?? "", prompt: "again" });
    expect(agent.resumes).toEqual(["cursor-agent-1"]);
    const resumeEvents = [];
    for await (const event of sent.events) {
      resumeEvents.push(event);
    }
    expect(resumeEvents[0]?.type).toBe("text_delta");
    host2.close();
  });

  it("rejects path-escaping slugs and retries archive against git", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "watt-host-"));
    const repo = path.join(root, "repo");
    await mkdir(repo);
    const git = fakeGit();
    const agent = fakeAgent();
    const host = await createHost({
      stateDir: path.join(root, "state"),
      worktreeRoot: path.join(root, "trees"),
      git,
      agent,
    });
    const project = await host.projects.register(repo);
    await expect(
      host.workspaces.create({ projectId: project.id, slug: "../escape" }),
    ).rejects.toMatchObject({ code: "invalid_slug" });
    expect(git.created).toHaveLength(0);

    const workspace = await host.workspaces.create({ projectId: project.id, slug: "one" });
    await host.workspaces.archive({ workspaceId: workspace.id });
    await host.workspaces.archive({ workspaceId: workspace.id });
    expect(git.archived).toHaveLength(2);
    host.close();
  });
});
