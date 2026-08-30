import {
  DEFAULT_CODEX_CATALOG,
  upstreamCodexModelId,
} from "./codex-catalog.js";
import { mapCodexStreamEvent } from "./codex-events.js";
import { AgentError } from "./errors.js";
import type {
  CreateRuntimeInput,
  CursorAgentHandle,
  CursorRun,
  CursorRuntime,
  ResumeRuntimeInput,
  WattRunResult,
} from "./types.js";

export type CodexSandboxMode =
  "read-only" | "workspace-write" | "danger-full-access";

export type CodexApprovalPolicy =
  "untrusted" | "on-failure" | "on-request" | "never";

export type CodexThreadOptions = {
  workingDirectory: string;
  skipGitRepoCheck?: boolean;
  sandboxMode?: CodexSandboxMode;
  approvalPolicy?: CodexApprovalPolicy;
  model?: string;
  modelReasoningEffort?: string;
};

export type CodexThreadHandle = {
  id: string;
  runStreamed: (
    prompt: string,
    options?: { signal?: AbortSignal },
  ) => Promise<{ events: AsyncIterable<unknown> }>;
};

export type CodexClient = {
  startThread: (options: CodexThreadOptions) => CodexThreadHandle;
  resumeThread: (
    threadId: string,
    options?: CodexThreadOptions,
  ) => CodexThreadHandle;
};

function sandboxMode(enabled: boolean): CodexSandboxMode {
  return enabled ? "read-only" : "danger-full-access";
}

function isAuthFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code =
    "code" in error && typeof error.code === "string"
      ? error.code.toLowerCase()
      : "";
  if (
    code === "codex_auth_unavailable" ||
    code.includes("unauthorized") ||
    code === "401"
  ) {
    return true;
  }
  const message =
    error instanceof Error
      ? error.message.toLowerCase()
      : "message" in error && typeof error.message === "string"
        ? error.message.toLowerCase()
        : String(error).toLowerCase();
  return (
    message.includes("not logged in") ||
    message.includes("codex login") ||
    message.includes("unauthorized") ||
    message.includes("authentication") ||
    message.includes("401")
  );
}

function throwAuthOr(error: unknown): never {
  if (isAuthFailure(error)) {
    throw new AgentError(
      "Codex is not signed in with ChatGPT. Run `codex login`.",
      "codex_auth_unavailable",
      { cause: error instanceof Error ? error : undefined },
    );
  }
  throw error;
}

function wrapThreadRun(
  thread: CodexThreadHandle,
  cursorRunId: string,
  prompt: string,
  liveRuns: Map<string, CursorRun>,
): CursorRun {
  const abort = new AbortController();
  let cancelRequested = false;
  let settle: ((result: WattRunResult) => void) | undefined;
  const finished = new Promise<WattRunResult>((resolve) => {
    settle = resolve;
  });
  const run: CursorRun = {
    cursorRunId,
    async *stream() {
      let resultText = "";
      let status: WattRunResult["status"] = "finished";
      let error: WattRunResult["error"];
      try {
        const { events } = await thread.runStreamed(prompt, {
          signal: abort.signal,
        });
        for await (const event of events) {
          if (cancelRequested) break;
          for (const mapped of mapCodexStreamEvent(event)) {
            if (mapped.type === "text_delta") resultText += mapped.text;
            if (mapped.type === "error") {
              status = "error";
              if (isAuthFailure({ message: mapped.message })) {
                error = {
                  message:
                    "Codex is not signed in with ChatGPT. Run `codex login`.",
                  code: "codex_auth_unavailable",
                };
                yield { type: "error", message: error.message };
                continue;
              }
              error = { message: mapped.message };
            }
            yield mapped;
          }
        }
        if (cancelRequested) {
          status = "cancelled";
          resultText = "";
        }
      } catch (caught) {
        if (cancelRequested || abort.signal.aborted) {
          status = "cancelled";
        } else if (isAuthFailure(caught)) {
          status = "error";
          error = {
            message: "Codex is not signed in with ChatGPT. Run `codex login`.",
            code: "codex_auth_unavailable",
          };
          yield { type: "error", message: error.message };
        } else {
          status = "error";
          error = {
            message:
              caught instanceof Error ? caught.message : "codex run failed",
          };
          yield { type: "error", message: error.message };
        }
      } finally {
        const result: WattRunResult = { status };
        if (resultText.length > 0 && status === "finished") {
          result.result = resultText;
        }
        if (error) result.error = error;
        settle?.(result);
        liveRuns.delete(cursorRunId);
      }
    },
    wait: () => finished,
    async cancel() {
      cancelRequested = true;
      abort.abort();
    },
  };
  liveRuns.set(cursorRunId, run);
  return run;
}

