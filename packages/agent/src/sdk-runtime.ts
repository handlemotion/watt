import type { SDKCustomTool } from "@cursor/sdk";

import { parseSdkStreamMessage } from "./events.js";
import type {
  CreateRuntimeInput,
  CursorAgentHandle,
  CursorRun,
  CursorRuntime,
  CustomTool,
  ResumeRuntimeInput,
  SendRunOptions,
  SettingSource,
  WattRunResult,
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

type SdkRunLike = {
  id: string;
  stream: () => AsyncIterable<unknown>;
  wait: () => Promise<{
    status: string;
    result?: string;
    error?: { message: string; code?: string };
    durationMs?: number;
  }>;
  cancel: () => Promise<void>;
};

function mapRunResult(
  result: Awaited<ReturnType<SdkRunLike["wait"]>>,
): WattRunResult {
  const status =
    result.status === "finished" ||
    result.status === "error" ||
    result.status === "cancelled"
      ? result.status
      : "error";
  const mapped: WattRunResult = { status };
  if (typeof result.result === "string") mapped.result = result.result;
  if (result.error) {
    mapped.error = { message: result.error.message };
    if (typeof result.error.code === "string") {
      mapped.error.code = result.error.code;
    }
  }
  if (typeof result.durationMs === "number") {
    mapped.durationMs = result.durationMs;
  }
  return mapped;
}

function wrapSdkRun(run: SdkRunLike): CursorRun {
  return {
    cursorRunId: run.id,
    async *stream() {
      for await (const event of run.stream()) {
        const mapped = parseSdkStreamMessage(event);
        if (mapped) yield mapped;
      }
    },
    async wait() {
      return mapRunResult(await run.wait());
    },
    cancel: () => run.cancel(),
  };
}

function wrapSdkAgent(agent: {
  agentId: string;
  send: (prompt: string, options?: SendRunOptions) => Promise<SdkRunLike>;
}): CursorAgentHandle {
  return {
    agentId: agent.agentId,
    async send(prompt, options) {
      return wrapSdkRun(await agent.send(prompt, options));
    },
  };
}

let sdkPromise: Promise<typeof import("@cursor/sdk")> | undefined;

function loadSdk(): Promise<typeof import("@cursor/sdk")> {
  sdkPromise ??= import("@cursor/sdk");
  return sdkPromise;
}

export function createSdkRuntime(): CursorRuntime {
  return {
    async create(input: CreateRuntimeInput) {
      const { Agent } = await loadSdk();
      const agent = await Agent.create({
        apiKey: input.apiKey,
        model: { id: input.model },
        local: localOptions(input),
      });
      return wrapSdkAgent(agent);
    },
    async resume(input: ResumeRuntimeInput) {
      const { Agent } = await loadSdk();
      const agent = await Agent.resume(input.agentId, {
        apiKey: input.apiKey,
        model: { id: input.model },
        local: localOptions(input),
      });
      return wrapSdkAgent(agent);
    },
    async getRun(input) {
      const { Agent } = await loadSdk();
      const run = await Agent.getRun(input.cursorRunId, {
        runtime: "local",
        cwd: input.cwd,
      });
      return wrapSdkRun(run);
    },
  };
}
