import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("cloud API public boundaries", () => {
  it("reports readiness without disclosing configuration", async () => {
    const response = await SELF.fetch("https://watt.example/health");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ready",
      service: "watt-cloud-api",
    });
  });

  it("rejects unsigned and oversized GitHub webhooks", async () => {
    const unsigned = await SELF.fetch("https://watt.example/webhooks/github", {
      method: "POST",
      body: "{}",
    });
    expect(unsigned.status).toBe(401);

    const oversized = await SELF.fetch("https://watt.example/webhooks/github", {
      method: "POST",
      headers: { "content-length": String(1024 * 1024 + 1) },
      body: "{}",
    });
    expect(oversized.status).toBe(413);
  });

  it("accepts a correctly signed GitHub webhook", async () => {
    const body = new TextEncoder().encode('{"installation":{"id":42}}');
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(env.GITHUB_WEBHOOK_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, body))]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const response = await SELF.fetch("https://watt.example/webhooks/github", {
      method: "POST",
      headers: { "x-hub-signature-256": `sha256=${signature}` },
      body,
    });
    expect(response.status).toBe(202);
  });

  it("rejects oversized API requests before authentication or parsing", async () => {
    const response = await SELF.fetch("https://watt.example/v1/chats", {
      method: "POST",
      headers: { "content-length": String(256 * 1024 + 1) },
      body: "{}",
    });
    expect(response.status).toBe(413);
  });

  it("rejects oversized bodies when Content-Length is absent", async () => {
    const response = await SELF.fetch("https://watt.example/webhooks/github", {
      method: "POST",
      headers: { "x-hub-signature-256": `sha256=${"0".repeat(64)}` },
      body: new Uint8Array(1024 * 1024 + 1),
    });
    expect(response.status).toBe(413);
  });
});
