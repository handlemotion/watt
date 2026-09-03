import type { HostEvent, Run, RunResult, Session } from "@watt/host";
import type { HostMethodMap } from "@watt/host-protocol";

export type ModelSelection = {
  id: string;
  params: Array<{ id: string; value: string }>;
};

export type ExecutionLocation = "local" | "cloud";
export type CloudHostStatus = "provisioning" | "starting" | "ready" | "stopped" | "error";
export type ChangesetState =
  | "no_changes"
  | "needs_commit"
  | "published"
  | "conflicted"
  | "resolving"
  | "applied"
  | "needs_attention";
export type CloudRepository = {
  id: string;
  ownerId: string;
  githubRepositoryId: number;
  installationId: number;
  repositoryOwner: string;
  name: string;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
};
export type DiscoveredRepository = {
  id: number;
  name: string;
  default_branch: string;
  owner: { id: number; login: string };
  installationId: number;
};
export type CloudChat = {
  id: string;
  ownerId: string;
  repositoryId: string;
  title: string;
  branch: string;
  baseRef: string;
  baseSha: string;
  workspaceId: string | null;
  sessionId: string | null;
  executionLocation: "cloud";
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
};
export type Changeset = {
  id: string;
  chatId: string;
  runId: string;
  state: ChangesetState;
  baseSha: string;
  headSha: string | null;
  expectedLocalSha?: string | null;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
};
export type CloudRun = {
  run: Run;
  session: Session;
  executionLocation: "cloud";
};
export type ApiErrorBody = {
  error: {
    code: string;
    message: string;
    details?: Readonly<Record<string, unknown>>;
  };
};

export class CloudApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "CloudApiError";
  }
}

export type LocalChangesetTransport = {
  pull(input: {
    changeset: Changeset;
    chat: CloudChat;
    localWorkspaceId: string;
    expectedLocalSha: string;
    idempotencyKey: string;
  }): Promise<LocalChangesetResult>;
  resolve(input: {
    changeset: Changeset;
    chat: CloudChat;
    localWorkspaceId: string;
    idempotencyKey: string;
    preferredModel: "composer-2.5";
  }): Promise<LocalChangesetResult>;
  abort(input: {
    changeset: Changeset;
    chat: CloudChat;
    localWorkspaceId: string;
    idempotencyKey: string;
  }): Promise<LocalChangesetResult>;
};
export type LocalChangesetResult = {
  state: "conflicted" | "resolving" | "applied" | "needs_attention";
  headSha?: string | null;
  errorCode?: string | null;
};
export type LocalCloudBaseTransport = {
  prepareBase(input: {
    seedId: string;
    workspaceId: string;
    remote?: string;
    expectedLocalSha?: string;
    idempotencyKey: string;
  }): Promise<{ baseSha: string; baseRef: string; seedRef?: string }>;
};
export type WattCloudClientOptions = {
  baseUrl: string;
  accessToken: () => string | undefined | Promise<string | undefined>;
  fetch?: typeof globalThis.fetch;
  localChangesets?: LocalChangesetTransport;
  localCloudBase?: LocalCloudBaseTransport;
};

export class WattCloudClient {
  readonly #baseUrl: string;
  readonly #token: WattCloudClientOptions["accessToken"];
  readonly #fetch: typeof globalThis.fetch;
  readonly #localChangesets: LocalChangesetTransport | undefined;
  readonly #localCloudBase: LocalCloudBaseTransport | undefined;
  constructor(options: WattCloudClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#token = options.accessToken;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#localChangesets = options.localChangesets;
    this.#localCloudBase = options.localCloudBase;
  }

