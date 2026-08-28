import {
  DEFAULT_SETTING_SOURCES,
  type ExecutionPolicy,
  type ExecutionPolicyInput,
  type SettingSource,
} from "./types.js";

export const DEFAULT_EXECUTION_POLICY: ExecutionPolicy = {
  autoReview: false,
  sandbox: { enabled: false },
  agentRetries: true,
  toolAllowlist: null,
  toolDenylist: [],
  settingSources: [...DEFAULT_SETTING_SOURCES],
};

function uniqueStrings(values: string[], field: string): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    if (value.length === 0)
      throw new TypeError(`${field} contains an empty value`);
    if (seen.has(value))
      throw new TypeError(`${field} contains duplicate value: ${value}`);
    seen.add(value);
  }
  return [...values];
}

function settingSources(values: SettingSource[]): SettingSource[] {
  return uniqueStrings(values, "settingSources") as SettingSource[];
}

export function normalizeExecutionPolicy(
  input: ExecutionPolicyInput = {},
  base: ExecutionPolicy = DEFAULT_EXECUTION_POLICY,
): ExecutionPolicy {
  return {
    autoReview: input.autoReview ?? base.autoReview,
    sandbox: {
      enabled: input.sandbox?.enabled ?? base.sandbox.enabled,
    },
    agentRetries: input.agentRetries ?? base.agentRetries,
    toolAllowlist:
      input.toolAllowlist === undefined
        ? base.toolAllowlist === null
          ? null
          : uniqueStrings(base.toolAllowlist, "toolAllowlist")
        : input.toolAllowlist === null
          ? null
          : uniqueStrings(input.toolAllowlist, "toolAllowlist"),
    toolDenylist: uniqueStrings(
      input.toolDenylist ?? base.toolDenylist,
      "toolDenylist",
    ),
    settingSources: settingSources(input.settingSources ?? base.settingSources),
  };
}
