import type { Readable, Writable } from "node:stream";

import {
  createHost,
  isWattBoundaryError,
  type Host,
  type RunResult,
} from "@watt/host";

import {
  CAPABILITIES,
  MAX_ACTIVE_SUBSCRIPTIONS,
  MAX_IN_FLIGHT_REQUESTS,
  PROTOCOL_VERSION,
} from "./constants.js";
import { FrameDecoder } from "./codec.js";
import type {
  ErrorEnvelope,
  HostMethodMap,
  HostStartupOptions,
  RequestEnvelope,
  ServerEnvelope,
  StreamEndReason,
  WireError,
} from "./types.js";
import { ProtocolError } from "./types.js";
import {
  assertHello,
  assertRequest,
  assertServerEnvelope,
} from "./validate.js";
import { BoundedWriter } from "./writer.js";

export type TransportHost = Pick<
  Host,
  | "capabilities"
  | "close"
  | "suspend"
  | "projects"
  | "workspaces"
  | "sessions"
  | "diagnostics"
> & {
  runs: Omit<Host["runs"], "attach"> & {
    attach: (input: {
      runId: string;
      afterSequence?: number;
      signal?: AbortSignal;
    }) => AsyncIterable<import("@watt/host").HostEvent>;
  };
};

export type HostFactory = (
  options: HostStartupOptions,
) => Promise<TransportHost>;

type Subscription = {
  runId: string;
  controller: AbortController;
  reason?: StreamEndReason;
  task: Promise<void>;
  ended: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeRequestId(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.requestId !== "string") return undefined;
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(value.requestId)
    ? value.requestId
    : undefined;
}

function safeDetails(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  if (!isRecord(value)) return undefined;
  try {
    const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized) > 16 * 1024) return undefined;
    return JSON.parse(serialized) as Readonly<Record<string, unknown>>;
  } catch {
    return undefined;
  }
}

