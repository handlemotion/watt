use std::{
    collections::{HashMap, HashSet},
    env,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, RecvTimeoutError},
    },
    thread,
    time::{Duration, Instant},
};

use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::Serialize;
use tauri::{State, ipc::Channel};
use ulid::Ulid;

use crate::{desktop::DesktopRuntime, protocol::Workspace};

const MAX_OUTPUT_CHUNK: usize = 16 * 1024;
const OUTPUT_WINDOW: Duration = Duration::from_millis(4);
const OUTPUT_QUEUE_DEPTH: usize = 64;
const MAX_INPUT_CHUNK: usize = 64 * 1024;
const SHUTDOWN_GRACE: Duration = Duration::from_millis(750);
const MIN_COLS: u16 = 2;
const MAX_COLS: u16 = 1_000;
const MIN_ROWS: u16 = 1;
const MAX_ROWS: u16 = 1_000;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalDescriptor {
    terminal_id: String,
    workspace_id: String,
    reused: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum TerminalEvent {
    Output { data: Vec<u8> },
    Exit { code: u32, signal: Option<String> },
    Error { message: String },
}

struct ProcessHandle {
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    process_group: Option<i32>,
}

enum OutputMessage {
    Bytes(Vec<u8>),
    Error(String),
}

struct TerminalSession {
    terminal_id: String,
    workspace_id: String,
    cwd: PathBuf,
    events: Channel<TerminalEvent>,
    generation: AtomicU64,
    exited: AtomicBool,
    process: Mutex<Option<ProcessHandle>>,
}

impl TerminalSession {
    fn descriptor(&self, reused: bool) -> TerminalDescriptor {
        TerminalDescriptor {
            terminal_id: self.terminal_id.clone(),
            workspace_id: self.workspace_id.clone(),
            reused,
        }
    }

    fn spawn(self: &Arc<Self>, cols: u16, rows: u16) -> Result<(), String> {
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.exited.store(false, Ordering::SeqCst);
        let pair = native_pty_system()
            .openpty(pty_size(cols, rows))
            .map_err(|error| format!("failed to open terminal: {error}"))?;
        let command = shell_command(&self.cwd);
        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| format!("failed to start login shell: {error}"))?;
        drop(pair.slave);

        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| format!("failed to read terminal: {error}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| format!("failed to write terminal: {error}"))?;
        let master = Arc::new(Mutex::new(pair.master));
        #[cfg(unix)]
        let process_group = master
            .lock()
            .expect("terminal master lock poisoned")
            .process_group_leader();
        #[cfg(not(unix))]
        let process_group = None;
        let killer = child.clone_killer();
        *self.process.lock().expect("terminal process lock poisoned") = Some(ProcessHandle {
            master,
            writer: Arc::new(Mutex::new(writer)),
            killer: Mutex::new(killer),
            process_group,
        });

        let (chunks_tx, chunks_rx) = mpsc::sync_channel::<OutputMessage>(OUTPUT_QUEUE_DEPTH);
        let (drained_tx, drained_rx) = mpsc::channel();
        let session = self.clone();
        thread::Builder::new()
            .name(format!("watt-terminal-reader-{}", self.terminal_id))
            .spawn(move || read_output(reader, chunks_tx))
            .map_err(|error| error.to_string())?;
        let output_session = self.clone();
        thread::Builder::new()
            .name(format!("watt-terminal-output-{}", self.terminal_id))
            .spawn(move || {
                forward_output(&output_session, generation, chunks_rx);
                let _ = drained_tx.send(());
            })
            .map_err(|error| error.to_string())?;
        thread::Builder::new()
            .name(format!("watt-terminal-wait-{}", self.terminal_id))
            .spawn(move || {
                let status = child.wait();
                let _ = drained_rx.recv_timeout(Duration::from_secs(1));
                if session.generation.load(Ordering::SeqCst) != generation {
                    return;
                }
                session.exited.store(true, Ordering::SeqCst);
                match status {
                    Ok(status) => {
                        let _ = session.events.send(TerminalEvent::Exit {
                            code: status.exit_code(),
                            signal: status.signal().map(ToOwned::to_owned),
                        });
                    }
                    Err(error) => {
                        let _ = session.events.send(TerminalEvent::Error {
                            message: format!("failed to reap terminal: {error}"),
                        });
                    }
                }
            })
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    fn write(&self, data: &[u8]) -> Result<(), String> {
        if data.len() > MAX_INPUT_CHUNK {
            return Err("terminal input exceeds 64 KiB".into());
        }
        let process = self.process.lock().expect("terminal process lock poisoned");
        let process = process.as_ref().ok_or("terminal is not running")?;
        let mut writer = process
            .writer
            .lock()
            .expect("terminal writer lock poisoned");
        writer.write_all(data).map_err(|error| error.to_string())?;
        writer.flush().map_err(|error| error.to_string())
    }

    fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        let process = self.process.lock().expect("terminal process lock poisoned");
        let process = process.as_ref().ok_or("terminal is not running")?;
        process
            .master
            .lock()
            .expect("terminal master lock poisoned")
            .resize(pty_size(cols, rows))
            .map_err(|error| error.to_string())
    }

    fn stop(&self) {
        let process = self
            .process
            .lock()
            .expect("terminal process lock poisoned")
            .take();
        let Some(process) = process else { return };
        terminate_process_group(process.process_group, libc::SIGTERM);
        let deadline = Instant::now() + SHUTDOWN_GRACE;
        while !self.exited.load(Ordering::SeqCst) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        if !self.exited.load(Ordering::SeqCst) {
            terminate_process_group(process.process_group, libc::SIGKILL);
            let _ = process
                .killer
                .lock()
                .expect("terminal killer lock poisoned")
                .kill();
        }
        drop(process);
    }
}

pub(crate) struct TerminalRegistry {
    state: Mutex<RegistryState>,
}

struct RegistryState {
    sessions: HashMap<String, Arc<TerminalSession>>,
    workspace_terminals: HashMap<String, String>,
}

impl TerminalRegistry {
    pub(crate) fn new() -> Self {
        Self {
            state: Mutex::new(RegistryState {
                sessions: HashMap::new(),
                workspace_terminals: HashMap::new(),
            }),
        }
    }

    fn open(
        &self,
        workspace_id: String,
        cwd: PathBuf,
        cols: u16,
        rows: u16,
        events: Channel<TerminalEvent>,
    ) -> Result<TerminalDescriptor, String> {
        let mut state = self.state.lock().expect("terminal registry lock poisoned");
        if let Some(terminal_id) = state.workspace_terminals.get(&workspace_id)
            && let Some(session) = state.sessions.get(terminal_id)
        {
            return Ok(session.descriptor(true));
        }
        let terminal_id = Ulid::new().to_string();
        let session = Arc::new(TerminalSession {
            terminal_id: terminal_id.clone(),
            workspace_id: workspace_id.clone(),
            cwd,
            events,
            generation: AtomicU64::new(0),
            exited: AtomicBool::new(false),
            process: Mutex::new(None),
        });
        session.spawn(cols, rows)?;
        state.sessions.insert(terminal_id.clone(), session.clone());
        state.workspace_terminals.insert(workspace_id, terminal_id);
        Ok(session.descriptor(false))
    }

    fn session(&self, terminal_id: &str) -> Result<Arc<TerminalSession>, String> {
        self.state
            .lock()
            .expect("terminal registry lock poisoned")
            .sessions
            .get(terminal_id)
            .cloned()
            .ok_or_else(|| "unknown terminal".into())
    }

    pub(crate) fn retain_workspaces(&self, active: &HashSet<String>) {
        let stale = self
            .state
            .lock()
            .expect("terminal registry lock poisoned")
            .workspace_terminals
            .iter()
            .filter(|(workspace_id, _)| !active.contains(*workspace_id))
            .map(|(_, terminal_id)| terminal_id.clone())
            .collect::<Vec<_>>();
        for terminal_id in stale {
            self.remove(&terminal_id);
        }
    }

    fn remove(&self, terminal_id: &str) {
        let session = {
            let mut state = self.state.lock().expect("terminal registry lock poisoned");
            let session = state.sessions.remove(terminal_id);
            if let Some(session) = &session {
                state.workspace_terminals.remove(&session.workspace_id);
            }
            session
        };
        if let Some(session) = session {
            session.stop();
        }
    }

    pub(crate) fn shutdown_all(&self) {
        let terminal_ids = self
            .state
            .lock()
            .expect("terminal registry lock poisoned")
            .sessions
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        for terminal_id in terminal_ids {
            self.remove(&terminal_id);
        }
    }
}

#[tauri::command]
pub(crate) async fn terminal_open(
    runtime: State<'_, Arc<DesktopRuntime>>,
    terminals: State<'_, Arc<TerminalRegistry>>,
    workspace_id: String,
    cols: u16,
    rows: u16,
    on_event: Channel<TerminalEvent>,
) -> Result<TerminalDescriptor, String> {
    let client = runtime.client().ok_or("local Host is not ready")?;
    let workspace = client
        .get_workspace(&workspace_id)
        .await
        .map_err(|error| error.to_string())?;
    let cwd = resolve_workspace_path(workspace)?;
    terminals.open(workspace_id, cwd, cols, rows, on_event)
}

fn resolve_workspace_path(workspace: Option<Workspace>) -> Result<PathBuf, String> {
    let workspace = workspace.ok_or("workspace does not exist")?;
    if workspace.archived_at.is_some() {
        return Err("archived workspaces cannot open terminals".into());
    }
    let cwd = std::fs::canonicalize(workspace.worktree_path)
        .map_err(|_| "workspace worktree is unavailable")?;
    cwd.is_dir()
        .then_some(cwd)
        .ok_or_else(|| "workspace worktree is unavailable".into())
}

#[tauri::command]
pub(crate) fn terminal_write(
    terminals: State<'_, Arc<TerminalRegistry>>,
    terminal_id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    terminals.session(&terminal_id)?.write(&data)
}

#[tauri::command]
pub(crate) fn terminal_resize(
    terminals: State<'_, Arc<TerminalRegistry>>,
    terminal_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    terminals.session(&terminal_id)?.resize(cols, rows)
}

#[tauri::command]
pub(crate) fn terminal_restart(
    terminals: State<'_, Arc<TerminalRegistry>>,
    terminal_id: String,
) -> Result<(), String> {
    let session = terminals.session(&terminal_id)?;
    let size = session
        .process
        .lock()
        .expect("terminal process lock poisoned")
        .as_ref()
        .and_then(|process| process.master.lock().ok()?.get_size().ok())
        .unwrap_or_default();
    session.generation.fetch_add(1, Ordering::SeqCst);
    session.stop();
    session.spawn(size.cols, size.rows)
}

#[tauri::command]
pub(crate) fn terminal_kill(
    terminals: State<'_, Arc<TerminalRegistry>>,
    terminal_id: String,
) -> Result<(), String> {
    terminals.session(&terminal_id)?.stop();
    Ok(())
}

fn shell_command(cwd: &Path) -> CommandBuilder {
    let shell = env::var_os("SHELL")
        .filter(|shell| !shell.is_empty())
        .unwrap_or_else(|| "/bin/zsh".into());
    let mut command = CommandBuilder::new(shell);
    command.arg("-l");
    command.cwd(cwd);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command.env("TERM_PROGRAM", "Watt");
    command.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));
    command
}

