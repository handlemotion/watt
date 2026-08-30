export const DEFAULT_SETTING_SOURCES = ["project", "user", "plugins"] as const;

export type SettingSource = (typeof DEFAULT_SETTING_SOURCES)[number];
export type AgentMode = "agent" | "plan";
export type AgentRuntimeId = "cursor-local" | "codex-local";

export type ModelParameterValue = { id: string; value: string };
export type ModelSelection = { id: string; params: ModelParameterValue[] };
export type ModelParameterDefinition = {
  id: string;
  displayName?: string;
  values: Array<{ value: string; displayName?: string }>;
};
export type ModelVariant = {
  params: ModelParameterValue[];
  displayName: string;
  description?: string;
  isDefault?: boolean;
};
export type ModelCapability = {
  id: string;
  displayName: string;
  description?: string;
  aliases: string[];
  parameters: ModelParameterDefinition[];
  variants: ModelVariant[];
};

export type ExecutionPolicy = {
  autoReview: boolean;
  sandbox: { enabled: boolean };
  agentRetries: boolean;
  toolAllowlist: string[] | null;
  toolDenylist: string[];
  settingSources: SettingSource[];
};

export type ExecutionPolicyInput = {
  autoReview?: boolean;
  sandbox?: { enabled?: boolean };
  agentRetries?: boolean;
  toolAllowlist?: string[] | null;
  toolDenylist?: string[];
  settingSources?: SettingSource[];
};

export type AgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; callId: string; name: string; args: unknown }
  | {
      type: "tool_result";
      callId: string;
      name: string;
      result: unknown;
      ok: boolean;
    }
  | { type: "status"; status: string; message?: string }
  | { type: "error"; message: string };

export type WorkspaceInfo = {
  workspaceId: string;
  projectId: string;
  worktreePath: string;
  branch: string;
  slug: string;
};

export type JsonValue =
  string | number | boolean | null | { [key: string]: JsonValue } | JsonValue[];

export type CustomToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType?: string };
export type CustomToolResult =
  | string
  | JsonValue
  | {
      content: CustomToolContent[];
      isError?: boolean;
      structuredContent?: Record<string, JsonValue>;
    };
export type CustomToolContext = { toolCallId?: string };
export type CustomTool = {
  name: string;
  description: string;
  inputSchema?: Record<string, JsonValue>;
  outputSchema?: Record<string, JsonValue>;
  execute: (
    args: Record<string, JsonValue>,
    context: CustomToolContext,
  ) => Promise<CustomToolResult> | CustomToolResult;
};

export type SdkStreamMessage =
  | {
      type: "assistant";
      message: {
        content: Array<
          | { type: "text"; text: string }
          | { type: "tool_use"; id: string; name: string; input: unknown }
        >;
      };
    }
  | {
      type: "tool_call";
      call_id: string;
      name: string;
      status: "running" | "completed" | "error";
      args?: unknown;
      result?: unknown;
    }
  | { type: "status"; status: string; message?: string }
  | { type: "system" }
  | { type: "user" }
  | { type: "thinking"; text: string }
  | { type: "task"; status?: string; text?: string }
  | { type: "request"; request_id: string }
  | { type: "usage" };

export type CursorRun = {
  cursorRunId: string;
  stream: () => AsyncIterable<unknown>;
  wait: () => Promise<WattRunResult>;
  cancel: () => Promise<void>;
};

export type SendRunOptions = { idempotencyKey?: string };

export type CursorAgentHandle = {
  agentId: string;
  send: (prompt: string, options?: SendRunOptions) => Promise<CursorRun>;
};

export type CreateRuntimeInput = {
  apiKey?: string;
  cwd: string;
  model: ModelSelection;
  mode: AgentMode;
  executionPolicy: ExecutionPolicy;
  customTools: CustomTool[];
};

export type ResumeRuntimeInput = CreateRuntimeInput & { agentId: string };

export type CursorRuntime = {
  listModels: (input?: { apiKey?: string }) => Promise<ModelCapability[]>;
  create: (input: CreateRuntimeInput) => Promise<CursorAgentHandle>;
  resume: (input: ResumeRuntimeInput) => Promise<CursorAgentHandle>;
  getRun: (input: { cursorRunId: string; cwd: string }) => Promise<CursorRun>;
};

export type CreateAgentInput = {
  cwd: string;
  model: ModelSelection;
  mode?: AgentMode;
  executionPolicy?: ExecutionPolicyInput;
  workspace: WorkspaceInfo;
  customTools?: CustomTool[];
};

export type ResumeAgentInput = CreateAgentInput & { cursorAgentId: string };

export type WattRunError = { message: string; code?: string };

export type WattRunResult = {
  status: "finished" | "error" | "cancelled";
  result?: string;
  error?: WattRunError;
  durationMs?: number;
};

export type WattRun = {
  cursorRunId: string;
  stream: () => AsyncIterable<AgentEvent>;
  wait: () => Promise<WattRunResult>;
  cancel: () => Promise<void>;
};

export type WattSessionHandle = {
  cursorAgentId: string;
  send: (prompt: string, options?: SendRunOptions) => Promise<WattRun>;
};

export type WattAgent = {
  listModels: () => Promise<ModelCapability[]>;
  create: (input: CreateAgentInput) => Promise<WattSessionHandle>;
  resume: (input: ResumeAgentInput) => Promise<WattSessionHandle>;
  getRun: (input: { cursorRunId: string; cwd: string }) => Promise<WattRun>;
};
