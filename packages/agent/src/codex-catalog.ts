import type { ModelCapability } from "./types.js";

export const CODEX_MODEL_PREFIX = "codex:";

const EFFORT = {
  id: "effort",
  displayName: "Reasoning effort",
  values: [
    { value: "low", displayName: "Low" },
    { value: "medium", displayName: "Medium" },
    { value: "high", displayName: "High" },
    { value: "xhigh", displayName: "Extra high" },
  ],
};

function model(
  upstream: string,
  displayName: string,
  options?: { isDefault?: boolean; aliases?: string[] },
): ModelCapability {
  return {
    id: `${CODEX_MODEL_PREFIX}${upstream}`,
    displayName,
    aliases: options?.aliases ?? [],
    parameters: [EFFORT],
    variants: [
      {
        params: [{ id: "effort", value: "medium" }],
        displayName: `${displayName} (medium)`,
        isDefault: options?.isDefault === true,
      },
    ],
  };
}

export const DEFAULT_CODEX_CATALOG: ModelCapability[] = [
  model("gpt-5.5", "GPT-5.5", { isDefault: true }),
  model("gpt-5.4", "GPT-5.4"),
  model("gpt-5.3-codex", "GPT-5.3 Codex"),
  model("gpt-5.2", "GPT-5.2"),
];

export function upstreamCodexModelId(id: string): string {
  return id.startsWith(CODEX_MODEL_PREFIX) ? id.slice(CODEX_MODEL_PREFIX.length) : id;
}
