import { describe, expect, it, vi } from "vitest";

import { createAgent } from "./create-agent.js";
import { asAgentEvent, mapSdkMessage, mapUnknownSdkMessage } from "./events.js";
import { createSdkRuntime } from "./sdk-runtime.js";
import { WATT_WORKSPACE_INFO_TOOL } from "./tools.js";
import type {
  CreateRuntimeInput,
  CursorRuntime,
  ResumeRuntimeInput,
  SdkStreamMessage,
} from "./types.js";

const sdk = vi.hoisted(() => ({
  loads: 0,
  creates: 0,
  gets: 0,
  closes: 0,
  createOptions: [] as unknown[],
  resumeOptions: [] as unknown[],
  sendOptions: [] as unknown[],
}));

vi.mock("@cursor/sdk", () => {
  sdk.loads += 1;
  return {
    Agent: {
      async create(options: unknown) {
        sdk.creates += 1;
        sdk.createOptions.push(options);
        return {
          agentId: `runtime-${sdk.creates}`,
          async [Symbol.asyncDispose]() {
            sdk.closes += 1;
          },
          async send(_prompt: string, options: unknown) {
            sdk.sendOptions.push(options);
            return {
              id: `sdk-run-${sdk.creates}`,
              agentId: `runtime-${sdk.creates}`,
              async *stream() {},
              wait: async () => ({
                status: "finished",
                result: "done",
                durationMs: 7,
              }),
              cancel: async () => undefined,
            };
          },
        };
      },
      async resume(_agentId: string, options: unknown) {
        sdk.resumeOptions.push(options);
        return {
          agentId: "runtime-resumed",
          async [Symbol.asyncDispose]() {
            sdk.closes += 1;
          },
          async send(_prompt: string, options: unknown) {
            sdk.sendOptions.push(options);
            return {
              id: "sdk-run-resumed",
              agentId: "runtime-resumed",
              async *stream() {},
              wait: async () => ({ status: "finished" }),
              cancel: async () => undefined,
            };
          },
        };
      },
      async getRun(runId: string) {
        sdk.gets += 1;
        return {
          id: runId,
          agentId: "runtime-recovered",
          async *stream() {},
          wait: async () => ({ status: "finished", result: "recovered" }),
          cancel: async () => undefined,
        };
      },
    },
    Cursor: {
      models: {
        async list() {
          return [
            {
              id: "composer-2.5",
              displayName: "Composer",
              aliases: ["composer"],
              parameters: [
                {
                  id: "effort",
                  displayName: "Effort",
                  values: [{ value: "high", displayName: "High" }],
                },
              ],
              variants: [
                {
                  params: [{ id: "effort", value: "high" }],
                  displayName: "High",
                  isDefault: true,
                },
              ],
            },
          ];
        },
      },
    },
  };
});

const workspace = {
  workspaceId: "ws_1",
  projectId: "proj_1",
  worktreePath: "/tmp/wt",
  branch: "watt/one",
  slug: "one",
};

const model = { id: "composer-2.5", params: [{ id: "effort", value: "high" }] };
const executionPolicy = {
  autoReview: false,
  sandbox: { enabled: false },
  agentRetries: true,
  toolAllowlist: ["read", "mcp"],
  toolDenylist: ["shell"],
  settingSources: ["project", "user", "plugins"] as const,
};

function messages(...items: SdkStreamMessage[]): AsyncIterable<SdkStreamMessage> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of items) {
        yield item;
      }
    },
  };
}

