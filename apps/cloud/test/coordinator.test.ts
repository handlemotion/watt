import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllGlobals());

function upstashFetch(boxId: string) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/v2/box") && init?.method === "POST") {
      return Response.json({ id: boxId, status: "creating" });
    }
    if (url.endsWith(`/v2/box/${boxId}`) && init?.method !== "POST") {
      return Response.json({ id: boxId, status: "idle" });
    }
    if (url.endsWith(`/v2/box/${boxId}/status`)) {
      return Response.json({ status: "idle" });
    }
    if (url.endsWith(`/v2/box/${boxId}/resume`)) {
      return new Response(null, { status: 204 });
    }
    if (url.endsWith(`/v2/box/${boxId}/preview`) && init?.method === "GET") {
      return Response.json({ previews: [] });
    }
    if (url.endsWith(`/v2/box/${boxId}/preview`) && init?.method === "POST") {
      return Response.json({
        url: "https://daemon.invalid",
        port: 8788,
        token: "ingress-token",
      });
    }
    if (url.endsWith(`/v2/box/${boxId}/exec`)) {
      return Response.json({ exit_code: 0, output: "", error: "" });
    }
    if (url.endsWith(`/v2/box/${boxId}/pause`)) {
      return new Response(null, { status: 204 });
    }
    if (url.startsWith("https://daemon.invalid/health")) {
      return Response.json({ status: "ready" });
    }
    if (url.startsWith("https://daemon.invalid/")) {
      return Response.json({ error: "unavailable" }, { status: 503 });
    }
    throw new Error(`unexpected request: ${url}`);
  });
}

