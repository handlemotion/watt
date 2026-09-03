import type { CustomTool, WorkspaceInfo } from "./types.js";

export const WATT_WORKSPACE_INFO_TOOL = "watt_workspace_info";

export function validateCustomTools(tools: CustomTool[] | undefined): CustomTool[] {
  const values = tools ?? [];
  const names = new Set<string>();
  for (const tool of values) {
    if (tool.name === WATT_WORKSPACE_INFO_TOOL) {
      throw new TypeError(`custom tool cannot replace ${WATT_WORKSPACE_INFO_TOOL}`);
    }
    if (tool.name.length === 0) throw new TypeError("custom tool name cannot be empty");
    if (names.has(tool.name)) throw new TypeError(`duplicate custom tool: ${tool.name}`);
    names.add(tool.name);
  }
  return [...values];
}

export function wattWorkspaceInfoTool(workspace: WorkspaceInfo): CustomTool {
  return {
    name: WATT_WORKSPACE_INFO_TOOL,
    description:
      "Return the current watt workspace metadata (paths, branch, ids). Never includes secrets.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    execute: () => ({
      workspaceId: workspace.workspaceId,
      projectId: workspace.projectId,
      worktreePath: workspace.worktreePath,
      branch: workspace.branch,
      slug: workspace.slug,
    }),
  };
}

export function mergeCustomTools(
  workspace: WorkspaceInfo,
  extra: CustomTool[] | undefined,
): CustomTool[] {
  const extras = validateCustomTools(extra);
  return [wattWorkspaceInfoTool(workspace), ...extras];
}