function mockRuntime(): CursorRuntime & {
  created: CreateRuntimeInput[];
  resumed: ResumeRuntimeInput[];
  recovered: string[];
  idempotencyKeys: string[];
} {
  const created: CreateRuntimeInput[] = [];
  const resumed: ResumeRuntimeInput[] = [];
  const recovered: string[] = [];
  const idempotencyKeys: string[] = [];
  return {
    created,
    resumed,
    recovered,
    idempotencyKeys,
    async listModels() {
      return [
        {
          id: model.id,
          displayName: "Composer",
          aliases: [],
          parameters: [],
          variants: [],
        },
      ];
    },
    async create(input) {
      created.push(input);
      return {
        agentId: "agent_new",
        async send(_prompt, options) {
          if (options?.idempotencyKey) {
            idempotencyKeys.push(options.idempotencyKey);
          }
          return {
            cursorRunId: "run-new",
            stream: () =>
              messages(
                {
                  type: "assistant",
                  message: { content: [{ type: "text", text: "hello" }] },
                },
                {
                  type: "tool_call",
                  call_id: "c1",
                  name: "read",
                  status: "running",
                  args: { path: "a.ts" },
                },
                {
                  type: "tool_call",
                  call_id: "c1",
                  name: "read",
                  status: "completed",
                  result: "ok",
                },
                { type: "status", status: "FINISHED" },
              ),
            wait: async () => ({ status: "finished" as const }),
            cancel: async () => undefined,
          };
        },
      };
    },
    async resume(input) {
      resumed.push(input);
      return {
        agentId: input.agentId,
        async send() {
          return {
            cursorRunId: "run-resumed",
            stream: () =>
              messages({
                type: "assistant",
                message: { content: [{ type: "text", text: "again" }] },
              }),
            wait: async () => ({ status: "finished" as const }),
            cancel: async () => undefined,
          };
        },
      };
    },
    async getRun(input) {
      recovered.push(input.cursorRunId);
      return {
        cursorRunId: input.cursorRunId,
        stream: () => messages(),
        wait: async () => ({ status: "finished" as const }),
        cancel: async () => undefined,
      };
    },
  };
}

describe("mapSdkMessage", () => {
  it("maps assistant, tool, and status events", () => {
    expect(
      mapSdkMessage({
        type: "assistant",
        message: { content: [{ type: "text", text: "hi" }] },
      }),
    ).toEqual([{ type: "text_delta", text: "hi" }]);
    expect(
      mapSdkMessage({
        type: "tool_call",
        call_id: "1",
        name: "edit",
        status: "running",
        args: {},
      }),
    ).toEqual([{ type: "tool_call", callId: "1", name: "edit", args: {} }]);
    const structuredResult = {
      content: [{ type: "text", text: "failed" }],
      structuredContent: { answer: 42 },
      isError: true,
    };
    expect(
      mapSdkMessage({
        type: "tool_call",
        call_id: "1",
        name: "structured",
        status: "error",
        result: structuredResult,
      }),
    ).toEqual([
      {
        type: "tool_result",
        callId: "1",
        name: "structured",
        result: structuredResult,
        ok: false,
      },
    ]);
    expect(mapSdkMessage({ type: "user" })).toEqual([]);
  });

  it("ignores unknown and malformed SDK messages", () => {
    expect(mapUnknownSdkMessage({ type: "future_event", text: "ignored" })).toEqual([]);
    expect(
      mapUnknownSdkMessage({
        type: "tool_call",
        call_id: 1,
        name: "read",
        status: "running",
      }),
    ).toEqual([]);
    expect(mapUnknownSdkMessage({ type: "status", status: 1 })).toEqual([]);
  });

  it("recognizes Watt AgentEvents without treating SDK tool_call as one", () => {
    expect(
      asAgentEvent({
        type: "tool_call",
        callId: "c1",
        name: "read",
        args: null,
      }),
    ).toEqual({
      type: "tool_call",
      callId: "c1",
      name: "read",
      args: null,
    });
    expect(
      asAgentEvent({
        type: "tool_call",
        call_id: "c1",
        name: "read",
        status: "running",
      }),
    ).toBeNull();
  });
});

