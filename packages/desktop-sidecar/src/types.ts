import type {
  Host,
  HostCapabilities,
  HostEvent,
  Project,
  ProjectReconciliation,
  Run,
  RunResult,
  Session,
  Workspace,
  WorkspaceOperation,
} from "@watt/host";

import type { Capability } from "./constants.js";

export type HostStartupOptions = {
  stateDir: string;
  worktreeRoot: string;
  leaseTimeoutMs?: number;
};

export type HelloEnvelope = {
  type: "hello";
  protocolVersionMin: number;
  protocolVersionMax: number;
  capabilities: Capability[];
  host: HostStartupOptions;
};

export type HostMethodMap = {
  "projects.register": { params: { repoRoot: string }; result: Project };
  "projects.get": { params: { id: string }; result: Project | null };
  "projects.list": { params: Record<string, never>; result: Project[] };
  "projects.reconcile": {
    params: { projectId: string };
    result: ProjectReconciliation;
  };
  "workspaces.create": {
    params: {
      projectId: string;
      slug: string;
      branch?: string;
      baseRef?: string;
      copyGlobs?: string[];
    };
    result: Workspace;
  };
  "workspaces.get": { params: { id: string }; result: Workspace | null };
  "workspaces.list": {
    params: { projectId: string; includeArchived?: boolean };
    result: Workspace[];
  };
  "workspaces.archive": {
    params: { workspaceId: string; keepBranch?: boolean };
    result: Workspace;
  };
  "sessions.create": {
    params: Parameters<Host["sessions"]["create"]>[0];
    result: { session: Session; run: Run };
  };
  "sessions.get": { params: { id: string }; result: Session | null };
  "sessions.list": { params: { workspaceId: string }; result: Session[] };
  "sessions.send": {
    params: { sessionId: string; prompt: string };
    result: { session: Session; run: Run };
  };
  "runs.get": { params: { id: string }; result: Run | null };
  "runs.list": { params: { sessionId: string }; result: Run[] };
  "runs.wait": { params: { runId: string }; result: RunResult };
  "runs.cancel": { params: { runId: string }; result: RunResult };
  "runs.attach": {
    params: { runId: string; subscriptionId: string; afterSequence?: number };
    result: { subscriptionId: string };
  };
  "runs.unsubscribe": {
    params: { subscriptionId: string };
    result: { subscriptionId: string; unsubscribed: boolean };
  };
  "host.capabilities": {
    params: Record<string, never>;
    result: HostCapabilities;
  };
  "diagnostics.operations.get": {
    params: { operationId: string };
    result: WorkspaceOperation | null;
  };
  "diagnostics.operations.list": {
    params: {
      projectId?: string;
      workspaceId?: string;
      includeCompleted?: boolean;
    };
    result: WorkspaceOperation[];
  };
  "host.close": {
    params: Record<string, never>;
    result: { closed: true };
  };
};

export type HostMethod = keyof HostMethodMap;

export type RequestEnvelope<M extends HostMethod = HostMethod> = {
  type: "request";
  version: 1;
  requestId: string;
  method: M;
  params: HostMethodMap[M]["params"];
};

export type ClientEnvelope = HelloEnvelope | RequestEnvelope;

export type WireError = {
  code: string;
  message: string;
  details?: Readonly<Record<string, unknown>>;
};

export type HelloAckEnvelope = {
  type: "hello_ack";
  version: 1;
  capabilities: Capability[];
};

export type ResultEnvelope = {
  type: "result";
  version: 1;
  requestId: string;
  result: unknown;
};

export type ErrorEnvelope = {
  type: "error";
  version: 1;
  requestId?: string;
  fatal: boolean;
  error: WireError;
  supportedVersions?: number[];
  capabilities?: Capability[];
};

export type RunEventEnvelope = {
  type: "run_event";
  version: 1;
  subscriptionId: string;
  runId: string;
  event: HostEvent;
};

export type StreamEndReason =
  | RunResult["status"]
  | "unsubscribed"
  | "shutdown"
  | "consumer_too_slow"
  | "protocol_error"
  | "sidecar_disconnected";

export type StreamEndEnvelope = {
  type: "stream_end";
  version: 1;
  subscriptionId: string;
  runId: string;
  reason: StreamEndReason;
  result?: RunResult;
  error?: WireError;
};

export type ServerEnvelope =
  | HelloAckEnvelope
  | ResultEnvelope
  | ErrorEnvelope
  | RunEventEnvelope
  | StreamEndEnvelope;

export class ProtocolError extends Error {
  readonly code: string;
  readonly fatal: boolean;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    message: string,
    code: string,
    options?: {
      fatal?: boolean;
      details?: Readonly<Record<string, unknown>>;
      cause?: unknown;
    },
  ) {
    super(message, { cause: options?.cause });
    this.name = "ProtocolError";
    this.code = code;
    this.fatal = options?.fatal ?? false;
    this.details = options?.details;
  }
}