function bindThread(
  thread: CodexThreadHandle,
  liveRuns: Map<string, CursorRun>,
  turnIds: Map<string, number>,
): CursorAgentHandle {
  const pendingId = `codex-pending:${crypto.randomUUID()}`;
  return {
    get agentId() {
      return thread.id.length > 0 ? thread.id : pendingId;
    },
    async send(prompt, options) {
      const key = thread.id.length > 0 ? thread.id : pendingId;
      const next = (turnIds.get(key) ?? 0) + 1;
      turnIds.set(key, next);
      const cursorRunId = options?.idempotencyKey ?? `${key}:${String(next)}`;
      return wrapThreadRun(thread, cursorRunId, prompt, liveRuns);
    },
  };
}

function threadOptions(input: CreateRuntimeInput): CodexThreadOptions {
  const effort = input.model.params.find(
    (parameter) => parameter.id === "effort",
  )?.value;
  return {
    workingDirectory: input.cwd,
    skipGitRepoCheck: true,
    sandboxMode: sandboxMode(input.executionPolicy.sandbox.enabled),
    approvalPolicy: "never",
    model: upstreamCodexModelId(input.model.id),
    ...(effort === undefined ? {} : { modelReasoningEffort: effort }),
  };
}

let sdkPromise: Promise<CodexClient> | undefined;

async function loadSdkClient(): Promise<CodexClient> {
  sdkPromise ??= import("@openai/codex-sdk").then((mod) => {
    const instance = new mod.Codex();
    function adapt(thread: {
      readonly id: string | null;
      runStreamed: (
        input: string,
        turnOptions?: { signal?: AbortSignal },
      ) => Promise<{ events: AsyncIterable<unknown> }>;
    }): CodexThreadHandle {
      return {
        get id() {
          return thread.id ?? "";
        },
        runStreamed: (prompt, options) => thread.runStreamed(prompt, options),
      };
    }
    return {
      startThread: (options) =>
        adapt(
          instance.startThread({
            ...options,
            modelReasoningEffort: options.modelReasoningEffort as
              "low" | "medium" | "high" | "xhigh" | undefined,
          }),
        ),
      resumeThread: (threadId, options) =>
        adapt(
          instance.resumeThread(threadId, {
            ...options,
            modelReasoningEffort: options?.modelReasoningEffort as
              "low" | "medium" | "high" | "xhigh" | undefined,
          }),
        ),
    };
  });
  return sdkPromise;
}

export function createCodexRuntime(options?: {
  client?: CodexClient;
}): CursorRuntime {
  const liveRuns = new Map<string, CursorRun>();
  const turnIds = new Map<string, number>();

  async function client(): Promise<CodexClient> {
    return options?.client ?? (await loadSdkClient());
  }

  return {
    async listModels() {
      return DEFAULT_CODEX_CATALOG.map((model) => ({
        ...model,
        aliases: [...model.aliases],
        parameters: model.parameters.map((parameter) => ({
          ...parameter,
          values: parameter.values.map((value) => ({ ...value })),
        })),
        variants: model.variants.map((variant) => ({
          ...variant,
          params: variant.params.map((parameter) => ({ ...parameter })),
        })),
      }));
    },
    async create(input: CreateRuntimeInput) {
      if (input.mode !== "agent") {
        throw new AgentError(
          "Codex runtime supports agent mode only",
          "mode_unsupported",
        );
      }
      try {
        const handle = (await client()).startThread(threadOptions(input));
        return bindThread(handle, liveRuns, turnIds);
      } catch (error) {
        throwAuthOr(error);
      }
    },
    async resume(input: ResumeRuntimeInput) {
      if (input.mode !== "agent") {
        throw new AgentError(
          "Codex runtime supports agent mode only",
          "mode_unsupported",
        );
      }
      try {
        const handle = (await client()).resumeThread(
          input.agentId,
          threadOptions(input),
        );
        return bindThread(handle, liveRuns, turnIds);
      } catch (error) {
        throwAuthOr(error);
      }
    },
    async getRun(input) {
      const run = liveRuns.get(input.cursorRunId);
      if (!run) {
        throw new AgentError(
          "Codex run is not recoverable after process restart",
          "run_recovery_failed",
        );
      }
      return run;
    },
  };
}
