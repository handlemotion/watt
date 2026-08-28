import { describe, expect, it, vi } from "vitest";

import { createAgent } from "./create-agent.js";
import { mapSdkMessage, mapUnknownSdkMessage } from "./events.js";
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
}));

vi.mock("@cursor/sdk", () => {
  sdk.loads += 1;
  return {
    Agent: {
      async create() {
        sdk.creates += 1;
        return {
          agentId: `runtime-${sdk.creates}`,
          async send() {
            return {
              id: `sdk-run-${sdk.creates}`,
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
      async resume() {
        throw new Error("not used by this test");
      },
      async getRun(runId: string) {
        sdk.gets += 1;
        return {
          id: runId,
          async *stream() {},
          wait: async () => ({ status: "finished", result: "recovered" }),
          cancel: async () => undefined,
        };
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

function messages(
  ...items: SdkStreamMessage[]
): AsyncIterable<SdkStreamMessage> {
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
    expect(mapSdkMessage({ type: "user" })).toEqual([]);
  });

  it("ignores unknown and malformed SDK messages", () => {
    expect(
      mapUnknownSdkMessage({ type: "future_event", text: "ignored" }),
    ).toEqual([]);
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
});

describe("createAgent", () => {
  it("uses mocked runtime, default settingSources, and re-passes custom tools on resume", async () => {
    const runtime = mockRuntime();
    const agent = createAgent({
      runtime,
      apiKey: "secret-key-should-not-appear",
    });
    const session = await agent.create({ cwd: "/tmp/wt", workspace });
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
    expect(runtime.created[0]?.settingSources).toEqual([
      "project",
      "user",
      "plugins",
    ]);
    expect(
      runtime.created[0]?.customTools.some(
        (tool) => tool.name === WATT_WORKSPACE_INFO_TOOL,
      ),
    ).toBe(true);
    expect(
      events.every(
        (event) =>
          !JSON.stringify(event).includes("secret-key-should-not-appear"),
      ),
    ).toBe(true);

    const resumed = await agent.resume({
      cwd: "/tmp/wt",
      workspace,
      cursorAgentId: "agent_new",
    });
    expect(resumed.cursorAgentId).toBe("agent_new");
    expect(
      runtime.resumed[0]?.customTools.some(
        (tool) => tool.name === WATT_WORKSPACE_INFO_TOOL,
      ),
    ).toBe(true);

    const recovered = await agent.getRun({
      cursorRunId: "run-existing",
      cwd: "/tmp/wt",
    });
    expect(recovered.cursorRunId).toBe("run-existing");
    expect(runtime.recovered).toEqual(["run-existing"]);
  });
});

describe("createSdkRuntime", () => {
  it("defers and shares the SDK module import across concurrent first use", async () => {
    expect(sdk.loads).toBe(0);
    const runtime = createSdkRuntime();
    expect(sdk.loads).toBe(0);

    await Promise.all([
      runtime.create({
        cwd: "/tmp/wt-a",
        model: "composer-2.5",
        customTools: [],
        settingSources: ["project", "user", "plugins"],
      }),
      runtime.create({
        cwd: "/tmp/wt-b",
        model: "composer-2.5",
        customTools: [],
        settingSources: ["project", "user", "plugins"],
      }),
    ]);

    expect(sdk.loads).toBe(1);
    expect(sdk.creates).toBe(2);

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
  });
});
