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
  if (typeof type !== "string" || !SDK_TYPES.has(type as SdkStreamMessage["type"])) {
    return null;
  }
  return value as SdkStreamMessage;
}

function textFromAssistant(message: Extract<SdkStreamMessage, { type: "assistant" }>): string {
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
      return [{ type: "status", status: message.status, message: message.message }];
    case "task":
      return [{ type: "status", status: message.status ?? "task", message: message.text }];
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
