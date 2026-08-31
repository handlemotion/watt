import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Host } from "@watt/host";

const mocked = vi.hoisted(() => ({ createHost: vi.fn() }));

vi.mock("@watt/host", () => ({ createHost: mocked.createHost }));

import { runCli } from "./program.js";

function host(): Host {
  return {
    capabilities: vi.fn(),
    close: vi.fn(async () => undefined),
    suspend: vi.fn(async () => undefined),
    projects: {
      register: vi.fn(),
      get: vi.fn(),
      list: vi.fn(),
      reconcile: vi.fn(),
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
      wait: vi.fn(async () => ({
        runId: "run-1",
        status: "finished" as const,
      })),
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

  it("suspends the host when project registration fails", async () => {
    const instance = host();
    vi.mocked(instance.projects.register).mockRejectedValue(
      new Error("register failed"),
    );
    mocked.createHost.mockResolvedValue(instance);

    await expect(
      runCli(["node", "watt", "--repo", "/tmp/repo", "worktree", "ls"]),
    ).rejects.toThrow("register failed");
    expect(instance.suspend).toHaveBeenCalledOnce();
    expect(instance.close).not.toHaveBeenCalled();
  });

  it("suspends the host when command execution fails", async () => {
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
    expect(instance.suspend).toHaveBeenCalledOnce();
  });

  it("waits for asynchronous host cleanup before resolving a command", async () => {
    const instance = host();
    let release!: () => void;
    vi.mocked(instance.suspend).mockImplementation(
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
    await vi.waitFor(() => expect(instance.suspend).toHaveBeenCalledOnce());
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
    expect(instance.suspend).toHaveBeenCalledOnce();
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
    expect(instance.suspend).toHaveBeenCalledOnce();
  });

  it("rejects detached Codex sessions before enqueueing work", async () => {
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
        "chatgpt",
        "--detach",
      ]),
    ).rejects.toThrow("Codex sessions do not support --detach");
    expect(mocked.createHost).not.toHaveBeenCalled();

    const instance = host();
    vi.mocked(instance.sessions.get).mockReturnValue({
      runtime: "codex-local",
    } as never);
    mocked.createHost.mockResolvedValue(instance);
    await expect(
      runCli([
        "node",
        "watt",
        "agent",
        "send",
        "--session",
        "session-1",
        "--prompt",
        "continue",
        "--detach",
      ]),
    ).rejects.toThrow("Codex sessions do not support --detach");
    expect(instance.sessions.send).not.toHaveBeenCalled();
    expect(instance.suspend).toHaveBeenCalledOnce();
  });

  it("sends follow-ups through the persisted session runtime", async () => {
    const instance = host();
    vi.mocked(instance.sessions.send).mockResolvedValue({
      session: { id: "session-1" } as never,
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
      "--session",
      "session-1",
      "--prompt",
      "continue",
    ]);

    expect(instance.sessions.send).toHaveBeenCalledWith({
      sessionId: "session-1",
      prompt: "continue",
    });
    expect(instance.sessions.create).not.toHaveBeenCalled();
    expect(instance.suspend).toHaveBeenCalledOnce();
  });

  it("detaches only after dispatch is durable and then suspends", async () => {
    const instance = host();
    vi.mocked(instance.sessions.create).mockResolvedValue({
      session: { id: "session-1" } as never,
      run: { id: "run-1" } as never,
    });
    vi.mocked(instance.runs.get)
      .mockReturnValueOnce({ id: "run-1", status: "queued" } as never)
      .mockReturnValueOnce({ id: "run-1", status: "running" } as never);
    mocked.createHost.mockResolvedValue(instance);
    const output = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    try {
      await runCli([
        "node",
        "watt",
        "agent",
        "send",
        "--workspace",
        "workspace-1",
        "--prompt",
        "go",
        "--detach",
      ]);
      expect(output).toHaveBeenCalledWith(
        '{"sessionId":"session-1","runId":"run-1"}\n',
      );
    } finally {
      output.mockRestore();
    }

    expect(instance.runs.get).toHaveBeenCalledTimes(2);
    expect(instance.runs.attach).not.toHaveBeenCalled();
    expect(instance.runs.wait).not.toHaveBeenCalled();
    expect(instance.suspend).toHaveBeenCalledOnce();
  });

  it("surfaces a terminal dispatch failure instead of reporting detach success", async () => {
    const instance = host();
    vi.mocked(instance.sessions.create).mockResolvedValue({
      session: { id: "session-1" } as never,
      run: { id: "run-1" } as never,
    });
    vi.mocked(instance.runs.get).mockReturnValue({
      id: "run-1",
      status: "error",
    } as never);
    vi.mocked(instance.runs.wait).mockResolvedValue({
      runId: "run-1",
      status: "error",
      error: {
        code: "run_dispatch_failed",
        message: "provider unavailable",
      },
    });
    mocked.createHost.mockResolvedValue(instance);
    const output = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    try {
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
          "--detach",
        ]),
      ).rejects.toThrow("run failed before detach: provider unavailable");
      expect(output).not.toHaveBeenCalled();
    } finally {
      output.mockRestore();
    }

    expect(instance.suspend).toHaveBeenCalledOnce();
  });

  it("reattaches after an event sequence and supports explicit cancellation", async () => {
    const instance = host();
    vi.mocked(instance.runs.attach).mockReturnValue({
      async *[Symbol.asyncIterator]() {},
    });
    vi.mocked(instance.runs.cancel).mockResolvedValue({
      runId: "run-2",
      status: "cancelled",
    });
    mocked.createHost.mockResolvedValue(instance);

    await runCli([
      "node",
      "watt",
      "run",
      "attach",
      "--run",
      "run-1",
      "--after-sequence",
      "7",
    ]);
    await runCli(["node", "watt", "run", "cancel", "--run", "run-2"]);

    expect(instance.runs.attach).toHaveBeenCalledWith({
      runId: "run-1",
      afterSequence: 7,
    });
    expect(instance.runs.cancel).toHaveBeenCalledWith({ runId: "run-2" });
  });

  it("routes capability, listing, reconciliation, and operation diagnostics", async () => {
    const instance = host();
    vi.mocked(instance.capabilities).mockResolvedValue({} as never);
    vi.mocked(instance.projects.reconcile).mockResolvedValue({} as never);
    vi.mocked(instance.sessions.list).mockReturnValue([]);
    vi.mocked(instance.runs.list).mockReturnValue([]);
    vi.mocked(instance.diagnostics.operations.list).mockReturnValue([]);
    mocked.createHost.mockResolvedValue(instance);
    const output = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    try {
      await runCli(["node", "watt", "capabilities"]);
      await runCli([
        "node",
        "watt",
        "project",
        "reconcile",
        "--project",
        "project-1",
      ]);
      await runCli([
        "node",
        "watt",
        "agent",
        "ls",
        "--workspace",
        "workspace-1",
      ]);
      await runCli(["node", "watt", "run", "ls", "--session", "session-1"]);
      await runCli([
        "node",
        "watt",
        "operation",
        "ls",
        "--project",
        "project-1",
        "--include-completed",
      ]);
    } finally {
      output.mockRestore();
    }

    expect(instance.capabilities).toHaveBeenCalledOnce();
    expect(instance.projects.reconcile).toHaveBeenCalledWith({
      projectId: "project-1",
    });
    expect(instance.sessions.list).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
    });
    expect(instance.runs.list).toHaveBeenCalledWith({
      sessionId: "session-1",
    });
    expect(instance.diagnostics.operations.list).toHaveBeenCalledWith({
      projectId: "project-1",
      includeCompleted: true,
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
