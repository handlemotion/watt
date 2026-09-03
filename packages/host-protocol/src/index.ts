import {
  isWattBoundaryError,
  type Host,
  type HostCapabilities,
  type HostEvent,
  type Project,
  type ProjectReconciliation,
  type Run,
  type RunResult,
  type Session,
  type Workspace,
  type WorkspaceOperation,
} from "@watt/host";

export type HostStartupOptions = {
  stateDir: string;
  worktreeRoot: string;
  leaseTimeoutMs?: number;
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
      idempotencyKey?: string;
    };
    result: Workspace;
  };
  "workspaces.get": { params: { id: string }; result: Workspace | null };
  "workspaces.list": {
    params: { projectId: string; includeArchived?: boolean };
    result: Workspace[];
  };
  "workspaces.archive": {
    params: {
      workspaceId: string;
      keepBranch?: boolean;
      idempotencyKey?: string;
    };
    result: Workspace;
  };
  "sessions.create": {
    params: Parameters<Host["sessions"]["create"]>[0];
    result: { session: Session; run: Run };
  };
  "sessions.get": { params: { id: string }; result: Session | null };
  "sessions.list": { params: { workspaceId: string }; result: Session[] };
  "sessions.send": {
    params: Parameters<Host["sessions"]["send"]>[0];
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
  "cloud.prepareBase": {
    params: Parameters<Host["cloud"]["prepareBase"]>[0];
    result: Awaited<ReturnType<Host["cloud"]["prepareBase"]>>;
  };
  "changesets.pull": {
    params: Parameters<Host["changesets"]["pull"]>[0];
    result: Awaited<ReturnType<Host["changesets"]["pull"]>>;
  };
  "changesets.resolve": {
    params: Parameters<Host["changesets"]["resolve"]>[0];
    result: Awaited<ReturnType<Host["changesets"]["resolve"]>>;
  };
  "changesets.abort": {
    params: Parameters<Host["changesets"]["abort"]>[0];
    result: Awaited<ReturnType<Host["changesets"]["abort"]>>;
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
  "host.close": { params: Record<string, never>; result: { closed: true } };
  "host.suspend": {
    params: Record<string, never>;
    result: { suspended: true };
  };
};

export type HostMethod = keyof HostMethodMap;
export type HostRequest<M extends HostMethod = HostMethod> = {
  method: M;
  params: HostMethodMap[M]["params"];
};
export type HostResponse<M extends HostMethod> = HostMethodMap[M]["result"];

export type WireError = {
  code: string;
  message: string;
  details?: Readonly<Record<string, unknown>>;
};

export type RunStreamItem =
  | { type: "event"; event: HostEvent }
  | { type: "end"; result: RunResult };

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeDetails(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (!isRecord(value)) return undefined;
  try {
    const serialized = JSON.stringify(value);
    if (new TextEncoder().encode(serialized).byteLength > 16 * 1024) return undefined;
    return JSON.parse(serialized) as Readonly<Record<string, unknown>>;
  } catch {
    return undefined;
  }
}

export function toWireError(error: unknown, fallbackMessage = "internal host error"): WireError {
  if (error instanceof ProtocolError) {
    return {
      code: error.code.slice(0, 128),
      message: error.message.slice(0, 4096),
      ...(error.details ? { details: error.details } : {}),
    };
  }
  if (isWattBoundaryError(error)) {
    const details = safeDetails(error.details);
    return {
      code: error.code.slice(0, 128),
      message: error.message.slice(0, 4096),
      ...(details ? { details } : {}),
    };
  }
  return { code: "internal_error", message: fallbackMessage };
}