fn pty_size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        cols: cols.clamp(MIN_COLS, MAX_COLS),
        rows: rows.clamp(MIN_ROWS, MAX_ROWS),
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn read_output(mut reader: Box<dyn Read + Send>, chunks: mpsc::SyncSender<OutputMessage>) {
    loop {
        let mut bytes = vec![0; MAX_OUTPUT_CHUNK];
        match reader.read(&mut bytes) {
            Ok(0) => break,
            Err(error) => {
                let _ = chunks.send(OutputMessage::Error(error.to_string()));
                break;
            }
            Ok(length) => {
                bytes.truncate(length);
                if chunks.send(OutputMessage::Bytes(bytes)).is_err() {
                    break;
                }
            }
        }
    }
}

fn forward_output(
    session: &TerminalSession,
    generation: u64,
    chunks: mpsc::Receiver<OutputMessage>,
) {
    while let Ok(message) = chunks.recv() {
        let first = match message {
            OutputMessage::Bytes(bytes) => bytes,
            OutputMessage::Error(message) => {
                if session.generation.load(Ordering::SeqCst) == generation {
                    let _ = session.events.send(TerminalEvent::Error { message });
                }
                break;
            }
        };
        let deadline = Instant::now() + OUTPUT_WINDOW;
        let mut output = first;
        while output.len() < MAX_OUTPUT_CHUNK {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            match chunks.recv_timeout(remaining) {
                Ok(OutputMessage::Bytes(mut next)) => {
                    let available = MAX_OUTPUT_CHUNK - output.len();
                    if next.len() <= available {
                        output.append(&mut next);
                    } else {
                        output.extend_from_slice(&next[..available]);
                        let remainder = next.split_off(available);
                        if session.generation.load(Ordering::SeqCst) == generation {
                            let _ = session.events.send(TerminalEvent::Output { data: output });
                            output = remainder;
                        }
                    }
                }
                Ok(OutputMessage::Error(message)) => {
                    if session.generation.load(Ordering::SeqCst) == generation {
                        let _ = session.events.send(TerminalEvent::Error { message });
                    }
                    break;
                }
                Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => break,
            }
        }
        if session.generation.load(Ordering::SeqCst) == generation {
            let _ = session.events.send(TerminalEvent::Output { data: output });
        }
    }
}

