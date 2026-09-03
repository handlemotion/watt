import { describe, expect, it, vi } from "vitest";

import { createCloudDaemon, stripBootstrapSecrets } from "./index.js";

function fakeHost() {
  return {
    capabilities: vi.fn(async () => ({ runtime: "cursor-local" })),
    projects: {
      register: vi.fn(),
      get: vi.fn(),
      list: vi.fn(() => []),
      reconcile: vi.fn(),
    },
    workspaces: {
      create: vi.fn(),
      get: vi.fn(),
      list: vi.fn(),
      archive: vi.fn(),
    },
    sessions: { create: vi.fn(), get: vi.fn(), list: vi.fn(), send: vi.fn() },
    runs: {
      get: vi.fn(),
      list: vi.fn(),
      wait: vi.fn(),
      cancel: vi.fn(),
      attach: vi.fn(),
    },
    cloud: { prepareBase: vi.fn() },
    changesets: { pull: vi.fn(), resolve: vi.fn(), abort: vi.fn() },
    diagnostics: { operations: { get: vi.fn(), list: vi.fn() } },
    close: vi.fn(),
  };
}

describe("cloud daemon", () => {
  it("requires authentication for host calls", async () => {
    const response = await createCloudDaemon({
      host: fakeHost() as never,
      authToken: "test-secret",
    }).request("/v1/host/call", {
      method: "POST",
      body: JSON.stringify({ method: "projects.list", params: {} }),
    });
    expect(response.status).toBe(401);
  });

  it("routes typed JSON calls", async () => {
    const host = fakeHost();
    const response = await createCloudDaemon({
      host: host as never,
      authToken: "test-secret",
    }).request("/v1/host/call", {
      method: "POST",
      headers: {
        "x-watt-daemon-token": "test-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({ method: "projects.list", params: {} }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: [] });
  });

  it("enforces JSON limits even without Content-Length", async () => {
    const response = await createCloudDaemon({
      host: fakeHost() as never,
      authToken: "test-secret",
      maxJsonBytes: 32,
    }).request("/v1/host/call", {
      method: "POST",
      headers: {
        "x-watt-daemon-token": "test-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        method: "projects.list",
        params: {},
        padding: "x".repeat(64),
      }),
    });
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "payload_too_large",
        message: "request body is too large",
      },
    });
  });

  it("removes provider secrets before agent startup", () => {
    const environment = {
      UPSTASH_BOX_API_KEY: "a",
      CURSOR_API_KEY: "b",
      GITHUB_TOKEN: "c",
    };
    stripBootstrapSecrets(environment);
    expect(environment).toEqual({});
  });
});
