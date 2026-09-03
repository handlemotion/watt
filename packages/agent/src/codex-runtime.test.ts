import { describe, expect, it } from "vitest";

import { createAgent } from "./create-agent.js";
import { DEFAULT_CODEX_CATALOG } from "./codex-catalog.js";
import { mapCodexStreamEvent } from "./codex-events.js";
import { createCodexRuntime, type CodexClient } from "./codex-runtime.js";
import { AgentError } from "./errors.js";
import type { CreateRuntimeInput } from "./types.js";

const workspace = {
  workspaceId: "ws_1",
  projectId: "proj_1",
  worktreePath: "/tmp/wt",
  branch: "watt/one",
  slug: "one",
};

const executionPolicy = {
  autoReview: false,
  sandbox: { enabled: false },
  agentRetries: true,
  toolAllowlist: null,
  toolDenylist: [],
  settingSources: ["project", "user", "plugins"] as const,
};

function input(overrides?: Partial<CreateRuntimeInput>): CreateRuntimeInput {
  return {
    cwd: "/tmp/wt",
    model: { id: "codex:gpt-5.5", params: [] },
    mode: "agent",
    executionPolicy,
    customTools: [],
    ...overrides,
  };
}

const officialTurnEvents = [
  {
    type: "item.completed",
    item: { id: "msg-1", type: "agent_message", text: "hello" },
  },
  {
    type: "item.started",
    item: {
      id: "cmd-1",
      type: "command_execution",
      command: "ls",
      aggregated_output: "",
      status: "in_progress",
    },
  },
  {
    type: "item.completed",
    item: {
      id: "cmd-1",
      type: "command_execution",
      command: "ls",
      aggregated_output: "ok",
      status: "completed",
    },
  },
  {
    type: "turn.completed",
    usage: {
      input_tokens: 1,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
      output_tokens: 1,
      reasoning_output_tokens: 0,
    },
  },
];

function mockClient(options?: { authError?: boolean; events?: unknown[] }): CodexClient {
  const events = options?.events ?? officialTurnEvents;
  function thread(id: string) {
    return {
      id,
      async runStreamed() {
        if (options?.authError) {
          throw new Error("401 Unauthorized — run codex login");
        }
        return {
          events: (async function* () {
            for (const event of events) yield event;
          })(),
        };
      },
    };
  }
  function expectThreadOptions(threadOptions: {
    workingDirectory?: string;
    approvalPolicy?: string;
    sandboxMode?: string;
    model?: string;
  }) {
    expect(threadOptions.workingDirectory).toBe("/tmp/wt");
    expect(threadOptions.approvalPolicy).toBe("never");
    expect(threadOptions.sandboxMode).toBe("danger-full-access");
  }
  return {
    startThread(threadOptions) {
      if (options?.authError) {
        throw new Error("not logged in");
      }
      expectThreadOptions(threadOptions);
      expect(threadOptions.model).toBe("gpt-5.5");
      return thread("thread-1");
    },
    resumeThread(threadId, threadOptions) {
      expect(threadId).toBe("saved-thread");
      if (threadOptions) expectThreadOptions(threadOptions);
      return thread(threadId);
    },
  };
}

describe("createCodexRuntime", () => {
  it("lists namespaced models without loading the Codex SDK", async () => {
    const runtime = createCodexRuntime({
      client: {
        startThread() {
          throw new Error("should not start");
        },
        resumeThread() {
          throw new Error("should not resume");
        },
      },
    });
    const models = await runtime.listModels();
    expect(models.map((model) => model.id)).toEqual(DEFAULT_CODEX_CATALOG.map((model) => model.id));
    expect(models[0]?.id.startsWith("codex:")).toBe(true);
  });

  it("maps streamed Codex items and ignores custom tools", async () => {
    const runtime = createCodexRuntime({ client: mockClient() });
    const handle = await runtime.create(input());
    expect(handle.agentId).toBe("thread-1");
    const run = await handle.send("go", { idempotencyKey: "watt-run-1" });
    const events = [];
    for await (const event of run.stream()) events.push(event);
    expect(events).toEqual([
      { type: "text_delta", text: "hello" },
      {
        type: "tool_call",
        callId: "cmd-1",
        name: "command_execution",
        args: "ls",
      },
      {
        type: "tool_result",
        callId: "cmd-1",
        name: "command_execution",
        result: "ok",
        ok: true,
      },
      { type: "status", status: "turn_completed" },
    ]);
    await expect(run.wait()).resolves.toMatchObject({
      status: "finished",
      result: "hello",
    });
  });

  it("preserves Codex AgentEvents through createAgent.stream", async () => {
    const agent = createAgent({
      runtime: createCodexRuntime({ client: mockClient() }),
    });
    const session = await agent.create({
      cwd: "/tmp/wt",
      model: { id: "codex:gpt-5.5", params: [] },
      workspace,
    });
    const run = await session.send("go");
    const events = [];
    for await (const event of run.stream()) events.push(event);
    expect(events.map((event) => event.type)).toEqual([
      "text_delta",
      "tool_call",
      "tool_result",
      "status",
    ]);
  });

  it("rejects plan mode and maps auth failures", async () => {
    const runtime = createCodexRuntime({
      client: mockClient({ authError: true }),
    });
    await expect(runtime.create(input({ mode: "plan" }))).rejects.toMatchObject({
      code: "mode_unsupported",
    });
    await expect(runtime.create(input())).rejects.toBeInstanceOf(AgentError);
    await expect(runtime.create(input())).rejects.toMatchObject({
      code: "codex_auth_unavailable",
    });
  });

  it("maps turn.failed auth errors onto wait()", async () => {
    const runtime = createCodexRuntime({
      client: mockClient({
        events: [
          {
            type: "turn.failed",
            error: { message: "401 Unauthorized — run codex login" },
          },
        ],
      }),
    });
    const handle = await runtime.create(input());
    const run = await handle.send("go");
    const events = [];
    for await (const event of run.stream()) events.push(event);
    expect(events).toEqual([
      {
        type: "error",
        message: "Codex is not signed in with ChatGPT. Run `codex login`.",
      },
    ]);
    await expect(run.wait()).resolves.toMatchObject({
      status: "error",
      error: { code: "codex_auth_unavailable" },
    });
  });

  it("resumes by thread id through createAgent", async () => {
    const agent = createAgent({
      runtime: createCodexRuntime({ client: mockClient() }),
    });
    const session = await agent.resume({
      cwd: "/tmp/wt",
      model: { id: "codex:gpt-5.4", params: [] },
      mode: "agent",
      workspace,
      cursorAgentId: "saved-thread",
    });
    expect(session.cursorAgentId).toBe("saved-thread");
  });
});

describe("mapCodexStreamEvent", () => {
  it("ignores unknown event types", () => {
    expect(mapCodexStreamEvent({ type: "thread.started" })).toEqual([]);
  });

  it("reads turn.failed error.message", () => {
    expect(
      mapCodexStreamEvent({
        type: "turn.failed",
        error: { message: "model overloaded" },
      }),
    ).toEqual([{ type: "error", message: "model overloaded" }]);
  });
});