describe("createAgent", () => {
  it("uses mocked runtime, default settingSources, and re-passes custom tools on resume", async () => {
    const runtime = mockRuntime();
    const agent = createAgent({
      runtime,
      apiKey: "secret-key-should-not-appear",
    });
    const session = await agent.create({
      cwd: "/tmp/wt",
      workspace,
      model,
      mode: "plan",
      executionPolicy,
    });
    const run = await session.send("go", { idempotencyKey: "watt-run-1" });
    expect(run.cursorRunId).toBe("run-new");
    expect(runtime.idempotencyKeys).toEqual(["watt-run-1"]);
    const events = [];
    for await (const event of run.stream()) {
      events.push(event);
    }
    expect(events.map((event) => event.type)).toEqual([
      "text_delta",
      "tool_call",
      "tool_result",
      "status",
    ]);
    expect(runtime.created[0]?.executionPolicy.settingSources).toEqual([
      "project",
      "user",
      "plugins",
    ]);
    expect(
      runtime.created[0]?.customTools.some((tool) => tool.name === WATT_WORKSPACE_INFO_TOOL),
    ).toBe(true);
    expect(runtime.created[0]).toMatchObject({
      model,
      mode: "plan",
      executionPolicy: {
        sandbox: { enabled: false },
        agentRetries: true,
        toolAllowlist: ["read", "mcp"],
        toolDenylist: ["shell"],
      },
    });
    expect(
      events.every((event) => !JSON.stringify(event).includes("secret-key-should-not-appear")),
    ).toBe(true);

    const resumed = await agent.resume({
      cwd: "/tmp/wt",
      workspace,
      model,
      mode: "plan",
      executionPolicy,
      cursorAgentId: "agent_new",
    });
    expect(resumed.cursorAgentId).toBe("agent_new");
    expect(
      runtime.resumed[0]?.customTools.some((tool) => tool.name === WATT_WORKSPACE_INFO_TOOL),
    ).toBe(true);

    const recovered = await agent.getRun({
      cursorRunId: "run-existing",
      cwd: "/tmp/wt",
    });
    expect(recovered.cursorRunId).toBe("run-existing");
    expect(runtime.recovered).toEqual(["run-existing"]);
  });

  it("detaches an aborted stream without waiting for or cancelling the run", async () => {
    const wait = vi.fn(async () => ({ status: "finished" as const }));
    const cancel = vi.fn(async () => undefined);
    const detach = vi.fn(async () => undefined);
    const providerRun = {
      cursorRunId: "durable-run",
      async *stream() {
        yield { type: "text_delta" as const, text: "started" };
        await new Promise<void>(() => {});
      },
      wait,
      cancel,
      detach,
    };
    const runtime: CursorRuntime = {
      async listModels() {
        return [];
      },
      async create() {
        return {
          agentId: "durable-session",
          async send() {
            return providerRun;
          },
        };
      },
      async resume() {
        throw new Error("unused");
      },
      async getRun() {
        return providerRun;
      },
    };
    const session = await createAgent({ runtime }).create({
      cwd: "/tmp/wt",
      workspace,
      model,
    });
    const run = await session.send("go");
    const controller = new AbortController();
    const iterator = run.stream({ signal: controller.signal })[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: "text_delta", text: "started" },
    });
    const pending = iterator.next();
    controller.abort();
    await expect(pending).resolves.toEqual({ done: true, value: undefined });

    const betweenReadsController = new AbortController();
    const betweenReadsIterator = run
      .stream({ signal: betweenReadsController.signal })
      [Symbol.asyncIterator]();
    await expect(betweenReadsIterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: "text_delta", text: "started" },
    });
    betweenReadsController.abort();
    await expect(betweenReadsIterator.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
    expect(wait).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(detach).toHaveBeenCalledTimes(2);
  });
});

