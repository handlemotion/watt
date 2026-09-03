import { readFile } from "node:fs/promises";
import { PassThrough, Writable } from "node:stream";

import { HostError, type HostCapabilities, type RunResult, type Session } from "@watt/host";
import { describe, expect, it, vi } from "vitest";

import {
  MAX_FRAME_BYTES,
  MAX_JSON_DEPTH,
  MAX_OUTBOUND_QUEUE_BYTES,
  PROTOCOL_VERSION,
} from "./constants.js";
import { encodeFrame, FrameDecoder } from "./codec.js";
import { serveConnection, type TransportHost, wireError } from "./server.js";
import type { ServerEnvelope } from "./types.js";
import { assertClientEnvelope, assertServerEnvelope } from "./validate.js";
import { BoundedWriter } from "./writer.js";

const ids = {
  project: "01J00000000000000000000010",
  workspace: "01J00000000000000000000011",
  session: "01J00000000000000000000012",
  run: "01J00000000000000000000013",
  request: "01J00000000000000000000014",
  subscription: "01J00000000000000000000015",
};

type Fixture = {
  name: string;
  direction: "client" | "server";
  valid: boolean;
  value: unknown;
};

async function fixtures(): Promise<Fixture[]> {
  return JSON.parse(
    await readFile(new URL("../test/fixtures/protocol-fixtures.json", import.meta.url), "utf8"),
  ) as Fixture[];
}

function fakeHost(): TransportHost {
  const project = { id: ids.project, repoRoot: "/tmp/repo" };
  const workspace = {
    id: ids.workspace,
    projectId: ids.project,
    worktreePath: "/tmp/tree",
    branch: "watt/one",
    slug: "one",
    baseRef: "HEAD",
    createdAt: 1,
    archivedAt: null,
  };
  const session: Session = {
    id: ids.session,
    workspaceId: ids.workspace,
    runtime: "cursor-local",
    cursorAgentId: "cursor-agent",
    mode: "agent",
    model: { id: "composer-2.5", params: [] },
    executionPolicy: {
      autoReview: false,
      sandbox: { enabled: false },
      agentRetries: true,
      toolAllowlist: null,
      toolDenylist: [],
      settingSources: ["project", "user", "plugins"],
    },
    createdAt: 1,
  };
  const run = {
    id: ids.run,
    sessionId: ids.session,
    status: "finished",
    createdAt: 1,
    startedAt: 2,
    finishedAt: 3,
  } as const;
  return {
    async capabilities() {
      return {
        runtime: "cursor-local",
        runtimes: [],
        modes: ["agent", "plan"],
        models: [],
        modelCatalog: {
          status: "unavailable",
          fetchedAt: null,
          error: { message: "offline" },
        },
        executionPolicy: { defaults: session.executionPolicy, controls: [] },
      } satisfies HostCapabilities;
    },
    async close() {},
    async suspend() {},
    projects: {
      async register() {
        return project;
      },
      get: () => project,
      list: () => [project],
      async reconcile() {
        return {
          project,
          repositoryIdentity: "/tmp/repo/.git",
          inspectedAt: 1,
          entries: [],
        };
      },
    },
    workspaces: {
      async create() {
        return workspace;
      },
      get: () => workspace,
      list: () => [workspace],
      async archive() {
        return { ...workspace, archivedAt: 2 };
      },
    },
    sessions: {
      async create() {
        return { session, run };
      },
      get: () => session,
      list: () => [session],
      async send() {
        return { session, run };
      },
    },
    runs: {
      get: () => run,
      list: () => [run],
      async wait() {
        return { runId: ids.run, status: "finished" };
      },
      async cancel() {
        return { runId: ids.run, status: "cancelled" };
      },
      attach(input) {
        return {
          async *[Symbol.asyncIterator]() {
            if (input.afterSequence !== undefined) {
              await new Promise<void>((resolve) => {
                if (input.signal?.aborted) resolve();
                else
                  input.signal?.addEventListener("abort", () => resolve(), {
                    once: true,
                  });
              });
              return;
            }
            yield {
              type: "text_delta",
              text: "hello",
              workspaceId: ids.workspace,
              sessionId: ids.session,
              runId: ids.run,
              sequence: 1,
            };
          },
        };
      },
    },
    cloud: {
      async prepareBase() {
        return { baseSha: "a".repeat(40), baseRef: "main" };
      },
    },
    changesets: {
      async pull() {
        return {
          state: "applied",
          localSha: "a".repeat(40),
          remoteSha: "b".repeat(40),
          head: "c".repeat(40),
        };
      },
      async resolve() {
        return { state: "applied", head: "c".repeat(40) };
      },
      async abort() {
        return { state: "conflicted", head: "a".repeat(40) };
      },
    },
    diagnostics: {
      operations: {
        get: () => undefined,
        list: () => [],
      },
    },
  };
}

