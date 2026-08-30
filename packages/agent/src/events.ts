import type { AgentEvent, SdkStreamMessage } from "./types.js";

const SDK_TYPES = new Set<SdkStreamMessage["type"]>([
  "assistant",
  "tool_call",
  "status",
  "system",
  "user",
  "thinking",
  "task",
  "request",
  "usage",
]);

export function parseSdkStreamMessage(value: unknown): SdkStreamMessage | null {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return null;
  }
  const type = (value as { type: unknown }).type;
  if (
    typeof type !== "string" ||
    !SDK_TYPES.has(type as SdkStreamMessage["type"])
  ) {
    return null;
  }
  const record = value as Record<string, unknown>;
  switch (type) {
    case "assistant":
      return isRecord(record.message) && Array.isArray(record.message.content)
        ? (value as SdkStreamMessage)
        : null;
    case "tool_call":
      return typeof record.call_id === "string" &&
        typeof record.name === "string" &&
        (record.status === "running" ||
          record.status === "completed" ||
          record.status === "error")
        ? (value as SdkStreamMessage)
        : null;
    case "status":
      return typeof record.status === "string" &&
        (record.message === undefined || typeof record.message === "string")
        ? (value as SdkStreamMessage)
        : null;
    case "task":
      return (record.status === undefined ||
        typeof record.status === "string") &&
        (record.text === undefined || typeof record.text === "string")
        ? (value as SdkStreamMessage)
        : null;
    case "thinking":
      return typeof record.text === "string"
        ? (value as SdkStreamMessage)
        : null;
    case "request":
      return typeof record.request_id === "string"
        ? (value as SdkStreamMessage)
        : null;
    case "system":
    case "user":
    case "usage":
      return value as SdkStreamMessage;
    default:
      return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textFromAssistant(
  message: Extract<SdkStreamMessage, { type: "assistant" }>,
): string {
  const content = message.message?.content;
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter((block): block is { type: "text"; text: string } => {
      return (
        typeof block === "object" &&
        block !== null &&
        "type" in block &&
        block.type === "text" &&
        "text" in block &&
        typeof block.text === "string"
      );
    })
    .map((block) => block.text)
    .join("");
}

export function mapSdkMessage(message: SdkStreamMessage): AgentEvent[] {
  switch (message.type) {
    case "assistant": {
      const text = textFromAssistant(message);
      return text.length > 0 ? [{ type: "text_delta", text }] : [];
    }
    case "tool_call": {
      if (message.status === "running") {
        return [
          {
            type: "tool_call",
            callId: message.call_id,
            name: message.name,
            args: message.args ?? null,
          },
        ];
      }
      return [
        {
          type: "tool_result",
          callId: message.call_id,
          name: message.name,
          result: message.result ?? null,
          ok: message.status === "completed",
        },
      ];
    }
    case "status":
      return [
        { type: "status", status: message.status, message: message.message },
      ];
    case "task":
      return [
        {
          type: "status",
          status: message.status ?? "task",
          message: message.text,
        },
      ];
    case "system":
    case "user":
    case "thinking":
    case "request":
    case "usage":
      return [];
    default: {
      const exhaustive: never = message;
      return exhaustive;
    }
  }
}

export function mapUnknownSdkMessage(value: unknown): AgentEvent[] {
  const message = parseSdkStreamMessage(value);
  return message ? mapSdkMessage(message) : [];
}

export function asAgentEvent(value: unknown): AgentEvent | null {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  switch (record.type) {
    case "text_delta":
      return typeof record.text === "string"
        ? { type: "text_delta", text: record.text }
        : null;
    case "tool_call":
      return typeof record.callId === "string" &&
        typeof record.name === "string"
        ? {
            type: "tool_call",
            callId: record.callId,
            name: record.name,
            args: record.args,
          }
        : null;
    case "tool_result":
      return typeof record.callId === "string" &&
        typeof record.name === "string" &&
        typeof record.ok === "boolean"
        ? {
            type: "tool_result",
            callId: record.callId,
            name: record.name,
            result: record.result,
            ok: record.ok,
          }
        : null;
    case "status":
      return typeof record.status === "string" &&
        (record.message === undefined || typeof record.message === "string")
        ? {
            type: "status",
            status: record.status,
            ...(typeof record.message === "string"
              ? { message: record.message }
              : {}),
          }
        : null;
    case "error":
      return typeof record.message === "string"
        ? { type: "error", message: record.message }
        : null;
    default:
      return null;
  }
}

export function assertAgentEvent(event: AgentEvent): AgentEvent {
  switch (event.type) {
    case "text_delta":
    case "tool_call":
    case "tool_result":
    case "status":
    case "error":
      return event;
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}
