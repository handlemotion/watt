use std::{
    env,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex, RwLock},
    thread::{self, JoinHandle},
    time::Duration,
};

use directories::BaseDirs;
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
    sync::oneshot,
    time::timeout,
};

use crate::{SidecarHostClient, protocol::HostOptions};

const APP_IDENTIFIER: &str = "com.handlemotion.watt";
const SIDECAR_NAME: &str = "watt-desktop-sidecar";
const STARTUP_TIMEOUT: Duration = Duration::from_secs(15);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum DesktopStatus {
    Starting,
    Ready,
    Error,
}

impl DesktopStatus {
    #[cfg_attr(not(test), expect(dead_code))]
    fn message(&self) -> &'static str {
        match self {
            Self::Starting => "Starting local host…",
            Self::Ready => "Local host ready",
            Self::Error => "Local host unavailable",
        }
    }
}

pub(crate) struct DesktopRuntime {
    status: Arc<RwLock<DesktopStatus>>,
    client: Arc<RwLock<Option<SidecarHostClient>>>,
    stop: Mutex<Option<oneshot::Sender<()>>>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl DesktopRuntime {
    fn start(sidecar: PathBuf, app_data_dir: PathBuf) -> Arc<Self> {
        let status = Arc::new(RwLock::new(DesktopStatus::Starting));
        let client = Arc::new(RwLock::new(None));
        let (stop, stop_rx) = oneshot::channel();
        let worker_status = status.clone();
        let worker_client = client.clone();
        let worker = thread::Builder::new()
            .name("watt-host".into())
            .spawn(move || {
                let runtime = tokio::runtime::Builder::new_multi_thread()
                    .enable_all()
                    .build()
                    .expect("failed to create Watt Host runtime");
                if let Err(error) = runtime.block_on(run_sidecar(
                    sidecar,
                    app_data_dir,
                    worker_status.clone(),
                    worker_client,
                    stop_rx,
                )) {
                    eprintln!("watt desktop startup: {error}");
                    set_status(&worker_status, DesktopStatus::Error);
                }
            })
            .expect("failed to start Watt Host thread");

        Arc::new(Self {
            status,
            client,
            stop: Mutex::new(Some(stop)),
            worker: Mutex::new(Some(worker)),
        })
    }

    pub(crate) fn stop(&self) {
        if let Some(stop) = self.stop.lock().expect("stop lock poisoned").take() {
            let _ = stop.send(());
        }
        if let Some(worker) = self.worker.lock().expect("worker lock poisoned").take() {
            let _ = worker.join();
        }
    }

    pub(crate) fn client(&self) -> Option<SidecarHostClient> {
        self.client
            .read()
            .expect("desktop client lock poisoned")
            .clone()
    }

    pub(crate) fn status(&self) -> DesktopStatus {
        self.status
            .read()
            .expect("desktop status lock poisoned")
            .clone()
    }
}

impl Drop for DesktopRuntime {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.get_mut().expect("stop lock poisoned").take() {
            let _ = stop.send(());
        }
        if let Some(worker) = self.worker.get_mut().expect("worker lock poisoned").take() {
            let _ = worker.join();
        }
    }
}

fn set_status(status: &RwLock<DesktopStatus>, next: DesktopStatus) {
    *status.write().expect("desktop status lock poisoned") = next;
}

fn app_data_dir() -> Result<PathBuf, String> {
    if let Some(path) = env::var_os("WATT_APP_DATA_DIR") {
        return Ok(PathBuf::from(path));
    }
    BaseDirs::new()
        .map(|dirs| dirs.data_dir().join(APP_IDENTIFIER))
        .ok_or_else(|| "macOS application data directory is unavailable".into())
}

fn desktop_paths(app_data_dir: &Path) -> (PathBuf, PathBuf) {
    (app_data_dir.join("state"), app_data_dir.join("worktrees"))
}

