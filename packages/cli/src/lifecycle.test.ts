import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Host } from "@watt/host";

const mocked = vi.hoisted(() => ({ createHost: vi.fn() }));

vi.mock("@watt/host", () => ({ createHost: mocked.createHost }));

import { runCli } from "./program.js";

function host(): Host {
  return {
    capabilities: vi.fn(),
    close: vi.fn(async () => undefined),
    projects: {
      register: vi.fn(),
      get: vi.fn(),
      list: vi.fn(),
    },
    workspaces: {
      create: vi.fn(),
      list: vi.fn(),
      get: vi.fn(),
      archive: vi.fn(),
    },
    sessions: {
      create: vi.fn(),
      send: vi.fn(),
      get: vi.fn(),
      list: vi.fn(),
    },
    runs: {
      get: vi.fn(),
      list: vi.fn(),
      wait: vi.fn(),
      cancel: vi.fn(),
      attach: vi.fn(),
    },
    diagnostics: {
      operations: {
        get: vi.fn(),
        list: vi.fn(),
      },
    },
  };
}

describe("CLI host lifetime", () => {
  beforeEach(() => {
    mocked.createHost.mockReset();
  });

  it("rejects a missing required repo before opening the host", async () => {
    await expect(runCli(["node", "watt", "worktree", "ls"])).rejects.toThrow(
      "--repo is required",
    );
    expect(mocked.createHost).not.toHaveBeenCalled();
  });

  it("closes the host when project registration fails", async () => {
    const instance = host();
    vi.mocked(instance.projects.register).mockRejectedValue(
      new Error("register failed"),
    );
    mocked.createHost.mockResolvedValue(instance);

    await expect(
      runCli(["node", "watt", "--repo", "/tmp/repo", "worktree", "ls"]),
    ).rejects.toThrow("register failed");
    expect(instance.close).toHaveBeenCalledOnce();
  });

  it("closes the host when command execution fails", async () => {
    const instance = host();
    vi.mocked(instance.projects.register).mockResolvedValue({
      id: "project",
      repoRoot: "/tmp/repo",
    });
    vi.mocked(instance.workspaces.list).mockImplementation(() => {
      throw new Error("list failed");
    });
    mocked.createHost.mockResolvedValue(instance);

    await expect(
      runCli(["node", "watt", "--repo", "/tmp/repo", "worktree", "ls"]),
    ).rejects.toThrow("list failed");
    expect(instance.close).toHaveBeenCalledOnce();
  });

  it("waits for asynchronous host cleanup before resolving a command", async () => {
    const instance = host();
    let release!: () => void;
    vi.mocked(instance.close).mockImplementation(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    vi.mocked(instance.projects.register).mockResolvedValue({
      id: "project",
      repoRoot: "/tmp/repo",
    });
    vi.mocked(instance.workspaces.list).mockReturnValue([]);
    mocked.createHost.mockResolvedValue(instance);

    let completed = false;
    const running = runCli([
      "node",
      "watt",
      "--repo",
      "/tmp/repo",
      "worktree",
      "ls",
    ]).then(() => {
      completed = true;
    });
    await vi.waitFor(() => expect(instance.close).toHaveBeenCalledOnce());
    expect(completed).toBe(false);
    release();
    await running;
    expect(completed).toBe(true);
  });

  it("passes explicit Plan mode and repeatable structured model parameters", async () => {
    const instance = host();
    vi.mocked(instance.sessions.create).mockResolvedValue({
      session: {} as never,
      run: { id: "run-1" } as never,
    });
    vi.mocked(instance.runs.attach).mockReturnValue({
      async *[Symbol.asyncIterator]() {},
    });
    mocked.createHost.mockResolvedValue(instance);

    await runCli([
      "node",
      "watt",
      "agent",
      "send",
      "--workspace",
      "workspace-1",
      "--prompt",
      "plan it",
      "--model",
      "model-a",
      "--model-param",
      "effort=high",
      "--model-param",
      "context=long",
      "--mode",
      "plan",
    ]);

    expect(instance.sessions.create).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      prompt: "plan it",
      runtime: "cursor-local",
      model: {
        id: "model-a",
        params: [
          { id: "effort", value: "high" },
          { id: "context", value: "long" },
        ],
      },
      mode: "plan",
    });
    expect(instance.close).toHaveBeenCalledOnce();
  });

  it("maps --runtime chatgpt to the Codex local runtime", async () => {
    const instance = host();
    vi.mocked(instance.sessions.create).mockResolvedValue({
      session: {} as never,
      run: { id: "run-1" } as never,
    });
    vi.mocked(instance.runs.attach).mockReturnValue({
      async *[Symbol.asyncIterator]() {},
    });
    mocked.createHost.mockResolvedValue(instance);

    await runCli([
      "node",
      "watt",
      "agent",
      "send",
      "--workspace",
      "workspace-1",
      "--prompt",
      "go",
      "--runtime",
      "chatgpt",
    ]);

    expect(instance.sessions.create).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      prompt: "go",
      runtime: "codex-local",
      model: undefined,
      mode: "agent",
    });
  });

  it("rejects an invalid --runtime before opening a Host", async () => {
    await expect(
      runCli([
        "node",
        "watt",
        "agent",
        "send",
        "--workspace",
        "workspace-1",
        "--prompt",
        "go",
        "--runtime",
        "openai",
      ]),
    ).rejects.toThrow("invalid --runtime");
    expect(mocked.createHost).not.toHaveBeenCalled();
  });

  it("rejects malformed, duplicate, and model-less parameters before opening a Host", async () => {
    await expect(
      runCli([
        "node",
        "watt",
        "agent",
        "send",
        "--workspace",
        "workspace-1",
        "--prompt",
        "go",
        "--model",
        "model-a",
        "--model-param",
        "broken",
      ]),
    ).rejects.toThrow("expected id=value");
    await expect(
      runCli([
        "node",
        "watt",
        "agent",
        "send",
        "--workspace",
        "workspace-1",
        "--prompt",
        "go",
        "--model",
        "model-a",
        "--model-param",
        "effort=low",
        "--model-param",
        "effort=high",
      ]),
    ).rejects.toThrow("duplicate --model-param: effort");
    await expect(
      runCli([
        "node",
        "watt",
        "agent",
        "send",
        "--workspace",
        "workspace-1",
        "--prompt",
        "go",
        "--model-param",
        "effort=high",
      ]),
    ).rejects.toThrow("--model is required");
    expect(mocked.createHost).not.toHaveBeenCalled();
  });
});
