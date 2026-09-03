import { afterEach, describe, expect, it, vi } from "vitest";

import { mapUpstashStatus, UpstashBoxClient } from "../src/upstash.js";

afterEach(() => vi.unstubAllGlobals());

describe("UpstashBoxClient", () => {
  it("creates the default small node profile", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ id: "box-1", status: "creating" }))
      .mockResolvedValueOnce(Response.json({ id: "box-1", status: "idle" }))
      .mockResolvedValueOnce(Response.json({ status: "idle" }));
    vi.stubGlobal("fetch", fetch);
    const client = new UpstashBoxClient({ apiKey: "box-key" });

    await expect(client.create("owner-1", { PORT: "8788" })).resolves.toEqual({
      id: "box-1",
      status: "idle",
    });

    const create = fetch.mock.calls[0];
    expect(create?.[0]).toBe("https://us-east-1.box.upstash.com/v2/box");
    expect(JSON.parse(String(create?.[1]?.body))).toMatchObject({
      runtime: "node",
      size: "small",
      name: "watt-owner-1",
    });
  });

  it("maps paused boxes to stopped and resumes before bootstrap", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ id: "box-1", status: "paused" }))
      .mockResolvedValueOnce(Response.json({ status: "paused" }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(Response.json({ status: "idle" }))
      .mockResolvedValueOnce(Response.json({ exit_code: 0, output: "", error: "" }));
    vi.stubGlobal("fetch", fetch);

    await expect(new UpstashBoxClient({ apiKey: "box-key" }).resume("box-1")).resolves.toEqual({
      id: "box-1",
      status: "idle",
    });
    expect(
      fetch.mock.calls.some(
        ([input, init]) => String(input).endsWith("/resume") && init?.method === "POST",
      ),
    ).toBe(true);
    expect(mapUpstashStatus("paused")).toBe("stopped");
  });

  it("runs bootstrap with root privileges", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ id: "box-1", status: "idle" }))
      .mockResolvedValueOnce(Response.json({ exit_code: 0, output: "", error: "" }));
    vi.stubGlobal("fetch", fetch);

    await new UpstashBoxClient({ apiKey: "box-key" }).bootstrap("box-1", {
      daemonToken: "daemon-token",
      cursorApiKey: "cursor-key",
    });

    const request = fetch.mock.calls.at(-1)?.[1];
    expect(JSON.parse(String(request?.body)).command).toEqual([
      "sh",
      "-c",
      expect.stringMatching(/^sudo -E env CLOUD_DAEMON_TOKEN=/),
    ]);
  });

  it("returns null for missing boxes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("missing", { status: 404 })),
    );
    await expect(
      new UpstashBoxClient({ apiKey: "box-key" }).get("box-missing"),
    ).resolves.toBeNull();
  });

  it("creates bearer-token public URLs without leaking provider bodies", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ id: "box-1", status: "idle" }))
      .mockResolvedValueOnce(Response.json({ previews: [] }))
      .mockResolvedValueOnce(
        Response.json({
          url: "https://box-1-8788.preview.box.upstash.com",
          port: 8788,
          token: "ingress-token",
        }),
      );
    vi.stubGlobal("fetch", fetch);

    await expect(
      new UpstashBoxClient({ apiKey: "box-key" }).createIngress("box-1", 8788),
    ).resolves.toEqual({
      url: "https://box-1-8788.preview.box.upstash.com",
      bearerToken: "ingress-token",
    });
  });

  it("surfaces provider failures without response bodies", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("provider secret", {
            status: 503,
            statusText: "Unavailable",
          }),
      ),
    );
    await expect(new UpstashBoxClient({ apiKey: "box-key" }).get("box-1")).rejects.toThrow(
      "upstash_503",
    );
  });

  it("rejects malformed public URL responses", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ id: "box-1", status: "idle" }))
      .mockResolvedValueOnce(Response.json({ previews: [] }))
      .mockResolvedValueOnce(
        Response.json({
          url: "https://box-1-8788.preview.box.upstash.com",
          port: 8788,
        }),
      );
    vi.stubGlobal("fetch", fetch);
    await expect(
      new UpstashBoxClient({ apiKey: "box-key" }).createIngress("box-1", 8788),
    ).rejects.toThrow("upstash_invalid_response");
  });
});