export function wireError(error: unknown): WireError {
  if (error instanceof ProtocolError) {
    return {
      code: error.code,
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
  return { code: "internal_error", message: "internal sidecar error" };
}

async function* messages(input: Readable): AsyncGenerator<unknown> {
  const decoder = new FrameDecoder();
  for await (const chunk of input) {
    const bytes =
      typeof chunk === "string"
        ? Buffer.from(chunk, "utf8")
        : (chunk as Buffer);
    for (const value of decoder.push(bytes)) yield value;
  }
  decoder.finish();
}

export class SidecarServer {
  readonly #input: Readable;
  readonly #writer: BoundedWriter;
  readonly #hostFactory: HostFactory;
  readonly #subscriptions = new Map<string, Subscription>();
  readonly #inFlight = new Map<string, Promise<void>>();
  #host: TransportHost | undefined;
  #closing = false;
  #closePromise: Promise<void> | undefined;

  constructor(input: Readable, output: Writable, hostFactory: HostFactory) {
    this.#input = input;
    this.#writer = new BoundedWriter(output);
    this.#hostFactory = hostFactory;
  }

  async serve(): Promise<void> {
    const iterator = messages(this.#input)[Symbol.asyncIterator]();
    try {
      const first = await iterator.next();
      if (first.done) {
        throw new ProtocolError(
          "connection closed before hello",
          "handshake_required",
          {
            fatal: true,
          },
        );
      }
      assertHello(first.value);
      if (
        first.value.protocolVersionMin > PROTOCOL_VERSION ||
        first.value.protocolVersionMax < PROTOCOL_VERSION
      ) {
        await this.#send({
          type: "error",
          version: PROTOCOL_VERSION,
          fatal: true,
          error: {
            code: "protocol_version_unsupported",
            message: `sidecar supports protocol version ${PROTOCOL_VERSION}`,
          },
          supportedVersions: [PROTOCOL_VERSION],
          capabilities: [...CAPABILITIES],
        });
        return;
      }
      const hello = first.value;
      this.#host = await this.#hostFactory(hello.host);
      const negotiated = CAPABILITIES.filter((capability) =>
        hello.capabilities.includes(capability),
      );
      await this.#send({
        type: "hello_ack",
        version: PROTOCOL_VERSION,
        capabilities: [...negotiated],
      });

      for (;;) {
        while (this.#inFlight.size >= MAX_IN_FLIGHT_REQUESTS) {
          await Promise.race(this.#inFlight.values());
        }
        const next = await iterator.next();
        if (next.done || this.#closing) break;
        let request: RequestEnvelope;
        try {
          assertRequest(next.value);
          request = next.value;
        } catch (error) {
          if (error instanceof ProtocolError && !error.fatal) {
            await this.#sendError(error, safeRequestId(next.value), false);
            continue;
          }
          throw error;
        }
        if (this.#inFlight.has(request.requestId)) {
          await this.#sendError(
            new ProtocolError(
              "request ID is already active",
              "duplicate_request_id",
            ),
            request.requestId,
            false,
          );
          continue;
        }
        const task = this.#handle(request).finally(() => {
          this.#inFlight.delete(request.requestId);
        });
        this.#inFlight.set(request.requestId, task);
      }
      await this.#shutdown("shutdown");
      await Promise.allSettled(this.#inFlight.values());
    } catch (error) {
      await this.#sendError(error, undefined, true).catch(() => undefined);
    } finally {
      await this.#shutdown("shutdown").catch(() => undefined);
      await this.#writer.close().catch(() => undefined);
    }
  }

  async #handle(request: RequestEnvelope): Promise<void> {
    try {
      if (request.method === "runs.attach") {
        await this.#attach(request as RequestEnvelope<"runs.attach">);
        return;
      }
      if (request.method === "runs.unsubscribe") {
        const params =
          request.params as HostMethodMap["runs.unsubscribe"]["params"];
        const unsubscribed = await this.#unsubscribe(params.subscriptionId);
        await this.#sendResult(request.requestId, {
          subscriptionId: params.subscriptionId,
          unsubscribed,
        });
        return;
      }
      if (request.method === "host.close") {
        await this.#shutdown("shutdown");
        await this.#sendResult(request.requestId, { closed: true });
        this.#input.destroy();
        return;
      }
      if (request.method === "host.suspend") {
        await this.#shutdown("shutdown", "suspend");
        await this.#sendResult(request.requestId, { suspended: true });
        this.#input.destroy();
        return;
      }
      const result = await this.#route(request);
      await this.#sendResult(request.requestId, result);
    } catch (error) {
      await this.#sendError(error, request.requestId, false);
    }
  }

  async #route(request: RequestEnvelope): Promise<unknown> {
    const host = this.#requireHost();
    switch (request.method) {
      case "projects.register": {
        const params =
          request.params as HostMethodMap["projects.register"]["params"];
        return host.projects.register(params.repoRoot);
      }
      case "projects.get": {
        const params =
          request.params as HostMethodMap["projects.get"]["params"];
        return host.projects.get(params.id) ?? null;
      }
      case "projects.list":
        return host.projects.list();
      case "projects.reconcile":
        return host.projects.reconcile(
          request.params as HostMethodMap["projects.reconcile"]["params"],
        );
      case "workspaces.create":
        return host.workspaces.create(
          request.params as HostMethodMap["workspaces.create"]["params"],
        );
      case "workspaces.get": {
        const params =
          request.params as HostMethodMap["workspaces.get"]["params"];
        return host.workspaces.get(params.id) ?? null;
      }
      case "workspaces.list":
        return host.workspaces.list(
          request.params as HostMethodMap["workspaces.list"]["params"],
        );
      case "workspaces.archive":
        return host.workspaces.archive(
          request.params as HostMethodMap["workspaces.archive"]["params"],
        );
      case "sessions.create":
        return host.sessions.create(
          request.params as HostMethodMap["sessions.create"]["params"],
        );
      case "sessions.get": {
        const params =
          request.params as HostMethodMap["sessions.get"]["params"];
        return host.sessions.get(params.id) ?? null;
      }
      case "sessions.list":
        return host.sessions.list(
          request.params as HostMethodMap["sessions.list"]["params"],
        );
      case "sessions.send":
        return host.sessions.send(
          request.params as HostMethodMap["sessions.send"]["params"],
        );
      case "runs.get": {
        const params = request.params as HostMethodMap["runs.get"]["params"];
        return host.runs.get(params.id) ?? null;
      }
      case "runs.list":
        return host.runs.list(
          request.params as HostMethodMap["runs.list"]["params"],
        );
      case "runs.wait":
        return host.runs.wait(
          request.params as HostMethodMap["runs.wait"]["params"],
        );
      case "runs.cancel":
        return host.runs.cancel(
          request.params as HostMethodMap["runs.cancel"]["params"],
        );
      case "host.capabilities":
        return host.capabilities();
      case "diagnostics.operations.get": {
        const params =
          request.params as HostMethodMap["diagnostics.operations.get"]["params"];
        return host.diagnostics.operations.get(params) ?? null;
      }
      case "diagnostics.operations.list":
        return host.diagnostics.operations.list(
          request.params as HostMethodMap["diagnostics.operations.list"]["params"],
        );
      case "runs.attach":
      case "runs.unsubscribe":
      case "host.close":
      case "host.suspend":
        throw new ProtocolError("method routed incorrectly", "internal_error");
      default: {
        const exhaustive: never = request.method;
        throw new ProtocolError(
          `unsupported method: ${String(exhaustive)}`,
          "method_not_found",
        );
      }
    }
  }

  async #attach(request: RequestEnvelope<"runs.attach">): Promise<void> {
    const params = request.params;
    if (this.#subscriptions.has(params.subscriptionId)) {
      throw new ProtocolError(
        "subscription ID is already active",
        "duplicate_subscription_id",
      );
    }
    if (this.#subscriptions.size >= MAX_ACTIVE_SUBSCRIPTIONS) {
      throw new ProtocolError(
        "too many active subscriptions",
        "subscription_limit",
      );
    }
    const controller = new AbortController();
    const events = this.#requireHost().runs.attach({
      runId: params.runId,
      afterSequence: params.afterSequence,
      signal: controller.signal,
    });
    let acknowledge!: () => void;
    const acknowledged = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    const subscription: Subscription = {
      runId: params.runId,
      controller,
      task: Promise.resolve(),
      ended: false,
    };
    subscription.task = (async () => {
      await acknowledged;
      await this.#stream(params.subscriptionId, subscription, events);
    })();
    this.#subscriptions.set(params.subscriptionId, subscription);
    try {
      await this.#sendResult(request.requestId, {
        subscriptionId: params.subscriptionId,
      });
    } catch (error) {
      subscription.reason = "protocol_error";
      subscription.controller.abort();
      acknowledge();
      await subscription.task.catch(() => undefined);
      this.#subscriptions.delete(params.subscriptionId);
      throw error;
    }
    acknowledge();
  }

  async #stream(
    subscriptionId: string,
    subscription: Subscription,
    events: AsyncIterable<import("@watt/host").HostEvent>,
  ): Promise<void> {
    try {
      const host = this.#requireHost();
      for await (const event of events) {
        if (subscription.controller.signal.aborted) break;
        await this.#send({
          type: "run_event",
          version: PROTOCOL_VERSION,
          subscriptionId,
          runId: subscription.runId,
          event,
        });
      }
      if (subscription.reason) {
        await this.#endSubscription(
          subscriptionId,
          subscription,
          subscription.reason,
        );
      } else {
        const result = await host.runs.wait({ runId: subscription.runId });
        await this.#endSubscription(
          subscriptionId,
          subscription,
          result.status,
          result,
        );
      }
    } catch (error) {
      if (subscription.reason) {
        await this.#endSubscription(
          subscriptionId,
          subscription,
          subscription.reason,
        ).catch(() => undefined);
        return;
      }
      await this.#endSubscription(
        subscriptionId,
        subscription,
        "protocol_error",
        undefined,
        wireError(error),
      ).catch(() => undefined);
    } finally {
      if (this.#subscriptions.get(subscriptionId) === subscription) {
        this.#subscriptions.delete(subscriptionId);
      }
    }
  }

  async #endSubscription(
    subscriptionId: string,
    subscription: Subscription,
    reason: StreamEndReason,
    result?: RunResult,
    error?: WireError,
  ): Promise<void> {
    if (subscription.ended) return;
    subscription.ended = true;
    await this.#send({
      type: "stream_end",
      version: PROTOCOL_VERSION,
      subscriptionId,
      runId: subscription.runId,
      reason,
      ...(result ? { result } : {}),
      ...(error ? { error } : {}),
    });
  }

  async #unsubscribe(subscriptionId: string): Promise<boolean> {
    const subscription = this.#subscriptions.get(subscriptionId);
    if (!subscription) return false;
    subscription.reason = "unsubscribed";
    subscription.controller.abort();
    await subscription.task;
    return true;
  }

  #shutdown(
    reason: StreamEndReason,
    disposition: "close" | "suspend" = "close",
  ): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closing = true;
    this.#closePromise = (async () => {
      const tasks: Promise<void>[] = [];
      for (const subscription of this.#subscriptions.values()) {
        subscription.reason = reason;
        subscription.controller.abort();
        tasks.push(subscription.task);
      }
      await Promise.allSettled(tasks);
      if (disposition === "suspend") {
        await this.#host?.suspend();
      } else {
        await this.#host?.close();
      }
    })();
    return this.#closePromise;
  }

  #requireHost(): TransportHost {
    if (!this.#host || this.#closing) {
      throw new ProtocolError("sidecar is closing", "host_closed");
    }
    return this.#host;
  }

  async #sendResult(requestId: string, result: unknown): Promise<void> {
    await this.#send({
      type: "result",
      version: PROTOCOL_VERSION,
      requestId,
      result,
    });
  }

  async #sendError(
    error: unknown,
    requestId: string | undefined,
    fatal: boolean,
  ): Promise<void> {
    const envelope: ErrorEnvelope = {
      type: "error",
      version: PROTOCOL_VERSION,
      fatal,
      error: wireError(error),
      ...(requestId ? { requestId } : {}),
    };
    await this.#send(envelope);
  }

  async #send(envelope: ServerEnvelope): Promise<void> {
    assertServerEnvelope(envelope);
    await this.#writer.send(envelope);
  }
}

export async function serveConnection(
  input: Readable,
  output: Writable,
  hostFactory: HostFactory = async (options) =>
    createHost({
      ...options,
      apiKey: process.env.CURSOR_API_KEY,
    }),
): Promise<void> {
  await new SidecarServer(input, output, hostFactory).serve();
}
