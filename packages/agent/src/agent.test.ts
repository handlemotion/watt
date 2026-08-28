import { describe, expect, it } from "vitest";

import { createAgent } from "./create-agent.js";
import { mapSdkMessage } from "./events.js";
import { WATT_WORKSPACE_INFO_TOOL } from "./tools.js";
import type { CreateRuntimeInput, CursorRuntime, ResumeRuntimeInput, SdkStreamMessage } from "./types.js";

const workspace = {
  workspaceId: "ws_1",
  projectId: "proj_1",
  worktreePath: "/tmp/wt",
  branch: "watt/one",
  slug: "one",
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

function mockRuntime(): CursorRuntime & { created: CreateRuntimeInput[]; resumed: ResumeRuntimeInput[] } {
  const created: CreateRuntimeInput[] = [];
  const resumed: ResumeRuntimeInput[] = [];
  return {
    created,
    resumed,
    async create(input) {
      created.push(input);
      return {
        agentId: "agent_new",
        async send() {
          return {
            stream: () =>
              messages(
                { type: "assistant", message: { content: [{ type: "text", text: "hello" }] } },
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
            stream: () => messages({ type: "assistant", message: { content: [{ type: "text", text: "again" }] } }),
            wait: async () => ({ status: "finished" as const }),
            cancel: async () => undefined,
          };
        },
      };
    },
  };
}

describe("mapSdkMessage", () => {
  it("maps assistant, tool, and status events", () => {
    expect(
      mapSdkMessage({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }),
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
});

describe("createAgent", () => {
  it("uses mocked runtime, default settingSources, and re-passes custom tools on resume", async () => {
    const runtime = mockRuntime();
    const agent = createAgent({ runtime, apiKey: "secret-key-should-not-appear" });
    const session = await agent.create({ cwd: "/tmp/wt", workspace });
    const run = await session.send("go");
    const events = [];
    for await (const event of run.stream()) {
      events.push(event);
    }
    expect(events.map((event) => event.type)).toEqual(["text_delta", "tool_call", "tool_result", "status"]);
    expect(runtime.created[0]?.settingSources).toEqual(["project", "user", "plugins"]);
    expect(runtime.created[0]?.customTools.some((tool) => tool.name === WATT_WORKSPACE_INFO_TOOL)).toBe(true);
    expect(events.every((event) => !JSON.stringify(event).includes("secret-key-should-not-appear"))).toBe(true);

    const resumed = await agent.resume({ cwd: "/tmp/wt", workspace, cursorAgentId: "agent_new" });
    expect(resumed.cursorAgentId).toBe("agent_new");
    expect(runtime.resumed[0]?.customTools.some((tool) => tool.name === WATT_WORKSPACE_INFO_TOOL)).toBe(true);
  });
});