  async #request<T>(
    method: string,
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<T> {
    const token = await this.#token();
    const headers = new Headers({ accept: "application/json" });
    if (token) headers.set("authorization", `Bearer ${token}`);
    if (body !== undefined) headers.set("content-type", "application/json");
    if (idempotencyKey) headers.set("idempotency-key", idempotencyKey);
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      const value = (await response.json().catch(() => ({
        error: { code: "http_error", message: response.statusText },
      }))) as ApiErrorBody;
      throw new CloudApiError(
        response.status,
        value.error.code,
        value.error.message,
        value.error.details,
      );
    }
    return (await response.json()) as T;
  }

  async #oauthToken(
    input: Record<string, string>,
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    const response = await this.#fetch(`${this.#baseUrl}/api/auth/oauth2/token`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(input),
    });
    const value = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };
    if (!response.ok || !value.access_token || !value.refresh_token) {
      throw new CloudApiError(
        response.status,
        value.error ?? "oauth_token_error",
        value.error_description ?? "OAuth token exchange failed",
      );
    }
    return {
      accessToken: value.access_token,
      refreshToken: value.refresh_token,
      expiresIn: value.expires_in ?? 900,
    };
  }

  auth = {
    nativeAuthorizationUrl: (input: {
      redirectUri: string;
      codeChallenge: string;
      state: string;
    }) => {
      const query = new URLSearchParams({
        client_id: "watt-desktop",
        response_type: "code",
        code_challenge_method: "S256",
        redirect_uri: input.redirectUri,
        code_challenge: input.codeChallenge,
        state: input.state,
        resource: `${this.#baseUrl}/v1`,
        scope: "openid profile email offline_access",
      });
      return `${this.#baseUrl}/api/auth/oauth2/authorize?${query}`;
    },
    exchangeCode: (input: { code: string; codeVerifier: string; redirectUri: string }) =>
      this.#oauthToken({
        grant_type: "authorization_code",
        client_id: "watt-desktop",
        code: input.code,
        code_verifier: input.codeVerifier,
        redirect_uri: input.redirectUri,
        resource: `${this.#baseUrl}/v1`,
      }),
    refresh: (refreshToken: string) =>
      this.#oauthToken({
        grant_type: "refresh_token",
        client_id: "watt-desktop",
        refresh_token: refreshToken,
        resource: `${this.#baseUrl}/v1`,
      }),
  };
  repositories = {
    list: () => this.#request<CloudRepository[]>("GET", "/v1/repositories"),
    discover: () => this.#request<DiscoveredRepository[]>("GET", "/v1/repositories/discover"),
    connect: (githubRepositoryId: number, installationId: number) =>
      this.#request<CloudRepository>("POST", "/v1/repositories", {
        githubRepositoryId,
        installationId,
      }),
  };
  host = {
    status: () =>
      this.#request<{
        status: CloudHostStatus;
        activeRuns: number;
        executionLocation: "cloud";
      }>("GET", "/v1/cloud-host"),
    wake: () =>
      this.#request<{
        status: CloudHostStatus;
        executionLocation: "cloud";
      }>("POST", "/v1/cloud-host/wake"),
  };
  chats = {
    list: () => this.#request<CloudChat[]>("GET", "/v1/chats"),
    get: (chatId: string) =>
      this.#request<CloudChat>("GET", `/v1/chats/${encodeURIComponent(chatId)}`),
    archive: (chatId: string, idempotencyKey: string) =>
      this.#request<CloudChat>(
        "POST",
        `/v1/chats/${encodeURIComponent(chatId)}/archive`,
        undefined,
        idempotencyKey,
      ),
    create: (
      input: {
        repositoryId: string;
        title: string;
        baseRef: string;
        baseSha: string;
        seedRef?: string;
        prompt: string;
        model?: ModelSelection;
      },
      idempotencyKey: string,
    ) =>
      this.#request<{ chat: CloudChat; run: CloudRun }>("POST", "/v1/chats", input, idempotencyKey),
    createFromLocal: async (
      input: {
        repositoryId: string;
        title: string;
        localWorkspaceId: string;
        remote?: string;
        expectedLocalSha?: string;
        prompt: string;
        model?: ModelSelection;
      },
      idempotencyKey: string,
    ) => {
      if (!this.#localCloudBase)
        throw new CloudApiError(
          501,
          "local_transport_required",
          "creating from local HEAD requires the local Watt transport",
        );
      const base = await this.#localCloudBase.prepareBase({
        seedId: crypto.randomUUID(),
        workspaceId: input.localWorkspaceId,
        remote: input.remote,
        expectedLocalSha: input.expectedLocalSha,
        idempotencyKey: `${idempotencyKey.slice(0, 194)}:seed`,
      });
      return this.#request<{ chat: CloudChat; run: CloudRun }>(
        "POST",
        "/v1/chats",
        {
          repositoryId: input.repositoryId,
          title: input.title,
          prompt: input.prompt,
          model: input.model,
          ...base,
        },
        idempotencyKey,
      );
    },
    send: (chatId: string, prompt: string, idempotencyKey: string) =>
      this.#request<CloudRun>(
        "POST",
        `/v1/chats/${encodeURIComponent(chatId)}/messages`,
        { prompt },
        idempotencyKey,
      ),
  };
  runs = {
    cancel: (runId: string) =>
      this.#request<RunResult>("POST", `/v1/runs/${encodeURIComponent(runId)}/cancel`),
    attach: (runId: string, options: { afterSequence?: number; signal?: AbortSignal } = {}) =>
      this.#attach(runId, options),
  };
  changesets = {
    list: (chatId: string) =>
      this.#request<Changeset[]>("GET", `/v1/chats/${encodeURIComponent(chatId)}/changesets`),
    get: (changesetId: string) =>
      this.#request<Changeset>("GET", `/v1/changesets/${encodeURIComponent(changesetId)}`),
    pull: async (
      changesetId: string,
      input: { localWorkspaceId: string; expectedLocalSha: string },
      idempotencyKey: string,
    ) => {
      if (!this.#localChangesets)
        throw new CloudApiError(
          501,
          "local_transport_required",
          "pull changes requires the local Watt transport",
        );
      const changeset = await this.changesets.get(changesetId);
      const local = await this.#localChangesets.pull({
        changeset,
        chat: await this.chats.get(changeset.chatId),
        ...input,
        idempotencyKey,
      });
      return this.#request<Changeset>(
        "POST",
        `/v1/changesets/${encodeURIComponent(changesetId)}/transitions`,
        {
          state: local.state,
          expectedLocalSha: input.expectedLocalSha,
          headSha: local.headSha ?? undefined,
          errorCode: local.errorCode ?? undefined,
        },
        idempotencyKey,
      );
    },
    resolve: async (
      changesetId: string,
      input: { localWorkspaceId: string },
      idempotencyKey: string,
    ) => {
      if (!this.#localChangesets)
        throw new CloudApiError(
          501,
          "local_transport_required",
          "resolve requires the local Watt transport",
        );
      const changeset = await this.changesets.get(changesetId);
      const local = await this.#localChangesets.resolve({
        changeset,
        chat: await this.chats.get(changeset.chatId),
        ...input,
        idempotencyKey,
        preferredModel: "composer-2.5",
      });
      return this.#request<Changeset>(
        "POST",
        `/v1/changesets/${encodeURIComponent(changesetId)}/transitions`,
        {
          state: local.state,
          headSha: local.headSha ?? undefined,
          errorCode: local.errorCode ?? undefined,
        },
        idempotencyKey,
      );
    },
    abort: async (
      changesetId: string,
      input: { localWorkspaceId: string },
      idempotencyKey: string,
    ) => {
      if (!this.#localChangesets)
        throw new CloudApiError(
          501,
          "local_transport_required",
          "abort requires the local Watt transport",
        );
      const changeset = await this.changesets.get(changesetId);
      const local = await this.#localChangesets.abort({
        changeset,
        chat: await this.chats.get(changeset.chatId),
        ...input,
        idempotencyKey,
      });
      return this.#request<Changeset>(
        "POST",
        `/v1/changesets/${encodeURIComponent(changesetId)}/transitions`,
        { state: local.state, headSha: local.headSha ?? undefined },
        idempotencyKey,
      );
    },
  };

  async *#attach(
    runId: string,
    options: { afterSequence?: number; signal?: AbortSignal },
  ): AsyncGenerator<HostEvent | RunResult> {
    const token = await this.#token();
    const query =
      options.afterSequence === undefined ? "" : `?afterSequence=${options.afterSequence}`;
    const response = await this.#fetch(
      `${this.#baseUrl}/v1/runs/${encodeURIComponent(runId)}/events${query}`,
      {
        headers: token
          ? { authorization: `Bearer ${token}`, accept: "text/event-stream" }
          : { accept: "text/event-stream" },
        signal: options.signal,
      },
    );
    if (!response.ok || !response.body)
      throw new CloudApiError(response.status, "stream_failed", "could not attach to run stream");
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return;
      buffer += chunk.value;
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = frame
          .split("\n")
          .find((line) => line.startsWith("event:"))
          ?.slice(6)
          .trim();
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data) yield JSON.parse(data) as HostEvent | RunResult;
        if (event === "run_end") return;
        boundary = buffer.indexOf("\n\n");
      }
    }
  }
}

