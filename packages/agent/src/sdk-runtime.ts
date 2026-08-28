import { Agent } from "@cursor/sdk";
import type { SDKCustomTool } from "@cursor/sdk";

import { parseSdkStreamMessage } from "./events.js";
import type {
  CreateRuntimeInput,
  CursorAgentHandle,
  CursorRuntime,
  CustomTool,
  ResumeRuntimeInput,
  SettingSource,
} from "./types.js";

function toSdkCustomTools(tools: CustomTool[]): Record<string, SDKCustomTool> {
  const record: Record<string, SDKCustomTool> = {};
  for (const tool of tools) {
    const sdkTool: SDKCustomTool = {
      description: tool.description,
      execute: async (args) => {
        const result = await tool.execute(asRecord(args));
        return typeof result === "string" ? result : JSON.stringify(result);
      },
    };
    if (tool.inputSchema) {
      sdkTool.inputSchema = tool.inputSchema as SDKCustomTool["inputSchema"];
    }
    record[tool.name] = sdkTool;
  }
  return record;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function localOptions(input: CreateRuntimeInput) {
  return {
    cwd: input.cwd,
    settingSources: [...input.settingSources] as SettingSource[],
    autoReview: input.autoReview,
    customTools: toSdkCustomTools(input.customTools),
  };
}

function wrapSdkAgent(agent: {
  agentId: string;
  send: (prompt: string) => Promise<{
    stream: () => AsyncIterable<unknown>;
    wait: () => Promise<{ status: string }>;
    cancel: () => Promise<void>;
  }>;
}): CursorAgentHandle {
  return {
    agentId: agent.agentId,
    async send(prompt: string) {
      const run = await agent.send(prompt);
      return {
        async *stream() {
          for await (const event of run.stream()) {
            const mapped = parseSdkStreamMessage(event);
            if (mapped) {
              yield mapped;
            }
          }
        },
        async wait() {
          const result = await run.wait();
          if (result.status === "finished" || result.status === "error" || result.status === "cancelled") {
            return { status: result.status };
          }
          return { status: "error" };
        },
        cancel: () => run.cancel(),
      };
    },
  };
}

export function createSdkRuntime(): CursorRuntime {
  return {
    async create(input: CreateRuntimeInput) {
      const agent = await Agent.create({
        apiKey: input.apiKey,
        model: { id: input.model },
        local: localOptions(input),
      });
      return wrapSdkAgent(agent);
    },
    async resume(input: ResumeRuntimeInput) {
      const agent = await Agent.resume(input.agentId, {
        apiKey: input.apiKey,
        model: { id: input.model },
        local: localOptions(input),
      });
      return wrapSdkAgent(agent);
    },
  };
}
