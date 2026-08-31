import type { SDKAgent, SDKCustomTool, SDKModel } from "@cursor/sdk";

import { parseSdkStreamMessage } from "./events.js";
import type {
  CreateRuntimeInput,
  CursorAgentHandle,
  CursorRun,
  CursorRuntime,
  CustomTool,
  ModelCapability,
  ResumeRuntimeInput,
  WattRunResult,
} from "./types.js";

function toSdkCustomTools(tools: CustomTool[]): Record<string, SDKCustomTool> {
  const record: Record<string, SDKCustomTool> = {};
  for (const tool of tools) {
    const sdkTool: SDKCustomTool = {
      description: tool.description,
      execute: async (args, context) => {
        return tool.execute(args, context);
      },
    };
    if (tool.inputSchema) {
      sdkTool.inputSchema = tool.inputSchema as SDKCustomTool["inputSchema"];
    }
    if (tool.outputSchema) {
      sdkTool.outputSchema = tool.outputSchema as SDKCustomTool["outputSchema"];
    }
    record[tool.name] = sdkTool;
  }
  return record;
}

function localOptions(input: CreateRuntimeInput) {
  return {
    cwd: input.cwd,
    settingSources: [...input.executionPolicy.settingSources],
    autoReview: input.executionPolicy.autoReview,
    sandboxOptions: { enabled: input.executionPolicy.sandbox.enabled },
    enableAgentRetries: input.executionPolicy.agentRetries,
    customTools: toSdkCustomTools(input.customTools),
  };
}

function modelCapability(model: SDKModel): ModelCapability {
  const capability: ModelCapability = {
    id: model.id,
    displayName: model.displayName,
    aliases: [...(model.aliases ?? [])],
    parameters: (model.parameters ?? []).map((parameter) => {
      const mapped = {
        id: parameter.id,
        values: parameter.values.map((value) => ({ ...value })),
      };
      return parameter.displayName === undefined
        ? mapped
        : { ...mapped, displayName: parameter.displayName };
    }),
    variants: (model.variants ?? []).map((variant) => ({
      params: variant.params.map((parameter) => ({ ...parameter })),
      displayName: variant.displayName,
      ...(variant.description === undefined
        ? {}
        : { description: variant.description }),
      ...(variant.isDefault === undefined
        ? {}
        : { isDefault: variant.isDefault }),
    })),
  };
  if (model.description !== undefined)
    capability.description = model.description;
  return capability;
}

type SdkRunLike = {
  id: string;
  agentId: string;
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

function wrapSdkRun(
  run: SdkRunLike,
  detach: () => void | Promise<void>,
): CursorRun {
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
    async detach() {
      await detach();
    },
    cancel: () => run.cancel(),
  };
}

function wrapSdkAgent(
  agent: SDKAgent,
  input: CreateRuntimeInput,
): CursorAgentHandle {
  return {
    agentId: agent.agentId,
    async send(prompt, options) {
      return wrapSdkRun(
        await agent.send(prompt, {
          idempotencyKey: options?.idempotencyKey,
          model: input.model,
          mode: input.mode,
          local: { customTools: toSdkCustomTools(input.customTools) },
        }),
        () => agent[Symbol.asyncDispose](),
      );
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
    async listModels(input) {
      const { Cursor } = await loadSdk();
      return (await Cursor.models.list({ apiKey: input?.apiKey })).map(
        modelCapability,
      );
    },
    async create(input: CreateRuntimeInput) {
      const { Agent } = await loadSdk();
      const agent = await Agent.create({
        apiKey: input.apiKey,
        model: input.model,
        mode: input.mode,
        tools: input.executionPolicy.toolAllowlist ?? undefined,
        disallowedTools: input.executionPolicy.toolDenylist,
        local: localOptions(input),
      });
      return wrapSdkAgent(agent, input);
    },
    async resume(input: ResumeRuntimeInput) {
      const { Agent } = await loadSdk();
      const agent = await Agent.resume(input.agentId, {
        apiKey: input.apiKey,
        model: input.model,
        mode: input.mode,
        tools: input.executionPolicy.toolAllowlist ?? undefined,
        disallowedTools: input.executionPolicy.toolDenylist,
        local: localOptions(input),
      });
      return wrapSdkAgent(agent, input);
    },
    async getRun(input) {
      const { Agent } = await loadSdk();
      const run = await Agent.getRun(input.cursorRunId, {
        runtime: "local",
        cwd: input.cwd,
      });
      return wrapSdkRun(run, async () => {
        const agent = await Agent.resume(run.agentId, {
          local: { cwd: input.cwd },
        });
        await agent[Symbol.asyncDispose]();
      });
    },
  };
}