type LocalHostMethod =
  | "cloud.prepareBase"
  | "changesets.pull"
  | "changesets.resolve"
  | "changesets.abort";
export type LocalHostCall = <M extends LocalHostMethod>(
  method: M,
  params: HostMethodMap[M]["params"],
) => Promise<HostMethodMap[M]["result"]>;

export function createLocalHostTransports(call: LocalHostCall): {
  localCloudBase: LocalCloudBaseTransport;
  localChangesets: LocalChangesetTransport;
} {
  return {
    localCloudBase: {
      prepareBase: (input) => call("cloud.prepareBase", input),
    },
    localChangesets: {
      async pull(input) {
        const result = await call("changesets.pull", {
          changesetId: input.changeset.id,
          workspaceId: input.localWorkspaceId,
          remote: "origin",
          branch: input.chat.branch,
          expectedLocalSha: input.expectedLocalSha,
          expectedRemoteSha: input.changeset.headSha ?? undefined,
          idempotencyKey: input.idempotencyKey,
        });
        return {
          state: result.state,
          ...(result.state === "applied" ? { headSha: result.head } : {}),
          ...(result.state === "needs_attention" ? { errorCode: "local_head_advanced" } : {}),
        };
      },
      async resolve(input) {
        if (!input.changeset.expectedLocalSha || !input.changeset.headSha) {
          return {
            state: "needs_attention",
            errorCode: "expected_sha_missing",
          };
        }
        const result = await call("changesets.resolve", {
          changesetId: input.changeset.id,
          workspaceId: input.localWorkspaceId,
          remote: "origin",
          branch: input.chat.branch,
          expectedLocalSha: input.changeset.expectedLocalSha,
          expectedRemoteSha: input.changeset.headSha,
          remoteSha: input.changeset.headSha,
          idempotencyKey: input.idempotencyKey,
        });
        return { state: result.state, headSha: result.head };
      },
      async abort(input) {
        if (!input.changeset.expectedLocalSha) {
          return {
            state: "needs_attention",
            errorCode: "expected_sha_missing",
          };
        }
        const result = await call("changesets.abort", {
          changesetId: input.changeset.id,
          workspaceId: input.localWorkspaceId,
          expectedLocalSha: input.changeset.expectedLocalSha,
          idempotencyKey: input.idempotencyKey,
        });
        return { state: result.state, headSha: result.head };
      },
    },
  };
}
