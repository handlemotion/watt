import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";

import { assertPayloadSize } from "./codec.js";
import {
  ProtocolError,
  type ClientEnvelope,
  type HelloEnvelope,
  type HostMethod,
  type RequestEnvelope,
  type ServerEnvelope,
} from "./types.js";

type JsonObject = Record<string, unknown>;

declare const __dirname: string;
declare const __WATT_PKG__: boolean;
const schemaPath =
  typeof __WATT_PKG__ !== "undefined" && __WATT_PKG__
    ? path.join(__dirname, "protocol.schema.json")
    : fileURLToPath(new URL("../protocol.schema.json", import.meta.url));
const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as JsonObject;
const schemaId = schema.$id;
if (typeof schemaId !== "string") throw new Error("protocol schema has no $id");
const requestDefinition = (schema.$defs as JsonObject | undefined)
  ?.RequestEnvelope as JsonObject | undefined;
const requestProperties = requestDefinition?.properties as
  JsonObject | undefined;
const methodDefinition = requestProperties?.method as JsonObject | undefined;
const methodEnum = methodDefinition?.enum;
if (
  !Array.isArray(methodEnum) ||
  !methodEnum.every((value) => typeof value === "string")
) {
  throw new Error("protocol schema has no request method enum");
}
const hostMethods = new Set<string>(methodEnum);
const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addSchema(schema);
const clientValidator = ajv.compile({
  $ref: `${schemaId}#/$defs/ClientEnvelope`,
}) as ValidateFunction<ClientEnvelope>;
const serverValidator = ajv.compile({
  $ref: `${schemaId}#/$defs/ServerEnvelope`,
}) as ValidateFunction<ServerEnvelope>;

function validationMessage(validator: ValidateFunction): string {
  return ajv.errorsText(validator.errors, { separator: "; " });
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertObject(value: unknown): asserts value is JsonObject {
  if (!isObject(value))
    throw new ProtocolError("params must be an object", "invalid_params");
}

function assertKeys(
  value: JsonObject,
  required: string[],
  optional: string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!(key in value))
      throw new ProtocolError(`missing param: ${key}`, "invalid_params");
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key))
      throw new ProtocolError(`unknown param: ${key}`, "invalid_params");
  }
}

function assertString(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ProtocolError(
      `${name} must be a non-empty string`,
      "invalid_params",
    );
  }
}

function assertOptionalString(value: unknown, name: string): void {
  if (value !== undefined) assertString(value, name);
}

function assertOptionalBoolean(value: unknown, name: string): void {
  if (value !== undefined && typeof value !== "boolean") {
    throw new ProtocolError(`${name} must be a boolean`, "invalid_params");
  }
}

function assertId(value: unknown, name: string): asserts value is string {
  assertString(value, name);
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(value)) {
    throw new ProtocolError(`${name} must be a ULID`, "invalid_params");
  }
}

function assertEmpty(value: JsonObject): void {
  assertKeys(value, []);
}