#[cfg(unix)]
fn terminate_process_group(process_group: Option<i32>, signal: i32) {
    if let Some(process_group) = process_group {
        // SAFETY: kill is called with a PTY-provided process-group identifier.
        unsafe {
            libc::kill(-process_group, signal);
        }
    }
}

#[cfg(not(unix))]
fn terminate_process_group(_process_group: Option<i32>, _signal: i32) {}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::ipc::InvokeResponseBody;

    #[test]
    fn terminal_sizes_are_clamped() {
        assert_eq!(pty_size(0, 0).cols, MIN_COLS);
        assert_eq!(pty_size(0, 0).rows, MIN_ROWS);
        assert_eq!(pty_size(u16::MAX, u16::MAX).cols, MAX_COLS);
        assert_eq!(pty_size(u16::MAX, u16::MAX).rows, MAX_ROWS);
    }

    #[test]
    fn login_shell_uses_workspace_and_terminal_environment() {
        let command = shell_command(Path::new("/tmp/watt-worktree"));
        assert_eq!(
            command.get_argv().get(1).and_then(|arg| arg.to_str()),
            Some("-l")
        );
        assert_eq!(
            command.get_cwd().and_then(|cwd| cwd.to_str()),
            Some("/tmp/watt-worktree")
        );
        assert_eq!(
            command.get_env("TERM"),
            Some(std::ffi::OsStr::new("xterm-256color"))
        );
        assert_eq!(
            command.get_env("COLORTERM"),
            Some(std::ffi::OsStr::new("truecolor"))
        );
        assert_eq!(
            command.get_env("TERM_PROGRAM"),
            Some(std::ffi::OsStr::new("Watt"))
        );
    }

    #[test]
    fn output_is_coalesced_in_order() {
        let (events_tx, events_rx) = mpsc::channel();
        let events = Channel::new(move |body| {
            if let InvokeResponseBody::Json(json) = body {
                let _ = events_tx.send(json);
            }
            Ok(())
        });
        let session = TerminalSession {
            terminal_id: "terminal".into(),
            workspace_id: "workspace".into(),
            cwd: PathBuf::from("/tmp"),
            events,
            generation: AtomicU64::new(1),
            exited: AtomicBool::new(false),
            process: Mutex::new(None),
        };
        let (chunks_tx, chunks_rx) = mpsc::channel();
        chunks_tx
            .send(OutputMessage::Bytes(b"one".to_vec()))
            .unwrap();
        chunks_tx
            .send(OutputMessage::Bytes(b"two".to_vec()))
            .unwrap();
        drop(chunks_tx);
        forward_output(&session, 1, chunks_rx);
        let value: serde_json::Value =
            serde_json::from_str(&events_rx.recv().expect("terminal event")).unwrap();
        assert_eq!(value["type"], "output");
        assert_eq!(
            value["data"],
            serde_json::json!([111, 110, 101, 116, 119, 111])
        );
        assert!(events_rx.try_recv().is_err());
    }

    #[test]
    fn workspace_authorization_rejects_missing_and_archived_records() {
        assert_eq!(
            resolve_workspace_path(None).unwrap_err(),
            "workspace does not exist"
        );
        let archived = Workspace {
            id: "workspace".into(),
            project_id: "project".into(),
            worktree_path: "/tmp".into(),
            branch: "main".into(),
            slug: "workspace".into(),
            base_ref: "main".into(),
            created_at: 1,
            archived_at: Some(2),
        };
        assert_eq!(
            resolve_workspace_path(Some(archived)).unwrap_err(),
            "archived workspaces cannot open terminals"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn real_pty_reports_pwd_ansi_and_exit_status() {
        let pair = native_pty_system()
            .openpty(pty_size(80, 24))
            .expect("open pty");
        let mut command = CommandBuilder::new("/bin/zsh");
        command.args([
            "-f",
            "-c",
            "pwd; stty size; printf '\u{1b}[31mansi\u{1b}[0m\u{1b}[?1049h\u{1b}[?1049l'; exit 7",
        ]);
        command.cwd("/tmp");
        let mut child = pair.slave.spawn_command(command).expect("spawn fixture");
        drop(pair.slave);
        pair.master.resize(pty_size(100, 40)).expect("resize pty");
        let mut reader = pair.master.try_clone_reader().expect("clone reader");
        let mut output = String::new();
        reader
            .read_to_string(&mut output)
            .expect("read fixture output");
        let status = child.wait().expect("wait fixture");
        assert!(output.contains("/tmp"), "missing cwd in {output:?}");
        assert!(
            output.contains("40 100"),
            "missing terminal size in {output:?}"
        );
        assert!(
            output.contains("\u{1b}[31mansi\u{1b}[0m"),
            "missing ANSI output in {output:?}"
        );
        assert!(
            output.contains("\u{1b}[?1049h\u{1b}[?1049l"),
            "missing alternate-screen sequence in {output:?}"
        );
        assert_eq!(status.exit_code(), 7);
    }
}
