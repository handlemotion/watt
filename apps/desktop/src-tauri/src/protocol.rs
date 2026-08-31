use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_FRAME_BYTES: usize = 1024 * 1024;
pub const MAX_PAYLOAD_BYTES: usize = 768 * 1024;
pub const MAX_JSON_DEPTH: usize = 64;
pub const MAX_IN_FLIGHT_REQUESTS: usize = 64;
pub const MAX_ACTIVE_SUBSCRIPTIONS: usize = 64;
pub const MAX_OUTBOUND_QUEUE_MESSAGES: usize = 64;
pub const MAX_OUTBOUND_QUEUE_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_SUBSCRIPTION_QUEUE_EVENTS: usize = 64;
pub const MAX_SUBSCRIPTION_QUEUE_BYTES: usize = 2 * 1024 * 1024;

pub const CAPABILITIES: &[&str] = &[
    "host.projects.v1",
    "host.workspaces.v1",
    "host.sessions.v1",
    "host.runs.v1",
    "run-stream.v1",
    "graceful-shutdown.v1",
];

const SCHEMA_JSON: &str = include_str!("../../../../packages/desktop-sidecar/protocol.schema.json");

#[derive(Debug, Clone, thiserror::Error)]
pub enum ProtocolError {
    #[error("{code}: {message}")]
    Invalid { code: String, message: String },
}

impl ProtocolError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::Invalid {
            code: code.into(),
            message: message.into(),
        }
    }

    pub fn code(&self) -> &str {
        match self {
            Self::Invalid { code, .. } => code,
        }
    }
}