describe("createSdkRuntime", () => {
  it("defers and shares the SDK module import across concurrent first use", async () => {
    expect(sdk.loads).toBe(0);
    const runtime = createSdkRuntime();
    expect(sdk.loads).toBe(0);

    expect(await runtime.listModels()).toEqual([
      expect.objectContaining({
        id: "composer-2.5",
        parameters: [expect.objectContaining({ id: "effort" })],
        variants: [expect.objectContaining({ isDefault: true })],
      }),
    ]);

    await Promise.all([
      runtime.create({
        cwd: "/tmp/wt-a",
        model,
        mode: "plan",
        executionPolicy: {
          ...executionPolicy,
          settingSources: [...executionPolicy.settingSources],
        },
        customTools: [],
      }),
      runtime.create({
        cwd: "/tmp/wt-b",
        model,
        mode: "agent",
        executionPolicy: {
          ...executionPolicy,
          settingSources: [...executionPolicy.settingSources],
        },
        customTools: [],
      }),
    ]);

    expect(sdk.loads).toBe(1);
    expect(sdk.creates).toBe(2);
    expect(sdk.createOptions[0]).toMatchObject({
      model,
      mode: "plan",
      tools: ["read", "mcp"],
      disallowedTools: ["shell"],
      local: {
        autoReview: false,
        sandboxOptions: { enabled: false },
        enableAgentRetries: true,
      },
    });
    const resumed = await runtime.resume({
      agentId: "existing-agent",
      cwd: "/tmp/wt-a",
      model,
      mode: "plan",
      executionPolicy: {
        ...executionPolicy,
        settingSources: [...executionPolicy.settingSources],
      },
      customTools: [],
    });
    expect(sdk.resumeOptions.at(-1)).toMatchObject({
      model,
      mode: "plan",
      tools: ["read", "mcp"],
      disallowedTools: ["shell"],
      local: {
        sandboxOptions: { enabled: false },
        enableAgentRetries: true,
      },
    });
    const resumedRun = await resumed.send("resumed follow-up");
    expect(sdk.sendOptions.at(-1)).toMatchObject({ model, mode: "plan" });
    await resumedRun.detach?.();
    expect(sdk.closes).toBe(1);

    const run = await runtime.getRun({
      cursorRunId: "sdk-existing",
      cwd: "/tmp/wt-a",
    });
    expect(run.cursorRunId).toBe("sdk-existing");
    expect(await run.wait()).toMatchObject({
      status: "finished",
      result: "recovered",
    });
    expect(sdk.gets).toBe(1);
    await run.detach?.();
    expect(sdk.closes).toBe(2);
  });

  it("preserves custom-tool schemas, context, structured results, and follow-up options", async () => {
    const runtime = createSdkRuntime();
    let receivedContext: unknown;
    const handle = await runtime.create({
      cwd: "/tmp/wt-tools",
      model,
      mode: "plan",
      executionPolicy: {
        ...executionPolicy,
        settingSources: [...executionPolicy.settingSources],
      },
      customTools: [
        {
          name: "structured",
          description: "structured result",
          outputSchema: {
            type: "object",
            properties: { answer: { type: "number" } },
          },
          execute(_args, context) {
            receivedContext = context;
            return {
              content: [{ type: "text", text: "failed" }],
              structuredContent: { answer: 42 },
              isError: true,
            };
          },
        },
      ],
    });
    const created = sdk.createOptions.at(-1) as {
      local: {
        customTools: Record<
          string,
          {
            outputSchema?: unknown;
            execute: (
              args: Record<string, never>,
              context: { toolCallId?: string },
            ) => Promise<unknown>;
          }
        >;
      };
    };
    const tool = created.local.customTools.structured;
    expect(tool?.outputSchema).toEqual({
      type: "object",
      properties: { answer: { type: "number" } },
    });
    await expect(tool?.execute({}, { toolCallId: "call-1" })).resolves.toEqual({
      content: [{ type: "text", text: "failed" }],
      structuredContent: { answer: 42 },
      isError: true,
    });
    expect(receivedContext).toEqual({ toolCallId: "call-1" });

    await handle.send("continue", { idempotencyKey: "follow-up" });
    expect(sdk.sendOptions.at(-1)).toMatchObject({
      idempotencyKey: "follow-up",
      model,
      mode: "plan",
      local: { customTools: { structured: expect.any(Object) } },
    });
  });
});
