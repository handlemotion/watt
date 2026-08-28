export const DEFAULT_SETTING_SOURCES = ["project", "user", "plugins"] as const;

export type SettingSource = (typeof DEFAULT_SETTING_SOURCES)[number];

export type AgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; callId: string; name: string; args: unknown }
  | { type: "tool_result"; callId: string; name: string; result: unknown; ok: boolean }
  | { type: "status"; status: string; message?: string }
  | { type: "error"; message: string };

export type WorkspaceInfo = {
  workspaceId: string;
  projectId: string;
  worktreePath: string;
  branch: string;
  slug: string;
};

export type CustomTool = {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<unknown> | unknown;
};

export type SdkStreamMessage =
  | {
      type: "assistant";
      message: { content: Array<{ type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown }> };
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
  stream: () => AsyncIterable<SdkStreamMessage>;
  wait: () => Promise<{ status: "finished" | "error" | "cancelled" }>;
  cancel: () => Promise<void>;
};

export type CursorAgentHandle = {
  agentId: string;
  send: (prompt: string) => Promise<CursorRun>;
};

export type CreateRuntimeInput = {
  apiKey?: string;
  cwd: string;
  model: string;
  autoReview?: boolean;
  customTools: CustomTool[];
  settingSources: readonly SettingSource[];
};

export type ResumeRuntimeInput = CreateRuntimeInput & { agentId: string };

export type CursorRuntime = {
  create: (input: CreateRuntimeInput) => Promise<CursorAgentHandle>;
  resume: (input: ResumeRuntimeInput) => Promise<CursorAgentHandle>;
};

export type CreateAgentInput = {
  cwd: string;
  model?: string;
  autoReview?: boolean;
  workspace: WorkspaceInfo;
  customTools?: CustomTool[];
};

export type ResumeAgentInput = CreateAgentInput & { cursorAgentId: string };

export type WattRun = {
  stream: () => AsyncIterable<AgentEvent>;
  wait: () => Promise<{ status: "finished" | "error" | "cancelled" }>;
  cancel: () => Promise<void>;
};

export type WattSessionHandle = {
  cursorAgentId: string;
  send: (prompt: string) => Promise<WattRun>;
};

export type WattAgent = {
  create: (input: CreateAgentInput) => Promise<WattSessionHandle>;
  resume: (input: ResumeAgentInput) => Promise<WattSessionHandle>;
};