#[derive(Debug, Clone, thiserror::Error)]
pub enum BridgeError {
    #[error("protocol error: {0}")]
    Protocol(#[from] ProtocolError),
    #[error("I/O error: {0}")]
    Io(String),
    #[error("sidecar error {code}: {message}")]
    Remote {
        code: String,
        message: String,
        details: Option<Value>,
    },
    #[error("sidecar disconnected")]
    Disconnected,
    #[error("protocol response did not match the requested type: {0}")]
    InvalidResponse(String),
}

impl From<std::io::Error> for BridgeError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value.to_string())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostOptions {
    pub state_dir: String,
    pub worktree_root: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lease_timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HelloEnvelope {
    #[serde(rename = "type")]
    pub kind: String,
    pub protocol_version_min: u32,
    pub protocol_version_max: u32,
    pub capabilities: Vec<String>,
    pub host: HostOptions,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RequestEnvelope {
    #[serde(rename = "type")]
    pub kind: String,
    pub version: u32,
    pub request_id: String,
    pub method: String,
    pub params: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WireError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerEnvelope {
    #[serde(rename_all = "camelCase")]
    HelloAck {
        version: u32,
        capabilities: Vec<String>,
    },
    #[serde(rename_all = "camelCase")]
    Result {
        version: u32,
        request_id: String,
        result: Value,
    },
    #[serde(rename_all = "camelCase")]
    Error {
        version: u32,
        #[serde(default)]
        request_id: Option<String>,
        fatal: bool,
        error: WireError,
        #[serde(default)]
        supported_versions: Option<Vec<u32>>,
        #[serde(default)]
        capabilities: Option<Vec<String>>,
    },
    #[serde(rename_all = "camelCase")]
    RunEvent {
        version: u32,
        subscription_id: String,
        run_id: String,
        event: HostEvent,
    },
    #[serde(rename_all = "camelCase")]
    StreamEnd {
        version: u32,
        subscription_id: String,
        run_id: String,
        reason: String,
        #[serde(default)]
        result: Option<RunResult>,
        #[serde(default)]
        error: Option<WireError>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StreamEndEnvelope {
    pub version: u32,
    pub subscription_id: String,
    pub run_id: String,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<RunResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<WireError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostEvent {
    pub workspace_id: String,
    pub session_id: String,
    pub run_id: String,
    pub sequence: u64,
    #[serde(flatten)]
    pub event: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Project {
    pub id: String,
    pub repo_root: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Workspace {
    pub id: String,
    pub project_id: String,
    pub worktree_path: String,
    pub branch: String,
    pub slug: String,
    pub base_ref: String,
    pub created_at: u64,
    pub archived_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Session {
    pub id: String,
    pub workspace_id: String,
    pub runtime: String,
    pub cursor_agent_id: String,
    pub mode: String,
    pub model: Value,
    pub execution_policy: Value,
    pub created_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Run {
    pub id: String,
    pub session_id: String,
    pub status: String,
    pub created_at: u64,
    pub started_at: Option<u64>,
    pub finished_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunResult {
    pub run_id: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<RunError>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunError {
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateWorkspaceInput {
    pub project_id: String,
    pub slug: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub copy_globs: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateSessionInput {
    pub workspace_id: String,
    pub prompt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution_policy: Option<Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiagnosticOperationFilters {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include_completed: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostCapabilities {
    pub runtime: String,
    pub runtimes: Vec<Value>,
    pub modes: Vec<String>,
    pub models: Vec<Value>,
    pub model_catalog: Value,
    pub execution_policy: Value,
}

fn validator() -> &'static jsonschema::Validator {
    static VALIDATOR: OnceLock<jsonschema::Validator> = OnceLock::new();
    VALIDATOR.get_or_init(|| {
        let schema: Value =
            serde_json::from_str(SCHEMA_JSON).expect("bundled protocol schema is JSON");
        jsonschema::validator_for(&schema).expect("bundled protocol schema compiles")
    })
}

fn validate_direction(value: &Value, client: bool) -> Result<(), ProtocolError> {
    if let Err(error) = validator().validate(value) {
        return Err(ProtocolError::new("invalid_envelope", error.to_string()));
    }
    let kind = value
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| ProtocolError::new("invalid_envelope", "envelope has no type"))?;
    let valid_direction = if client {
        matches!(kind, "hello" | "request")
    } else {
        matches!(
            kind,
            "hello_ack" | "result" | "error" | "run_event" | "stream_end"
        )
    };
    if !valid_direction {
        return Err(ProtocolError::new(
            "invalid_envelope",
            "envelope is not valid in this direction",
        ));
    }
    Ok(())
}

pub fn validate_client(value: &Value) -> Result<(), ProtocolError> {
    validate_direction(value, true)?;
    if value.get("type").and_then(Value::as_str) == Some("request") {
        validate_request(value)?;
    }
    Ok(())
}

pub fn validate_server(value: &Value) -> Result<(), ProtocolError> {
    validate_direction(value, false)?;
    let payload = match value.get("type").and_then(Value::as_str) {
        Some("result") => value.get("result"),
        Some("run_event") => value.get("event"),
        _ => None,
    };
    if let Some(payload) = payload
        && serde_json::to_vec(payload)
            .map_err(|error| ProtocolError::new("invalid_payload", error.to_string()))?
            .len()
            > MAX_PAYLOAD_BYTES
    {
        return Err(ProtocolError::new(
            "payload_too_large",
            "payload exceeds maximum size",
        ));
    }
    Ok(())
}

fn validate_request(value: &Value) -> Result<(), ProtocolError> {
    let method = value
        .get("method")
        .and_then(Value::as_str)
        .ok_or_else(|| ProtocolError::new("invalid_params", "request method is missing"))?;
    let params = value
        .get("params")
        .and_then(Value::as_object)
        .ok_or_else(|| ProtocolError::new("invalid_params", "params must be an object"))?;
    let keys = |required: &[&str], optional: &[&str]| -> Result<(), ProtocolError> {
        for required_key in required {
            if !params.contains_key(*required_key) {
                return Err(ProtocolError::new(
                    "invalid_params",
                    format!("missing param: {required_key}"),
                ));
            }
        }
        for key in params.keys() {
            if !required.contains(&key.as_str()) && !optional.contains(&key.as_str()) {
                return Err(ProtocolError::new(
                    "invalid_params",
                    format!("unknown param: {key}"),
                ));
            }
        }
        Ok(())
    };
    let string = |name: &str| -> Result<(), ProtocolError> {
        if params
            .get(name)
            .and_then(Value::as_str)
            .is_some_and(|value| !value.is_empty())
        {
            Ok(())
        } else {
            Err(ProtocolError::new(
                "invalid_params",
                format!("{name} must be a non-empty string"),
            ))
        }
    };
    let id = |name: &str| -> Result<(), ProtocolError> {
        string(name)?;
        let value = params.get(name).and_then(Value::as_str).unwrap_or_default();
        if value.len() == 26
            && value
                .bytes()
                .all(|byte| matches!(byte, b'0'..=b'9' | b'A'..=b'H' | b'J'..=b'N' | b'P'..=b'T' | b'V'..=b'Z'))
        {
            Ok(())
        } else {
            Err(ProtocolError::new(
                "invalid_params",
                format!("{name} must be a ULID"),
            ))
        }
    };
    let optional_bool = |name: &str| -> Result<(), ProtocolError> {
        match params.get(name) {
            None | Some(Value::Bool(_)) => Ok(()),
            _ => Err(ProtocolError::new(
                "invalid_params",
                format!("{name} must be a boolean"),
            )),
        }
    };
    match method {
        "projects.register" => {
            keys(&["repoRoot"], &[])?;
            string("repoRoot")
        }
        "projects.get" | "workspaces.get" | "sessions.get" | "runs.get" => {
            keys(&["id"], &[])?;
            id("id")
        }
        "projects.list" | "host.capabilities" | "host.close" => keys(&[], &[]),
        "projects.reconcile" => {
            keys(&["projectId"], &[])?;
            id("projectId")
        }
        "workspaces.create" => {
            keys(&["projectId", "slug"], &["branch", "baseRef", "copyGlobs"])?;
            id("projectId")?;
            string("slug")?;
            for name in ["branch", "baseRef"] {
                if params.contains_key(name) {
                    string(name)?;
                }
            }
            if let Some(copy_globs) = params.get("copyGlobs")
                && !copy_globs
                    .as_array()
                    .is_some_and(|items| items.iter().all(Value::is_string))
            {
                return Err(ProtocolError::new(
                    "invalid_params",
                    "copyGlobs must be a string array",
                ));
            }
            Ok(())
        }
        "workspaces.list" => {
            keys(&["projectId"], &["includeArchived"])?;
            id("projectId")?;
            optional_bool("includeArchived")
        }
        "workspaces.archive" => {
            keys(&["workspaceId"], &["keepBranch"])?;
            id("workspaceId")?;
            optional_bool("keepBranch")
        }
        "sessions.create" => {
            keys(
                &["workspaceId", "prompt"],
                &["runtime", "model", "mode", "executionPolicy"],
            )?;
            id("workspaceId")?;
            string("prompt")?;
            if params.get("model").is_some_and(|value| !value.is_object())
                || params
                    .get("executionPolicy")
                    .is_some_and(|value| !value.is_object())
            {
                return Err(ProtocolError::new(
                    "invalid_params",
                    "model and executionPolicy must be objects",
                ));
            }
            if let Some(mode) = params.get("mode").and_then(Value::as_str)
                && !matches!(mode, "agent" | "plan")
            {
                return Err(ProtocolError::new(
                    "invalid_params",
                    "mode must be agent or plan",
                ));
            }
            if let Some(runtime) = params.get("runtime").and_then(Value::as_str)
                && !matches!(runtime, "cursor-local" | "codex-local")
            {
                return Err(ProtocolError::new(
                    "invalid_params",
                    "runtime must be cursor-local or codex-local",
                ));
            }
            Ok(())
        }
        "sessions.list" => {
            keys(&["workspaceId"], &[])?;
            id("workspaceId")
        }
        "sessions.send" => {
            keys(&["sessionId", "prompt"], &[])?;
            id("sessionId")?;
            string("prompt")
        }
        "runs.list" => {
            keys(&["sessionId"], &[])?;
            id("sessionId")
        }
        "runs.wait" | "runs.cancel" => {
            keys(&["runId"], &[])?;
            id("runId")
        }
        "runs.attach" => {
            keys(&["runId", "subscriptionId"], &["afterSequence"])?;
            id("runId")?;
            id("subscriptionId")?;
            if let Some(sequence) = params.get("afterSequence")
                && sequence.as_u64().is_none()
            {
                return Err(ProtocolError::new(
                    "invalid_params",
                    "afterSequence must be a non-negative integer",
                ));
            }
            Ok(())
        }
        "runs.unsubscribe" => {
            keys(&["subscriptionId"], &[])?;
            id("subscriptionId")
        }
        "diagnostics.operations.get" => {
            keys(&["operationId"], &[])?;
            id("operationId")
        }
        "diagnostics.operations.list" => {
            keys(&[], &["projectId", "workspaceId", "includeCompleted"])?;
            if params.contains_key("projectId") {
                id("projectId")?;
            }
            if params.contains_key("workspaceId") {
                id("workspaceId")?;
            }
            optional_bool("includeCompleted")
        }
        _ => Err(ProtocolError::new("method_not_found", "unsupported method")),
    }
}

fn assert_depth(bytes: &[u8]) -> Result<(), ProtocolError> {
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    for byte in bytes {
        if in_string {
            if escaped {
                escaped = false;
            } else if *byte == b'\\' {
                escaped = true;
            } else if *byte == b'"' {
                in_string = false;
            }
            continue;
        }
        match *byte {
            b'"' => in_string = true,
            b'{' | b'[' => {
                depth += 1;
                if depth > MAX_JSON_DEPTH {
                    return Err(ProtocolError::new(
                        "json_too_deep",
                        "JSON nesting limit exceeded",
                    ));
                }
            }
            b'}' | b']' => {
                depth = depth.checked_sub(1).ok_or_else(|| {
                    ProtocolError::new("malformed_json", "malformed JSON nesting")
                })?;
            }
            _ => {}
        }
    }
    Ok(())
}

pub fn encode_frame<T: Serialize>(value: &T) -> Result<Vec<u8>, ProtocolError> {
    let payload = serde_json::to_vec(value)
        .map_err(|error| ProtocolError::new("invalid_payload", error.to_string()))?;
    assert_depth(&payload)?;
    if payload.len() > MAX_FRAME_BYTES {
        return Err(ProtocolError::new(
            "frame_too_large",
            "frame exceeds maximum size",
        ));
    }
    let mut frame = Vec::with_capacity(payload.len() + 4);
    frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    frame.extend_from_slice(&payload);
    Ok(frame)
}

pub fn decode_payload(payload: &[u8]) -> Result<Value, ProtocolError> {
    if payload.is_empty() {
        return Err(ProtocolError::new("malformed_frame", "empty frame"));
    }
    if payload.len() > MAX_FRAME_BYTES {
        return Err(ProtocolError::new(
            "frame_too_large",
            "frame exceeds maximum size",
        ));
    }
    std::str::from_utf8(payload)
        .map_err(|_| ProtocolError::new("invalid_utf8", "frame is not valid UTF-8"))?;
    assert_depth(payload)?;
    serde_json::from_slice(payload)
        .map_err(|error| ProtocolError::new("malformed_json", error.to_string()))
}

pub async fn read_value<R: AsyncRead + Unpin>(reader: &mut R) -> Result<Value, BridgeError> {
    let mut header = [0u8; 4];
    reader.read_exact(&mut header).await?;
    let length = u32::from_be_bytes(header) as usize;
    if length == 0 {
        return Err(ProtocolError::new("malformed_frame", "empty frame").into());
    }
    if length > MAX_FRAME_BYTES {
        return Err(ProtocolError::new("frame_too_large", "frame exceeds maximum size").into());
    }
    let mut payload = vec![0u8; length];
    reader.read_exact(&mut payload).await?;
    Ok(decode_payload(&payload)?)
}

pub async fn write_value<W: AsyncWrite + Unpin, T: Serialize>(
    writer: &mut W,
    value: &T,
) -> Result<(), BridgeError> {
    let frame = encode_frame(value)?;
    writer.write_all(&frame).await?;
    writer.flush().await?;
    Ok(())
}
