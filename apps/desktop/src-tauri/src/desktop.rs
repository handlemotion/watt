use std::{
    future::Future,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_shell::{
    ShellExt,
    process::{CommandChild, CommandEvent},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::{Mutex, RwLock},
    time::{sleep, timeout},
};

use crate::{SidecarHostClient, protocol::HostOptions};

const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum DesktopState {
    Starting,
    Ready,
    Error,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopStatus {
    state: DesktopState,
    message: String,
}

impl DesktopStatus {
    fn starting() -> Self {
        Self {
            state: DesktopState::Starting,
            message: "Starting local host…".into(),
        }
    }

    fn ready() -> Self {
        Self {
            state: DesktopState::Ready,
            message: "Local host ready".into(),
        }
    }

    fn error() -> Self {
        Self {
            state: DesktopState::Error,
            message: "Local host unavailable".into(),
        }
    }
}

struct DesktopRuntime {
    status: RwLock<DesktopStatus>,
    client: Mutex<Option<SidecarHostClient>>,
    child: Mutex<Option<CommandChild>>,
    stopping: AtomicBool,
}

impl DesktopRuntime {
    fn new() -> Self {
        Self {
            status: RwLock::new(DesktopStatus::starting()),
            client: Mutex::new(None),
            child: Mutex::new(None),
            stopping: AtomicBool::new(false),
        }
    }
}

fn desktop_paths(app_data_dir: &Path) -> (PathBuf, PathBuf) {
    (app_data_dir.join("state"), app_data_dir.join("worktrees"))
}

async fn set_startup_error(runtime: &DesktopRuntime) {
    *runtime.status.write().await = DesktopStatus::error();
}

async fn completes_within<F>(duration: Duration, future: F) -> bool
where
    F: Future<Output = ()>,
{
    timeout(duration, future).await.is_ok()
}

async fn start_sidecar(app: AppHandle, runtime: Arc<DesktopRuntime>) -> Result<(), String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let (state_dir, worktree_root) = desktop_paths(&app_data_dir);
    std::fs::create_dir_all(&state_dir).map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&worktree_root).map_err(|error| error.to_string())?;

    let command = app
        .shell()
        .sidecar("watt-desktop-sidecar")
        .map_err(|error| error.to_string())?
        .set_raw_out(true);
    let (mut events, child) = command.spawn().map_err(|error| error.to_string())?;
    *runtime.child.lock().await = Some(child);

    let (mut stdout_writer, stdout_reader) = tokio::io::duplex(64 * 1024);
    let (stdin_writer, mut stdin_reader) = tokio::io::duplex(64 * 1024);

    let output_runtime = runtime.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    if stdout_writer.write_all(&bytes).await.is_err() {
                        break;
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    eprint!("{}", String::from_utf8_lossy(&bytes));
                }
                CommandEvent::Error(message) => {
                    eprintln!("watt desktop sidecar: {message}");
                    break;
                }
                CommandEvent::Terminated(_) => break,
                _ => {}
            }
        }
        output_runtime.child.lock().await.take();
        if !output_runtime.stopping.load(Ordering::Acquire) {
            set_startup_error(&output_runtime).await;
        }
    });

    let input_runtime = runtime.clone();
    tauri::async_runtime::spawn(async move {
        let mut buffer = [0_u8; 16 * 1024];
        loop {
            let count = match stdin_reader.read(&mut buffer).await {
                Ok(0) | Err(_) => break,
                Ok(count) => count,
            };
            let mut child = input_runtime.child.lock().await;
            let Some(child) = child.as_mut() else {
                break;
            };
            if child.write(&buffer[..count]).is_err() {
                break;
            }
        }
    });

    let client = SidecarHostClient::connect(
        stdout_reader,
        stdin_writer,
        HostOptions {
            state_dir: state_dir.to_string_lossy().into_owned(),
            worktree_root: worktree_root.to_string_lossy().into_owned(),
            lease_timeout_ms: None,
        },
    )
    .await
    .map_err(|error| error.to_string())?;

    *runtime.client.lock().await = Some(client);
    *runtime.status.write().await = DesktopStatus::ready();
    Ok(())
}

async fn stop_sidecar(runtime: &DesktopRuntime) {
    if runtime.stopping.swap(true, Ordering::AcqRel) {
        return;
    }

    if let Some(client) = runtime.client.lock().await.take() {
        let _ = timeout(SHUTDOWN_TIMEOUT, client.close()).await;
    }

    let child_stopped = completes_within(SHUTDOWN_TIMEOUT, async {
        while runtime.child.lock().await.is_some() {
            sleep(Duration::from_millis(25)).await;
        }
    })
    .await;

    if !child_stopped && let Some(child) = runtime.child.lock().await.take() {
        let _ = child.kill();
    }
}

#[tauri::command]
async fn desktop_status(runtime: State<'_, Arc<DesktopRuntime>>) -> Result<DesktopStatus, ()> {
    Ok(runtime.status.read().await.clone())
}

pub fn run() {
    let runtime = Arc::new(DesktopRuntime::new());
    let managed_runtime = runtime.clone();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(managed_runtime)
        .invoke_handler(tauri::generate_handler![desktop_status])
        .setup(move |app| {
            let app_handle = app.handle().clone();
            let startup_runtime = runtime.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = start_sidecar(app_handle, startup_runtime.clone()).await {
                    eprintln!("watt desktop startup: {error}");
                    if let Some(child) = startup_runtime.child.lock().await.take() {
                        let _ = child.kill();
                    }
                    set_startup_error(&startup_runtime).await;
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Watt desktop application");

    app.run(move |app_handle, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            let runtime = app_handle.state::<Arc<DesktopRuntime>>().inner().clone();
            if !runtime.stopping.load(Ordering::Acquire) {
                api.prevent_exit();
                let app_handle = app_handle.clone();
                tauri::async_runtime::spawn(async move {
                    stop_sidecar(&runtime).await;
                    app_handle.exit(0);
                });
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_data_paths_are_stable_and_contained() {
        let root = Path::new("/tmp/watt-app-data");
        let (state, worktrees) = desktop_paths(root);
        assert_eq!(state, root.join("state"));
        assert_eq!(worktrees, root.join("worktrees"));
    }

    #[tokio::test]
    async fn startup_error_is_safe_and_stable() {
        let runtime = DesktopRuntime::new();
        set_startup_error(&runtime).await;
        assert_eq!(*runtime.status.read().await, DesktopStatus::error());
        assert_eq!(
            runtime.status.read().await.message,
            "Local host unavailable"
        );
    }

    #[tokio::test]
    async fn shutdown_without_a_started_child_is_idempotent() {
        let runtime = DesktopRuntime::new();
        stop_sidecar(&runtime).await;
        stop_sidecar(&runtime).await;
        assert!(runtime.stopping.load(Ordering::Acquire));
    }

    #[tokio::test]
    async fn graceful_shutdown_completes_inside_the_window() {
        assert!(
            completes_within(Duration::from_millis(50), async {
                tokio::task::yield_now().await;
            })
            .await
        );
    }

    #[tokio::test]
    async fn stuck_shutdown_reaches_the_timeout_fallback() {
        assert!(!completes_within(Duration::from_millis(10), std::future::pending()).await);
    }
}
