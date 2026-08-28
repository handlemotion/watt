import type { CursorRun } from "./types.js";
import { assertAgentEvent, mapUnknownSdkMessage } from "./events.js";
import { normalizeExecutionPolicy } from "./policy.js";
import { mergeCustomTools } from "./tools.js";
import {
  type CreateAgentInput,
  type CursorAgentHandle,
  type CursorRuntime,
  type ModelSelection,
  type ResumeAgentInput,
  type WattAgent,
  type WattRun,
  type WattSessionHandle,
} from "./types.js";

export type CreateWattAgentOptions = {
  runtime: CursorRuntime;
  apiKey?: string;
};

function copyModel(model: ModelSelection): ModelSelection {
  return {
    id: model.id,
    params: model.params.map((parameter) => ({ ...parameter })),
  };
}

function wrapRun(run: CursorRun): WattRun {
  return {
    cursorRunId: run.cursorRunId,
    async *stream() {
      try {
        for await (const message of run.stream()) {
          for (const event of mapUnknownSdkMessage(message)) {
            yield assertAgentEvent(event);
          }
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "agent stream failed";
        yield assertAgentEvent({ type: "error", message });
      } finally {
        try {
          await run.wait();
        } catch {
          // wait is required to release run watchers; stream already surfaced errors
        }
      }
    },
    wait: () => run.wait(),
    cancel: () => run.cancel(),
  };
}

function bindHandle(handle: CursorAgentHandle): WattSessionHandle {
  return {
    cursorAgentId: handle.agentId,
    async send(prompt, sendOptions) {
      return wrapRun(await handle.send(prompt, sendOptions));
    },
  };
}

export function createAgent(options: CreateWattAgentOptions): WattAgent {
  const { runtime, apiKey } = options;

  return {
    listModels() {
      return runtime.listModels({ apiKey });
    },
    async create(input: CreateAgentInput) {
      const handle = await runtime.create({
        apiKey,
        cwd: input.cwd,
        model: copyModel(input.model),
        mode: input.mode ?? "agent",
        executionPolicy: normalizeExecutionPolicy(input.executionPolicy),
        customTools: mergeCustomTools(input.workspace, input.customTools),
      });
      return bindHandle(handle);
    },
    async resume(input: ResumeAgentInput) {
      const handle = await runtime.resume({
        apiKey,
        agentId: input.cursorAgentId,
        cwd: input.cwd,
        model: copyModel(input.model),
        mode: input.mode ?? "agent",
        executionPolicy: normalizeExecutionPolicy(input.executionPolicy),
        customTools: mergeCustomTools(input.workspace, input.customTools),
      });
      return bindHandle(handle);
    },
    async getRun(input) {
      return wrapRun(await runtime.getRun(input));
    },
  };
}