fn sidecar_executable() -> Result<PathBuf, String> {
    if let Some(path) = env::var_os("WATT_SIDECAR_EXECUTABLE") {
        return Ok(PathBuf::from(path));
    }
    let executable = env::current_exe().map_err(|error| error.to_string())?;
    let adjacent = executable
        .parent()
        .ok_or_else(|| "desktop executable has no parent directory".to_string())?
        .join(SIDECAR_NAME);
    if adjacent.is_file() {
        return Ok(adjacent);
    }
    let development = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join("watt-desktop-sidecar-aarch64-apple-darwin");
    if development.is_file() {
        return Ok(development);
    }
    Err("packaged Host executable is unavailable".into())
}

async fn run_sidecar(
    executable: PathBuf,
    app_data_dir: PathBuf,
    status: Arc<RwLock<DesktopStatus>>,
    client_slot: Arc<RwLock<Option<SidecarHostClient>>>,
    mut stop: oneshot::Receiver<()>,
) -> Result<(), String> {
    let (state_dir, worktree_root) = desktop_paths(&app_data_dir);
    std::fs::create_dir_all(&state_dir).map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&worktree_root).map_err(|error| error.to_string())?;

    let mut child = Command::new(executable)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| error.to_string())?;
    let stdin = child.stdin.take().ok_or("sidecar stdin is unavailable")?;
    let stdout = child.stdout.take().ok_or("sidecar stdout is unavailable")?;
    let stderr = child.stderr.take().ok_or("sidecar stderr is unavailable")?;
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            eprintln!("watt desktop sidecar: {line}");
        }
    });

    let connect = SidecarHostClient::connect(
        stdout,
        stdin,
        HostOptions {
            state_dir: state_dir.to_string_lossy().into_owned(),
            worktree_root: worktree_root.to_string_lossy().into_owned(),
            lease_timeout_ms: None,
        },
    );
    let client = tokio::select! {
        _ = &mut stop => {
            terminate_child(&mut child).await;
            return Ok(());
        }
        result = timeout(STARTUP_TIMEOUT, connect) => match result {
            Ok(Ok(client)) => client,
            Ok(Err(error)) => {
                terminate_child(&mut child).await;
                return Err(error.to_string());
            }
            Err(_) => {
                terminate_child(&mut child).await;
                return Err("timed out waiting for the packaged Host handshake".into());
            }
        }
    };
    *client_slot.write().expect("desktop client lock poisoned") = Some(client.clone());
    set_status(&status, DesktopStatus::Ready);

    let result = tokio::select! {
        _ = &mut stop => {
            let _ = timeout(SHUTDOWN_TIMEOUT, client.close()).await;
            wait_or_terminate(&mut child).await;
            Ok(())
        }
        result = child.wait() => {
            let code = result.map_err(|error| error.to_string())?;
            Err(format!("sidecar exited unexpectedly ({code})"))
        }
    };
    client_slot
        .write()
        .expect("desktop client lock poisoned")
        .take();
    result
}

async fn wait_or_terminate(child: &mut Child) {
    if timeout(SHUTDOWN_TIMEOUT, child.wait()).await.is_err() {
        terminate_child(child).await;
    }
}

async fn terminate_child(child: &mut Child) {
    let _ = child.kill().await;
    let _ = child.wait().await;
}