export function assertMethodParams(method: HostMethod, params: unknown): void {
  assertObject(params);
  switch (method) {
    case "projects.register":
      assertKeys(params, ["repoRoot"]);
      assertString(params.repoRoot, "repoRoot");
      return;
    case "projects.get":
    case "workspaces.get":
    case "sessions.get":
    case "runs.get":
      assertKeys(params, ["id"]);
      assertId(params.id, "id");
      return;
    case "projects.list":
    case "host.capabilities":
    case "host.close":
      assertEmpty(params);
      return;
    case "projects.reconcile":
      assertKeys(params, ["projectId"]);
      assertId(params.projectId, "projectId");
      return;
    case "workspaces.create":
      assertKeys(
        params,
        ["projectId", "slug"],
        ["branch", "baseRef", "copyGlobs"],
      );
      assertId(params.projectId, "projectId");
      assertString(params.slug, "slug");
      assertOptionalString(params.branch, "branch");
      assertOptionalString(params.baseRef, "baseRef");
      if (
        params.copyGlobs !== undefined &&
        (!Array.isArray(params.copyGlobs) ||
          !params.copyGlobs.every((entry) => typeof entry === "string"))
      ) {
        throw new ProtocolError(
          "copyGlobs must be a string array",
          "invalid_params",
        );
      }
      return;
    case "workspaces.list":
      assertKeys(params, ["projectId"], ["includeArchived"]);
      assertId(params.projectId, "projectId");
      assertOptionalBoolean(params.includeArchived, "includeArchived");
      return;
    case "workspaces.archive":
      assertKeys(params, ["workspaceId"], ["keepBranch"]);
      assertId(params.workspaceId, "workspaceId");
      assertOptionalBoolean(params.keepBranch, "keepBranch");
      return;
    case "sessions.create":
      assertKeys(
        params,
        ["workspaceId", "prompt"],
        ["runtime", "model", "mode", "executionPolicy"],
      );
      assertId(params.workspaceId, "workspaceId");
      assertString(params.prompt, "prompt");
      if (
        params.runtime !== undefined &&
        params.runtime !== "cursor-local" &&
        params.runtime !== "codex-local"
      ) {
        throw new ProtocolError(
          "runtime must be cursor-local or codex-local",
          "invalid_params",
        );
      }
      if (params.model !== undefined && !isObject(params.model)) {
        throw new ProtocolError("model must be an object", "invalid_params");
      }
      if (
        params.mode !== undefined &&
        params.mode !== "agent" &&
        params.mode !== "plan"
      ) {
        throw new ProtocolError("mode must be agent or plan", "invalid_params");
      }
      if (
        params.executionPolicy !== undefined &&
        !isObject(params.executionPolicy)
      ) {
        throw new ProtocolError(
          "executionPolicy must be an object",
          "invalid_params",
        );
      }
      return;
    case "sessions.list":
      assertKeys(params, ["workspaceId"]);
      assertId(params.workspaceId, "workspaceId");
      return;
    case "sessions.send":
      assertKeys(params, ["sessionId", "prompt"]);
      assertId(params.sessionId, "sessionId");
      assertString(params.prompt, "prompt");
      return;
    case "runs.list":
      assertKeys(params, ["sessionId"]);
      assertId(params.sessionId, "sessionId");
      return;
    case "runs.wait":
    case "runs.cancel":
      assertKeys(params, ["runId"]);
      assertId(params.runId, "runId");
      return;
    case "runs.attach":
      assertKeys(params, ["runId", "subscriptionId"], ["afterSequence"]);
      assertId(params.runId, "runId");
      assertId(params.subscriptionId, "subscriptionId");
      if (
        params.afterSequence !== undefined &&
        (typeof params.afterSequence !== "number" ||
          !Number.isSafeInteger(params.afterSequence) ||
          params.afterSequence < 0)
      ) {
        throw new ProtocolError(
          "afterSequence must be a non-negative safe integer",
          "invalid_params",
        );
      }
      return;
    case "runs.unsubscribe":
      assertKeys(params, ["subscriptionId"]);
      assertId(params.subscriptionId, "subscriptionId");
      return;
    case "diagnostics.operations.get":
      assertKeys(params, ["operationId"]);
      assertId(params.operationId, "operationId");
      return;
    case "diagnostics.operations.list":
      assertKeys(params, [], ["projectId", "workspaceId", "includeCompleted"]);
      if (params.projectId !== undefined)
        assertId(params.projectId, "projectId");
      if (params.workspaceId !== undefined)
        assertId(params.workspaceId, "workspaceId");
      assertOptionalBoolean(params.includeCompleted, "includeCompleted");
      return;
    default: {
      const exhaustive: never = method;
      throw new ProtocolError(
        `unsupported method: ${String(exhaustive)}`,
        "method_not_found",
      );
    }
  }
}

export function assertClientEnvelope(
  value: unknown,
): asserts value is ClientEnvelope {
  if (
    isObject(value) &&
    value.type === "request" &&
    typeof value.method === "string" &&
    !hostMethods.has(value.method)
  ) {
    throw new ProtocolError(
      `unsupported method: ${value.method}`,
      "method_not_found",
    );
  }
  if (!clientValidator(value)) {
    throw new ProtocolError(
      `invalid client envelope: ${validationMessage(clientValidator)}`,
      "invalid_envelope",
      { fatal: true },
    );
  }
  if (value.type === "request") {
    assertPayloadSize(value.params);
    assertMethodParams(value.method, value.params);
  }
}

export function assertHello(value: unknown): asserts value is HelloEnvelope {
  assertClientEnvelope(value);
  if (value.type !== "hello") {
    throw new ProtocolError("first frame must be hello", "handshake_required", {
      fatal: true,
    });
  }
}

export function assertRequest(
  value: unknown,
): asserts value is RequestEnvelope {
  assertClientEnvelope(value);
  if (value.type !== "request") {
    throw new ProtocolError(
      "hello is only valid as the first frame",
      "unexpected_hello",
      {
        fatal: true,
      },
    );
  }
}

export function assertServerEnvelope(
  value: unknown,
): asserts value is ServerEnvelope {
  if (!serverValidator(value)) {
    throw new ProtocolError(
      `invalid server envelope: ${validationMessage(serverValidator)}`,
      "invalid_server_envelope",
      { fatal: true },
    );
  }
  if (value.type === "result") assertPayloadSize(value.result);
  if (value.type === "run_event") assertPayloadSize(value.event);
}

export function protocolSchema(): JsonObject {
  return schema;
}
