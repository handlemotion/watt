import type { AgentEvent } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textFrom(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (!isRecord(value)) return undefined;
  if (typeof value.text === "string" && value.text.length > 0)
    return value.text;
  if (typeof value.message === "string" && value.message.length > 0) {
    return value.message;
  }
  if (typeof value.delta === "string" && value.delta.length > 0) {
    return value.delta;
  }
  return undefined;
}

function itemRecord(value: Record<string, unknown>): Record<string, unknown> {
  return isRecord(value.item) ? value.item : value;
}

function itemId(item: Record<string, unknown>, fallback: string): string {
  if (typeof item.id === "string" && item.id.length > 0) return item.id;
  if (typeof item.callId === "string" && item.callId.length > 0) {
    return item.callId;
  }
  if (typeof item.itemId === "string" && item.itemId.length > 0) {
    return item.itemId;
  }
  return fallback;
}

function toolName(item: Record<string, unknown>): string {
  if (typeof item.name === "string" && item.name.length > 0) return item.name;
  if (typeof item.tool === "string" && item.tool.length > 0) return item.tool;
  if (typeof item.type === "string" && item.type.length > 0) return item.type;
  return "codex_tool";
}

function isToolItem(type: string): boolean {
  return (
    type === "command_execution" ||
    type === "mcp_tool_call" ||
    type === "tool_call" ||
    type === "function_call"
  );
}

export function mapCodexStreamEvent(value: unknown): AgentEvent[] {
  if (!isRecord(value) || typeof value.type !== "string") return [];
  const type = value.type;
  if (type === "error" || type === "turn.failed") {
    const message =
      textFrom(value.message) ??
      textFrom(value.error) ??
      (value.error instanceof Error ? value.error.message : undefined) ??
      "codex error";
    return [{ type: "error", message }];
  }
  if (
    type === "item.agentMessage.delta" ||
    type === "item/agentMessage/delta" ||
    type === "agent_message.delta"
  ) {
    const text = textFrom(value) ?? textFrom(value.delta);
    return text === undefined ? [] : [{ type: "text_delta", text }];
  }
  if (type === "turn.started" || type === "turn/started") {
    return [{ type: "status", status: "turn_started" }];
  }
  if (type === "turn.completed" || type === "turn/completed") {
    return [{ type: "status", status: "turn_completed" }];
  }
  if (
    type === "item.started" ||
    type === "item/started" ||
    type === "item.updated" ||
    type === "item/updated" ||
    type === "item.completed" ||
    type === "item/completed"
  ) {
    const item = itemRecord(value);
    const itemType = typeof item.type === "string" ? item.type : "";
    if (itemType === "agent_message" || itemType === "message") {
      const text = textFrom(item);
      if (type === "item.updated" || type === "item/updated") return [];
      if (type.endsWith("started") || text === undefined) return [];
      return [{ type: "text_delta", text }];
    }
    if (isToolItem(itemType)) {
      const callId = itemId(item, itemType);
      const name =
        itemType === "mcp_tool_call" && typeof item.tool === "string"
          ? item.tool
          : toolName(item);
      if (type.endsWith("started") || type.endsWith("updated")) {
        if (type.endsWith("updated")) return [];
        return [
          {
            type: "tool_call",
            callId,
            name,
            args: item.command ?? item.arguments ?? item.args ?? null,
          },
        ];
      }
      return [
        {
          type: "tool_result",
          callId,
          name,
          result: item.aggregated_output ?? item.output ?? item.result ?? null,
          ok: item.status !== "failed" && item.status !== "error",
        },
      ];
    }
    if (type.endsWith("started")) {
      return itemType.length > 0 ? [{ type: "status", status: itemType }] : [];
    }
    return [];
  }
  return [];
}