pub fn run() {
    let arguments = env::args_os().collect::<Vec<_>>();
    if arguments.iter().any(|argument| argument == "--host-smoke") {
        run_host_smoke().expect("packaged Host lifecycle smoke test failed");
        println!("desktop Host handshake and graceful shutdown passed.");
        return;
    }
    let window_smoke = arguments
        .iter()
        .any(|argument| argument == "--window-smoke");

    let initial_status = Arc::new(RwLock::new(DesktopStatus::Starting));
    let runtime = match (sidecar_executable(), app_data_dir()) {
        (Ok(sidecar), Ok(data_dir)) => DesktopRuntime::start(sidecar, data_dir),
        (sidecar, data_dir) => {
            if let Err(error) = sidecar {
                eprintln!("watt desktop startup: {error}");
            }
            if let Err(error) = data_dir {
                eprintln!("watt desktop startup: {error}");
            }
            set_status(&initial_status, DesktopStatus::Error);
            Arc::new(DesktopRuntime {
                status: initial_status,
                client: Arc::new(RwLock::new(None)),
                stop: Mutex::new(None),
                worker: Mutex::new(None),
            })
        }
    };
    let quit_runtime = runtime.clone();
    let terminals = Arc::new(crate::terminal::TerminalRegistry::new());
    let quit_terminals = terminals.clone();

    tauri::Builder::default()
        .manage(runtime.clone())
        .manage(terminals)
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![
            crate::desktop_api::desktop_snapshot,
            crate::terminal::terminal_open,
            crate::terminal::terminal_write,
            crate::terminal::terminal_resize,
            crate::terminal::terminal_restart,
            crate::terminal::terminal_kill,
        ])
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            crate::macos::install_traffic_lights(app);
            if window_smoke {
                let handle = app.handle().clone();
                thread::spawn(move || {
                    thread::sleep(Duration::from_millis(500));
                    handle.exit(0);
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Watt")
        .run(move |_app, event| {
            if let tauri::RunEvent::Exit = event {
                quit_terminals.shutdown_all();
                quit_runtime.stop();
                if window_smoke {
                    println!("desktop window startup and graceful shutdown passed.");
                }
            }
        });

    runtime.stop();
}

fn run_host_smoke() -> Result<(), String> {
    let runtime = DesktopRuntime::start(sidecar_executable()?, app_data_dir()?);
    let deadline = std::time::Instant::now() + STARTUP_TIMEOUT;
    loop {
        match runtime
            .status
            .read()
            .expect("desktop status lock poisoned")
            .clone()
        {
            DesktopStatus::Ready => break,
            DesktopStatus::Error => {
                runtime.stop();
                return Err("local Host failed to start".into());
            }
            DesktopStatus::Starting if std::time::Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(25));
            }
            DesktopStatus::Starting => {
                runtime.stop();
                return Err("timed out waiting for local Host readiness".into());
            }
        }
    }
    let client = runtime
        .client()
        .ok_or_else(|| "local Host client is unavailable after readiness".to_string())?;
    let probe = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| error.to_string())?
        .block_on(client.list_projects())
        .map_err(|error| error.to_string());
    if let Err(error) = probe {
        runtime.stop();
        return Err(error);
    }
    runtime.stop();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ulid::Ulid;

    #[test]
    fn app_data_paths_are_stable_and_contained() {
        let root = Path::new("/tmp/watt-app-data");
        let (state, worktrees) = desktop_paths(root);
        assert_eq!(state, root.join("state"));
        assert_eq!(worktrees, root.join("worktrees"));
    }

    #[test]
    fn readiness_messages_are_safe_and_stable() {
        assert_eq!(DesktopStatus::Starting.message(), "Starting local host…");
        assert_eq!(DesktopStatus::Ready.message(), "Local host ready");
        assert_eq!(DesktopStatus::Error.message(), "Local host unavailable");
    }

    #[tokio::test]
    async fn shutdown_interrupts_a_stalled_startup_handshake() {
        let app_data_dir = env::temp_dir().join(format!("watt-desktop-test-{}", Ulid::new()));
        let status = Arc::new(RwLock::new(DesktopStatus::Starting));
        let client = Arc::new(RwLock::new(None));
        let (stop, stop_rx) = oneshot::channel();
        let worker = tokio::spawn(run_sidecar(
            PathBuf::from("/usr/bin/tail"),
            app_data_dir.clone(),
            status,
            client,
            stop_rx,
        ));

        stop.send(()).expect("stop receiver remains available");
        let result = timeout(SHUTDOWN_TIMEOUT, worker)
            .await
            .expect("shutdown must not wait for the startup handshake")
            .expect("sidecar worker completes");
        assert!(result.is_ok());
        std::fs::remove_dir_all(app_data_dir).expect("remove test app data");
    }
}