async function waitForLength(values: unknown[], length: number): Promise<void> {
  await vi.waitFor(() => expect(values.length).toBeGreaterThanOrEqual(length));
}

describe("desktop sidecar protocol", () => {
  it("accepts and rejects the shared compatibility fixtures", async () => {
    for (const fixture of await fixtures()) {
      const validate = () =>
        fixture.direction === "client"
          ? assertClientEnvelope(fixture.value)
          : assertServerEnvelope(fixture.value);
      if (fixture.valid) expect(validate, fixture.name).not.toThrow();
      else expect(validate, fixture.name).toThrow();
    }
  });

  it("decodes fragmented and coalesced frames", () => {
    const first = encodeFrame({ one: 1 });
    const second = encodeFrame({ two: 2 });
    const decoder = new FrameDecoder();
    expect(decoder.push(first.subarray(0, 2))).toEqual([]);
    expect(decoder.push(Buffer.concat([first.subarray(2), second]))).toEqual([
      { one: 1 },
      { two: 2 },
    ]);
    expect(() => decoder.finish()).not.toThrow();
  });

  it("rejects oversized, malformed UTF-8, and excessive nesting", () => {
    const oversized = Buffer.alloc(4);
    oversized.writeUInt32BE(MAX_FRAME_BYTES + 1);
    expect(() => new FrameDecoder().push(oversized)).toThrowError(
      expect.objectContaining({ code: "frame_too_large" }),
    );
    const invalidUtf8 = Buffer.from([0, 0, 0, 2, 0xc3, 0x28]);
    expect(() => new FrameDecoder().push(invalidUtf8)).toThrowError(
      expect.objectContaining({ code: "invalid_utf8" }),
    );
    const deep = `${"[".repeat(MAX_JSON_DEPTH + 1)}0${"]".repeat(MAX_JSON_DEPTH + 1)}`;
    const frame = Buffer.alloc(4 + Buffer.byteLength(deep));
    frame.writeUInt32BE(Buffer.byteLength(deep));
    frame.write(deep, 4);
    expect(() => new FrameDecoder().push(frame)).toThrowError(
      expect.objectContaining({ code: "json_too_deep" }),
    );
  });

  it("negotiates, routes concurrent requests, streams, and unsubscribes in order", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const received: ServerEnvelope[] = [];
    const decoder = new FrameDecoder();
    output.on("data", (chunk: Buffer) => {
      for (const value of decoder.push(chunk)) received.push(value as ServerEnvelope);
    });
    const host = fakeHost();
    const close = vi.spyOn(host, "close");
    const serving = serveConnection(input, output, async () => host);
    input.write(
      encodeFrame({
        type: "hello",
        protocolVersionMin: 1,
        protocolVersionMax: 1,
        capabilities: ["host.projects.v1", "host.runs.v1", "run-stream.v1"],
        host: { stateDir: "/tmp/state", worktreeRoot: "/tmp/trees" },
      }),
    );
    await waitForLength(received, 1);
    expect(received[0]).toMatchObject({
      type: "hello_ack",
      version: PROTOCOL_VERSION,
    });

    input.write(
      Buffer.concat([
        encodeFrame({
          type: "request",
          version: 1,
          requestId: ids.request,
          method: "projects.list",
          params: {},
        }),
        encodeFrame({
          type: "request",
          version: 1,
          requestId: "01J00000000000000000000016",
          method: "runs.attach",
          params: { runId: ids.run, subscriptionId: ids.subscription },
        }),
      ]),
    );
    await waitForLength(received, 5);
    const attachAck = received.findIndex(
      (value) => value.type === "result" && value.requestId.endsWith("16"),
    );
    const event = received.findIndex((value) => value.type === "run_event");
    const end = received.findIndex((value) => value.type === "stream_end");
    expect(attachAck).toBeGreaterThan(0);
    expect(event).toBeGreaterThan(attachAck);
    expect(end).toBeGreaterThan(event);

    input.write(
      encodeFrame({
        type: "request",
        version: 1,
        requestId: "01J00000000000000000000017",
        method: "runs.attach",
        params: {
          runId: ids.run,
          subscriptionId: "01J00000000000000000000018",
          afterSequence: 1,
        },
      }),
    );
    await waitForLength(received, 6);
    input.write(
      encodeFrame({
        type: "request",
        version: 1,
        requestId: "01J00000000000000000000019",
        method: "runs.unsubscribe",
        params: { subscriptionId: "01J00000000000000000000018" },
      }),
    );
    await waitForLength(received, 8);
    const unsubscribeEnd = received.findIndex(
      (value) => value.type === "stream_end" && value.subscriptionId.endsWith("18"),
    );
    const unsubscribeAck = received.findIndex(
      (value) => value.type === "result" && value.requestId.endsWith("19"),
    );
    expect(unsubscribeEnd).toBeGreaterThan(0);
    expect(unsubscribeAck).toBeGreaterThan(unsubscribeEnd);

    input.end();
    await serving;
    expect(close).toHaveBeenCalledOnce();
  });

  it("suspends the Host through the typed protocol without closing it", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const received: ServerEnvelope[] = [];
    const decoder = new FrameDecoder();
    output.on("data", (chunk: Buffer) => {
      for (const value of decoder.push(chunk)) received.push(value as ServerEnvelope);
    });
    const host = fakeHost();
    const close = vi.spyOn(host, "close");
    const suspend = vi.spyOn(host, "suspend");
    const serving = serveConnection(input, output, async () => host);
    input.write(
      encodeFrame({
        type: "hello",
        protocolVersionMin: 1,
        protocolVersionMax: 1,
        capabilities: ["graceful-suspend.v1"],
        host: { stateDir: "/tmp/state", worktreeRoot: "/tmp/trees" },
      }),
    );
    await waitForLength(received, 1);
    input.write(
      encodeFrame({
        type: "request",
        version: 1,
        requestId: ids.request,
        method: "host.suspend",
        params: {},
      }),
    );

    await waitForLength(received, 2);
    await serving;
    expect(received[1]).toMatchObject({
      type: "result",
      requestId: ids.request,
      result: { suspended: true },
    });
    expect(suspend).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
  });

  it("fails protocol incompatibility before opening the Host", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const received: ServerEnvelope[] = [];
    const decoder = new FrameDecoder();
    output.on("data", (chunk: Buffer) => {
      for (const value of decoder.push(chunk)) received.push(value as ServerEnvelope);
    });
    const hostFactory = vi.fn(async () => fakeHost());
    const serving = serveConnection(input, output, hostFactory);
    input.end(
      encodeFrame({
        type: "hello",
        protocolVersionMin: 2,
        protocolVersionMax: 2,
        capabilities: ["host.projects.v1"],
        host: { stateDir: "/tmp/state", worktreeRoot: "/tmp/trees" },
      }),
    );
    await serving;
    expect(hostFactory).not.toHaveBeenCalled();
    expect(received).toMatchObject([
      {
        type: "error",
        fatal: true,
        error: { code: "protocol_version_unsupported" },
        supportedVersions: [1],
      },
    ]);
  });

  it("closes the Host before waiting for in-flight requests after disconnect", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const host = fakeHost();
    let startWait!: () => void;
    const waitStarted = new Promise<void>((resolve) => {
      startWait = resolve;
    });
    let finishWait!: (result: RunResult) => void;
    const waiting = new Promise<RunResult>((resolve) => {
      finishWait = resolve;
    });
    host.runs.wait = async () => {
      startWait();
      return waiting;
    };
    const close = vi.spyOn(host, "close").mockImplementation(async () => {
      finishWait({ runId: ids.run, status: "cancelled" });
    });
    const serving = serveConnection(input, output, async () => host);
    input.write(
      Buffer.concat([
        encodeFrame({
          type: "hello",
          protocolVersionMin: 1,
          protocolVersionMax: 1,
          capabilities: ["host.runs.v1"],
          host: { stateDir: "/tmp/state", worktreeRoot: "/tmp/trees" },
        }),
        encodeFrame({
          type: "request",
          version: 1,
          requestId: "01J00000000000000000000028",
          method: "runs.wait",
          params: { runId: ids.run },
        }),
      ]),
    );
    await waitStarted;
    input.end();

    const settled = await Promise.race([
      serving.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 500)),
    ]);
    if (!settled) {
      finishWait({ runId: ids.run, status: "cancelled" });
      await serving;
    }
    expect(settled).toBe(true);
    expect(close).toHaveBeenCalledOnce();
  });

  it("sanitizes coded exceptions that are not Watt boundary errors", () => {
    expect(
      wireError(
        Object.assign(new Error("ENOENT: /private/secret/path"), {
          code: "ENOENT",
        }),
      ),
    ).toEqual({
      code: "internal_error",
      message: "internal sidecar error",
    });
    expect(wireError(new HostError("unknown run", "unknown_run"))).toEqual({
      code: "unknown_run",
      message: "unknown run",
    });
  });

  it("settles cancel and unsubscribe races with one stream terminal", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const received: ServerEnvelope[] = [];
    const decoder = new FrameDecoder();
    output.on("data", (chunk: Buffer) => {
      for (const value of decoder.push(chunk)) received.push(value as ServerEnvelope);
    });
    const host = fakeHost();
    let finish!: (result: { runId: string; status: "cancelled" }) => void;
    const terminal = new Promise<{ runId: string; status: "cancelled" }>((resolve) => {
      finish = resolve;
    });
    host.runs.wait = async () => terminal;
    host.runs.cancel = async () => {
      const result = { runId: ids.run, status: "cancelled" as const };
      finish(result);
      return result;
    };
    host.runs.attach = (options) => ({
      async *[Symbol.asyncIterator]() {
        await Promise.race([
          terminal,
          new Promise<void>((resolve) => {
            if (options.signal?.aborted) resolve();
            else
              options.signal?.addEventListener("abort", () => resolve(), {
                once: true,
              });
          }),
        ]);
        yield* [] as never[];
      },
    });
    const serving = serveConnection(input, output, async () => host);
    input.write(
      encodeFrame({
        type: "hello",
        protocolVersionMin: 1,
        protocolVersionMax: 1,
        capabilities: ["host.runs.v1", "run-stream.v1"],
        host: { stateDir: "/tmp/state", worktreeRoot: "/tmp/trees" },
      }),
    );
    await waitForLength(received, 1);
    const subscriptionId = "01J00000000000000000000020";
    input.write(
      encodeFrame({
        type: "request",
        version: 1,
        requestId: "01J00000000000000000000021",
        method: "runs.attach",
        params: { runId: ids.run, subscriptionId },
      }),
    );
    await waitForLength(received, 2);
    input.write(
      Buffer.concat([
        encodeFrame({
          type: "request",
          version: 1,
          requestId: "01J00000000000000000000022",
          method: "runs.cancel",
          params: { runId: ids.run },
        }),
        encodeFrame({
          type: "request",
          version: 1,
          requestId: "01J00000000000000000000023",
          method: "runs.unsubscribe",
          params: { subscriptionId },
        }),
      ]),
    );
    await vi.waitFor(() => {
      expect(
        received.filter(
          (value) =>
            value.type === "result" &&
            (value.requestId.endsWith("22") || value.requestId.endsWith("23")),
        ),
      ).toHaveLength(2);
    });
    expect(
      received.filter(
        (value) => value.type === "stream_end" && value.subscriptionId === subscriptionId,
      ),
    ).toHaveLength(1);
    input.end();
    await serving;
  });

  it("rejects an invalid attachment before acknowledging it", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const received: ServerEnvelope[] = [];
    const decoder = new FrameDecoder();
    output.on("data", (chunk: Buffer) => {
      for (const value of decoder.push(chunk)) received.push(value as ServerEnvelope);
    });
    const host = fakeHost();
    host.runs.attach = () => {
      throw new HostError("unknown run", "unknown_run");
    };
    const serving = serveConnection(input, output, async () => host);
    input.write(
      Buffer.concat([
        encodeFrame({
          type: "hello",
          protocolVersionMin: 1,
          protocolVersionMax: 1,
          capabilities: ["host.runs.v1", "run-stream.v1"],
          host: { stateDir: "/tmp/state", worktreeRoot: "/tmp/trees" },
        }),
        encodeFrame({
          type: "request",
          version: 1,
          requestId: "01J00000000000000000000024",
          method: "runs.attach",
          params: { runId: ids.run, subscriptionId: ids.subscription },
        }),
      ]),
    );
    await waitForLength(received, 2);
    expect(received[1]).toMatchObject({
      type: "error",
      requestId: "01J00000000000000000000024",
      fatal: false,
      error: { code: "unknown_run" },
    });
    expect(received).not.toContainEqual(expect.objectContaining({ type: "stream_end" }));
    input.end();
    await serving;
  });

  it("ends a pipelined unsubscribe before acknowledging it", async () => {
    const input = new PassThrough();
    const received: ServerEnvelope[] = [];
    const decoder = new FrameDecoder();
    const output = new Writable({
      highWaterMark: 1,
      write(chunk: Buffer, _encoding, callback) {
        for (const value of decoder.push(chunk)) received.push(value as ServerEnvelope);
        setImmediate(callback);
      },
    });
    const host = fakeHost();
    const serving = serveConnection(input, output, async () => host);
    input.write(
      Buffer.concat([
        encodeFrame({
          type: "hello",
          protocolVersionMin: 1,
          protocolVersionMax: 1,
          capabilities: ["host.runs.v1", "run-stream.v1"],
          host: { stateDir: "/tmp/state", worktreeRoot: "/tmp/trees" },
        }),
        encodeFrame({
          type: "request",
          version: 1,
          requestId: "01J00000000000000000000025",
          method: "runs.attach",
          params: {
            runId: ids.run,
            subscriptionId: "01J00000000000000000000026",
            afterSequence: 1,
          },
        }),
        encodeFrame({
          type: "request",
          version: 1,
          requestId: "01J00000000000000000000027",
          method: "runs.unsubscribe",
          params: { subscriptionId: "01J00000000000000000000026" },
        }),
      ]),
    );
    await vi.waitFor(() => {
      expect(
        received.some((value) => value.type === "result" && value.requestId.endsWith("27")),
      ).toBe(true);
    });
    const end = received.findIndex(
      (value) => value.type === "stream_end" && value.subscriptionId.endsWith("26"),
    );
    const acknowledgement = received.findIndex(
      (value) => value.type === "result" && value.requestId.endsWith("27"),
    );
    expect(end).toBeGreaterThan(0);
    expect(acknowledgement).toBeGreaterThan(end);
    input.end();
    await serving;
  });

  it("bounds outbound buffering while honoring writable backpressure", async () => {
    const output = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, callback) {
        setTimeout(callback, 1);
      },
    });
    const writer = new BoundedWriter(output);
    const sends = Array.from({ length: 300 }, (_, index) =>
      writer.send({ index, payload: "x".repeat(32 * 1024) }),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    expect(writer.queuedBytes).toBeLessThanOrEqual(MAX_OUTBOUND_QUEUE_BYTES);
    expect(writer.queuedMessages).toBeLessThanOrEqual(256);
    await Promise.all(sends);
    await writer.close();
  });
});
