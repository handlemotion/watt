use std::{collections::HashSet, path::Path};

use serde::Serialize;
use tauri::State;

use crate::{
    desktop::{DesktopRuntime, DesktopStatus},
    protocol::{Project, Session, Workspace},
    terminal::TerminalRegistry,
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopSnapshot {
    host: HostSnapshot,
    projects: Vec<ProjectSnapshot>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostSnapshot {
    status: &'static str,
    message: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectSnapshot {
    id: String,
    name: String,
    repo_root: String,
    workspaces: Vec<WorkspaceSnapshot>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceSnapshot {
    #[serde(flatten)]
    workspace: Workspace,
    sessions: Vec<Session>,
}

#[tauri::command]
pub(crate) async fn desktop_snapshot(
    runtime: State<'_, std::sync::Arc<DesktopRuntime>>,
    terminals: State<'_, std::sync::Arc<TerminalRegistry>>,
) -> Result<DesktopSnapshot, String> {
    let status = runtime.status();
    let host = match status {
        DesktopStatus::Starting => HostSnapshot {
            status: "starting",
            message: "Starting local host…",
        },
        DesktopStatus::Ready => HostSnapshot {
            status: "ready",
            message: "Local host ready",
        },
        DesktopStatus::Error => HostSnapshot {
            status: "error",
            message: "Local host unavailable",
        },
    };
    let Some(client) = runtime.client() else {
        return Ok(DesktopSnapshot {
            host,
            projects: Vec::new(),
        });
    };

    let projects = client
        .list_projects()
        .await
        .map_err(|error| error.to_string())?;
    let mut snapshots = Vec::with_capacity(projects.len());
    let mut active_ids = HashSet::new();
    for project in projects {
        let workspaces = client
            .list_workspaces(&project.id, false)
            .await
            .map_err(|error| error.to_string())?;
        let mut workspace_snapshots = Vec::with_capacity(workspaces.len());
        for workspace in workspaces {
            active_ids.insert(workspace.id.clone());
            let sessions = client
                .list_sessions(&workspace.id)
                .await
                .map_err(|error| error.to_string())?;
            workspace_snapshots.push(WorkspaceSnapshot {
                workspace,
                sessions,
            });
        }
        snapshots.push(project_snapshot(project, workspace_snapshots));
    }
    terminals.retain_workspaces(&active_ids);
    Ok(DesktopSnapshot {
        host,
        projects: snapshots,
    })
}

fn project_snapshot(project: Project, workspaces: Vec<WorkspaceSnapshot>) -> ProjectSnapshot {
    let name = Path::new(&project.repo_root)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or(&project.repo_root)
        .to_owned();
    ProjectSnapshot {
        id: project.id,
        name,
        repo_root: project.repo_root,
        workspaces,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_names_use_repository_basename() {
        let snapshot = project_snapshot(
            Project {
                id: "project".into(),
                repo_root: "/Users/test/src/Watt".into(),
            },
            Vec::new(),
        );
        assert_eq!(snapshot.name, "Watt");
    }
}
