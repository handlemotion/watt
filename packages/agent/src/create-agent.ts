import type { CursorRun } from "./types.js";
import { assertAgentEvent, mapSdkMessage } from "./events.js";
import { mergeCustomTools } from "./tools.js";
import {
  DEFAULT_SETTING_SOURCES,
  type CreateAgentInput,
  type CursorAgentHandle,
  type CursorRuntime,
  type ResumeAgentInput,
  type WattAgent,
  type WattRun,
  type WattSessionHandle,
} from "./types.js";

export type CreateWattAgentOptions = {
  runtime: CursorRuntime;
  apiKey?: string;
};

function wrapRun(run: CursorRun): WattRun {
  return {
    async *stream() {
      try {
        for await (const message of run.stream()) {
          for (const event of mapSdkMessage(message)) {
            yield assertAgentEvent(event);
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "agent stream failed";
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
    async send(prompt: string) {
      return wrapRun(await handle.send(prompt));
    },
  };
}

export function createAgent(options: CreateWattAgentOptions): WattAgent {
  const { runtime, apiKey } = options;

  return {
    async create(input: CreateAgentInput) {
      const handle = await runtime.create({
        apiKey,
        cwd: input.cwd,
        model: input.model ?? "composer-2.5",
        autoReview: input.autoReview,
        customTools: mergeCustomTools(input.workspace, input.customTools),
        settingSources: DEFAULT_SETTING_SOURCES,
      });
      return bindHandle(handle);
    },
    async resume(input: ResumeAgentInput) {
      const handle = await runtime.resume({
        apiKey,
        agentId: input.cursorAgentId,
        cwd: input.cwd,
        model: input.model ?? "composer-2.5",
        autoReview: input.autoReview,
        customTools: mergeCustomTools(input.workspace, input.customTools),
        settingSources: DEFAULT_SETTING_SOURCES,
      });
      return bindHandle(handle);
    },
  };
}
