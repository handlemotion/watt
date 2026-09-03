import { describe, expect, it, vi } from "vitest";

import { WattCloudClient } from "./index.js";

describe("WattCloudClient", () => {
  it("exchanges a native PKCE code at the OAuth token endpoint", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({
        "content-type": "application/x-www-form-urlencoded",
      });
      expect(String(init?.body)).toContain("code_verifier=verifier");
      return Response.json({
        access_token: "access",
        refresh_token: "refresh",
        expires_in: 900,
      });
    });
    const client = new WattCloudClient({
      baseUrl: "https://watt.example",
      accessToken: () => undefined,
      fetch: fetch as typeof globalThis.fetch,
    });

    await expect(
      client.auth.exchangeCode({
        code: "code",
        codeVerifier: "verifier",
        redirectUri: "http://127.0.0.1:49152/oauth/callback",
      }),
    ).resolves.toEqual({
      accessToken: "access",
      refreshToken: "refresh",
      expiresIn: 900,
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://watt.example/api/auth/oauth2/token",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("keeps local cloud seed identity stable across retries", async () => {
    const prepareBase = vi.fn(async (input: { seedId: string }) => ({
      baseSha: "a".repeat(40),
      baseRef: "watt/seed/local",
      seedRef: input.seedId,
    }));
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient cloud failure"))
      .mockResolvedValueOnce(Response.json({}));
    const client = new WattCloudClient({
      baseUrl: "https://watt.example",
      accessToken: () => "access",
      fetch: fetch as typeof globalThis.fetch,
      localCloudBase: { prepareBase },
    });
    const input = {
      repositoryId: "repository-1",
      title: "Local chat",
      localWorkspaceId: "workspace-1",
      prompt: "Continue",
    };

    await expect(client.chats.createFromLocal(input, "local-key-12345678")).rejects.toThrow(
      "transient cloud failure",
    );
    await expect(client.chats.createFromLocal(input, "local-key-12345678")).resolves.toEqual({});

    expect(prepareBase).toHaveBeenCalledTimes(2);
    const firstSeedId = prepareBase.mock.calls[0]?.[0].seedId;
    expect(firstSeedId).toBe(prepareBase.mock.calls[1]?.[0].seedId);
    expect(firstSeedId).toMatch(/^seed-[0-9a-f]{32}$/);
  });

  it("preserves replay-then-tail SSE ordering", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'id: 2\nevent: run_event\ndata: {"type":"text_delta","text":"replayed","workspaceId":"w","sessionId":"s","runId":"r","sequence":2}\n\nid: 3\nevent: run_event\ndata: {"type":"text_delta","text":"tail","workspaceId":"w","sessionId":"s","runId":"r","sequence":3}\n\nevent: run_end\ndata: {"runId":"r","status":"finished"}\n\n',
          ),
        );
        controller.close();
      },
    });
    const fetch = vi.fn(async () => new Response(stream));
    const client = new WattCloudClient({
      baseUrl: "https://watt.example",
      accessToken: () => "access",
      fetch: fetch as typeof globalThis.fetch,
    });

    const received = [];
    for await (const item of client.runs.attach("r", { afterSequence: 1 })) {
      received.push(item);
    }

    expect(received).toEqual([
      expect.objectContaining({ text: "replayed", sequence: 2 }),
      expect.objectContaining({ text: "tail", sequence: 3 }),
      { runId: "r", status: "finished" },
    ]);
    expect(fetch.mock.calls[0]?.[0]).toBe("https://watt.example/v1/runs/r/events?afterSequence=1");
  });

  it("reports an idempotent local pull transition to the cloud API", async () => {
    const changeset = {
      id: "changeset-1",
      chatId: "chat-1",
      runId: "run-1",
      state: "published",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      errorCode: null,
      createdAt: "2026-08-31T00:00:00.000Z",
      updatedAt: "2026-08-31T00:00:00.000Z",
    } as const;
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json(changeset))
      .mockResolvedValueOnce(
        Response.json({
          id: "chat-1",
          ownerId: "owner-1",
          repositoryId: "repository-1",
          title: "Chat",
          branch: "watt/cloud/chat-1",
          baseRef: "main",
          baseSha: "a".repeat(40),
          workspaceId: "cloud-workspace",
          sessionId: "session-1",
          executionLocation: "cloud",
          createdAt: "2026-08-31T00:00:00.000Z",
          updatedAt: "2026-08-31T00:00:00.000Z",
          archivedAt: null,
        }),
      )
      .mockResolvedValueOnce(Response.json({ ...changeset, state: "applied" }));
    const pull = vi.fn(async () => ({
      state: "applied" as const,
      headSha: "c".repeat(40),
    }));
    const client = new WattCloudClient({
      baseUrl: "https://watt.example",
      accessToken: () => "access",
      fetch: fetch as typeof globalThis.fetch,
      localChangesets: {
        pull,
        resolve: vi.fn(),
        abort: vi.fn(),
      },
    });

    await expect(
      client.changesets.pull(
        "changeset-1",
        { localWorkspaceId: "workspace-1", expectedLocalSha: "a".repeat(40) },
        "pull-key-12345678",
      ),
    ).resolves.toMatchObject({ state: "applied" });
    expect(pull).toHaveBeenCalledOnce();
    const transition = fetch.mock.calls[2];
    expect(transition?.[0]).toBe("https://watt.example/v1/changesets/changeset-1/transitions");
    const transitionHeaders = transition?.[1]?.headers as Headers | undefined;
    expect(transitionHeaders?.get("idempotency-key")).toBe("pull-key-12345678");
  });
});
