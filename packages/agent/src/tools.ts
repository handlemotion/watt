import type { CustomTool, WorkspaceInfo } from "./types.js";

export const WATT_WORKSPACE_INFO_TOOL = "watt_workspace_info";

export function wattWorkspaceInfoTool(workspace: WorkspaceInfo): CustomTool {
  return {
    name: WATT_WORKSPACE_INFO_TOOL,
    description: "Return the current watt workspace metadata (paths, branch, ids). Never includes secrets.",
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

export function mergeCustomTools(workspace: WorkspaceInfo, extra: CustomTool[] | undefined): CustomTool[] {
  const extras = extra ?? [];
  return [wattWorkspaceInfoTool(workspace), ...extras.filter((tool) => tool.name !== WATT_WORKSPACE_INFO_TOOL)];
}