describe("CloudHostCoordinator", () => {
  it("serializes and replays idempotent mutations per owner", async () => {
    const coordinator = env.CLOUD_HOST_COORDINATOR.getByName("owner-1");
    const claims = await Promise.all([
      coordinator.beginMutation("chat.create", "key-12345678", "hash-a"),
      coordinator.beginMutation("chat.create", "key-12345678", "hash-a"),
    ]);
    expect(claims).toContainEqual({ state: "new" });
    expect(claims).toContainEqual({ state: "in_progress" });
    await coordinator.finishMutation(
      "chat.create",
      "key-12345678",
      JSON.stringify({ id: "chat-1" }),
    );
    await expect(
      coordinator.beginMutation("chat.create", "key-12345678", "hash-a"),
    ).resolves.toEqual({
      state: "replay",
      responseJson: JSON.stringify({ id: "chat-1" }),
    });
    await expect(
      coordinator.beginMutation("chat.create", "key-12345678", "hash-b"),
    ).resolves.toEqual({ state: "conflict" });
  });

  it("allows only one owner mutation to execute at a time", async () => {
    const coordinator = env.CLOUD_HOST_COORDINATOR.getByName("owner-mutation");
    await expect(
      coordinator.beginMutation("chat.create", "create-12345678", "hash-a"),
    ).resolves.toEqual({ state: "new" });
    await expect(
      coordinator.beginMutation("chat.send", "send-1234567890", "hash-b"),
    ).resolves.toEqual({ state: "in_progress" });
    await coordinator.finishMutation(
      "chat.create",
      "create-12345678",
      JSON.stringify({ id: "chat-1" }),
    );
    await expect(
      coordinator.beginMutation("chat.send", "send-1234567890", "hash-b"),
    ).resolves.toEqual({ state: "new" });
  });

  it("enforces owner-local request windows", async () => {
    const coordinator = env.CLOUD_HOST_COORDINATOR.getByName("owner-rate");
    await expect(coordinator.takeRateLimit("api", 1, 60_000)).resolves.toEqual({
      allowed: true,
      retryAfterSeconds: 0,
    });
    await expect(coordinator.takeRateLimit("api", 1, 60_000)).resolves.toMatchObject({
      allowed: false,
    });
  });

  it("keeps a terminal-status poll recoverable when the daemon is unavailable", async () => {
    const coordinator = env.CLOUD_HOST_COORDINATOR.getByName("owner-alarm");
    const fetch = upstashFetch("box-alarm");
    vi.stubGlobal("fetch", fetch);

    await coordinator.beginRun("owner-alarm", "run-alarm", {
      installationId: 42,
      baseSha: "a".repeat(40),
      branch: "watt/cloud/00000000-0000-5000-8000-000000000000",
      repositoryUrl: "https://github.com/example/repository.git",
    });

    await expect(runDurableObjectAlarm(coordinator)).resolves.toBe(true);

    await expect(coordinator.status("owner-alarm")).resolves.toMatchObject({
      status: "ready",
      activeRuns: 1,
    });
    expect(fetch.mock.calls.some(([input]) => String(input).includes("/exec"))).toBe(true);
    await coordinator.endRun("owner-alarm", "run-alarm");
  });

  it("reboots a ready host when the daemon configuration generation changes", async () => {
    const coordinator = env.CLOUD_HOST_COORDINATOR.getByName("owner-config-rotation");
    const fetch = upstashFetch("box-config-rotation");
    vi.stubGlobal("fetch", fetch);

    await runInDurableObject(coordinator, async (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO host (owner_id, box_id, status, error_code, ingress_url, ingress_bearer_token, idle_deadline, daemon_config_version) VALUES (?, ?, 'ready', NULL, ?, ?, NULL, ?)",
        "owner-config-rotation",
        "box-config-rotation",
        "https://daemon.invalid",
        "ingress-token",
        "old-config-version",
      );
    });

    await expect(coordinator.wake("owner-config-rotation")).resolves.toEqual({ status: "ready" });
    const bootstrap = fetch.mock.calls.find(([input]) =>
      String(input).endsWith("/v2/box/box-config-rotation/exec"),
    );
    expect(String(bootstrap?.[1]?.body)).toContain(
      `WATT_DAEMON_CONFIG_VERSION='${env.CLOUD_DAEMON_CONFIG_VERSION}'`,
    );
    await runInDurableObject(coordinator, async (_instance, state) => {
      const row = state.storage.sql
        .exec<{ daemon_config_version: string }>(
          "SELECT daemon_config_version FROM host WHERE owner_id = ?",
          "owner-config-rotation",
        )
        .one();
      expect(row.daemon_config_version).toBe(env.CLOUD_DAEMON_CONFIG_VERSION);
    });
  });

  it("preserves the replay cursor and authenticates ingress separately", async () => {
    const coordinator = env.CLOUD_HOST_COORDINATOR.getByName("owner-proxy");
    let proxiedHeaders: Headers | undefined;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v2/box") && init?.method === "POST") {
        return Response.json({ id: "box-proxy", status: "creating" });
      }
      if (url.endsWith("/v2/box/box-proxy")) {
        return Response.json({ id: "box-proxy", status: "idle" });
      }
      if (url.endsWith("/v2/box/box-proxy/status")) {
        return Response.json({ status: "idle" });
      }
      if (url.endsWith("/v2/box/box-proxy/preview") && init?.method === "GET") {
        return Response.json({ previews: [] });
      }
      if (url.endsWith("/v2/box/box-proxy/preview") && init?.method === "POST") {
        return Response.json({
          url: "https://daemon.invalid",
          port: 8788,
          token: "ingress-token",
        });
      }
      if (url.endsWith("/v2/box/box-proxy/exec")) {
        return Response.json({ exit_code: 0, output: "", error: "" });
      }
      if (url.startsWith("https://daemon.invalid/health")) {
        return Response.json({ status: "ready" });
      }
      if (url.startsWith("https://daemon.invalid/v1/runs/")) {
        proxiedHeaders = new Headers(init?.headers);
        return new Response("stream");
      }
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetch);

    using response = await coordinator.proxy(
      "owner-proxy",
      "/v1/runs/run-1/events?afterSequence=42",
      new Request("https://coordinator.invalid"),
    );
    await response.text();
    using replay = await coordinator.proxy(
      "owner-proxy",
      "/v1/runs/run-1/events?afterSequence=43",
      new Request("https://coordinator.invalid"),
    );
    await replay.text();

    expect(proxiedHeaders?.get("authorization")).toBe("Bearer ingress-token");
    expect(proxiedHeaders?.get("x-watt-daemon-token")).toBe(env.CLOUD_DAEMON_TOKEN);
    expect(String(fetch.mock.calls.at(-1)?.[0])).toContain("afterSequence=43");
    expect(
      fetch.mock.calls.filter(
        ([input, init]) =>
          String(input).endsWith("/v2/box/box-proxy/preview") && init?.method === "POST",
      ),
    ).toHaveLength(1);
    const createBox = fetch.mock.calls.find(
      ([input, init]) => String(input).endsWith("/v2/box") && init?.method === "POST",
    );
    const createBody = String(createBox?.[1]?.body);
    expect(createBody).not.toContain("CLOUD_DAEMON_TOKEN");
    expect(createBody).not.toContain("CURSOR_API_KEY");
  });

  it("schedules an eight-minute idle pause after the final run ends", async () => {
    const coordinator = env.CLOUD_HOST_COORDINATOR.getByName("owner-policy");
    vi.stubGlobal("fetch", upstashFetch("box-policy"));

    await coordinator.beginRun("owner-policy", "run-policy", {
      installationId: 42,
      baseSha: "a".repeat(40),
      branch: "watt/cloud/00000000-0000-5000-8000-000000000000",
      repositoryUrl: "https://github.com/example/repository.git",
    });
    await runInDurableObject(coordinator, async (_instance, state) => {
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
    await coordinator.endRun("owner-policy", "run-policy");
    await runInDurableObject(coordinator, async (_instance, state) => {
      const alarm = await state.storage.getAlarm();
      expect(alarm).not.toBeNull();
      expect(alarm! - Date.now()).toBeGreaterThan(7 * 60_000);
    });
  });
});
