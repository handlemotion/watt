use std::{
    collections::HashMap,
    sync::{
        Arc, Weak,
        atomic::{AtomicBool, Ordering},
    },
};

use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncRead, AsyncWrite, AsyncWriteExt},
    sync::{Mutex, OwnedSemaphorePermit, Semaphore, mpsc, oneshot, watch},
};
use ulid::Ulid;

use crate::protocol::{
    BridgeError, CAPABILITIES, CreateSessionInput, CreateWorkspaceInput,
    DiagnosticOperationFilters, HelloEnvelope, HostCapabilities, HostEvent, HostOptions,
    MAX_ACTIVE_SUBSCRIPTIONS, MAX_IN_FLIGHT_REQUESTS, MAX_OUTBOUND_QUEUE_BYTES,
    MAX_OUTBOUND_QUEUE_MESSAGES, MAX_SUBSCRIPTION_QUEUE_BYTES, MAX_SUBSCRIPTION_QUEUE_EVENTS,
    PROTOCOL_VERSION, Project, RequestEnvelope, Run, RunResult, ServerEnvelope, Session,
    StreamEndEnvelope, WireError, Workspace, encode_frame, read_value, validate_client,
    validate_server, write_value,
};

type PendingSender = oneshot::Sender<Result<Value, BridgeError>>;

struct Outbound {
    frame: Vec<u8>,
    _bytes: OwnedSemaphorePermit,
}

struct QueuedRunItem {
    item: RunStreamItem,
    _bytes: Option<OwnedSemaphorePermit>,
}

#[derive(Debug, Clone)]
pub enum RunStreamItem {
    Event(HostEvent),
    End(StreamEndEnvelope),
}

struct SubscriptionSink {
    run_id: String,
    sender: mpsc::Sender<QueuedRunItem>,
    bytes: Arc<Semaphore>,
}

struct Inner {
    outbound: mpsc::Sender<Outbound>,
    outbound_bytes: Arc<Semaphore>,
    pending: Mutex<HashMap<String, PendingSender>>,
    pending_slots: Arc<Semaphore>,
    subscriptions: Mutex<HashMap<String, SubscriptionSink>>,
    writer_shutdown: watch::Sender<bool>,
    closed: AtomicBool,
}

#[derive(Clone)]
pub struct SidecarHostClient {
    inner: Arc<Inner>,
}

pub struct RunSubscription {
    id: String,
    client: SidecarHostClient,
    receiver: mpsc::Receiver<QueuedRunItem>,
    closed: bool,
}

impl SidecarHostClient {
    pub async fn connect<R, W>(
        mut reader: R,
        mut writer: W,
        host: HostOptions,
    ) -> Result<Self, BridgeError>
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let hello = HelloEnvelope {
            kind: "hello".into(),
            protocol_version_min: PROTOCOL_VERSION,
            protocol_version_max: PROTOCOL_VERSION,
            capabilities: CAPABILITIES.iter().map(|value| (*value).into()).collect(),
            host,
        };
        let hello_value = serde_json::to_value(&hello)
            .map_err(|error| BridgeError::InvalidResponse(error.to_string()))?;
        validate_client(&hello_value)?;
        write_value(&mut writer, &hello_value).await?;
        let response = read_value(&mut reader).await?;
        validate_server(&response)?;
        match serde_json::from_value::<ServerEnvelope>(response)
            .map_err(|error| BridgeError::InvalidResponse(error.to_string()))?
        {
            ServerEnvelope::HelloAck { version, .. } if version == PROTOCOL_VERSION => {}
            ServerEnvelope::Error { error, .. } => return Err(remote_error(error)),
            _ => {
                return Err(BridgeError::InvalidResponse(
                    "sidecar did not acknowledge the handshake".into(),
                ));
            }
        }

        let (outbound, outbound_rx) = mpsc::channel(MAX_OUTBOUND_QUEUE_MESSAGES);
        let (writer_shutdown, writer_shutdown_rx) = watch::channel(false);
        let reader_shutdown_rx = writer_shutdown.subscribe();
        let inner = Arc::new(Inner {
            outbound,
            outbound_bytes: Arc::new(Semaphore::new(MAX_OUTBOUND_QUEUE_BYTES)),
            pending: Mutex::new(HashMap::new()),
            pending_slots: Arc::new(Semaphore::new(MAX_IN_FLIGHT_REQUESTS)),
            subscriptions: Mutex::new(HashMap::new()),
            writer_shutdown,
            closed: AtomicBool::new(false),
        });
        tokio::spawn(writer_loop(
            writer,
            outbound_rx,
            Arc::downgrade(&inner),
            writer_shutdown_rx,
        ));
        tokio::spawn(reader_loop(
            reader,
            Arc::downgrade(&inner),
            reader_shutdown_rx,
        ));
        Ok(Self { inner })
    }

    pub async fn request<P, R>(&self, method: &str, params: &P) -> Result<R, BridgeError>
    where
        P: Serialize + ?Sized,
        R: DeserializeOwned,
    {
        let _slot = self
            .inner
            .pending_slots
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| BridgeError::Disconnected)?;
        let request_id = Ulid::new().to_string();
        let params = serde_json::to_value(params)
            .map_err(|error| BridgeError::InvalidResponse(error.to_string()))?;
        if serde_json::to_vec(&params)
            .map_err(|error| BridgeError::InvalidResponse(error.to_string()))?
            .len()
            > crate::protocol::MAX_PAYLOAD_BYTES
        {
            return Err(crate::protocol::ProtocolError::new(
                "payload_too_large",
                "request payload exceeds maximum size",
            )
            .into());
        }
        let envelope = RequestEnvelope {
            kind: "request".into(),
            version: PROTOCOL_VERSION,
            request_id: request_id.clone(),
            method: method.into(),
            params,
        };
        let value = serde_json::to_value(envelope)
            .map_err(|error| BridgeError::InvalidResponse(error.to_string()))?;
        validate_client(&value)?;
        let (sender, receiver) = oneshot::channel();
        self.inner
            .pending
            .lock()
            .await
            .insert(request_id.clone(), sender);
        if let Err(error) = enqueue(&self.inner, value).await {
            self.inner.pending.lock().await.remove(&request_id);
            return Err(error);
        }
        let value = receiver.await.map_err(|_| BridgeError::Disconnected)??;
        serde_json::from_value(value)
            .map_err(|error| BridgeError::InvalidResponse(error.to_string()))
    }

    pub async fn capabilities(&self) -> Result<HostCapabilities, BridgeError> {
        self.request("host.capabilities", &json!({})).await
    }

    pub async fn register_project(&self, repo_root: &str) -> Result<Project, BridgeError> {
        self.request("projects.register", &json!({ "repoRoot": repo_root }))
            .await
    }

    pub async fn get_project(&self, id: &str) -> Result<Option<Project>, BridgeError> {
        self.request("projects.get", &json!({ "id": id })).await
    }

    pub async fn list_projects(&self) -> Result<Vec<Project>, BridgeError> {
        self.request("projects.list", &json!({})).await
    }

    pub async fn reconcile_project(&self, project_id: &str) -> Result<Value, BridgeError> {
        self.request("projects.reconcile", &json!({ "projectId": project_id }))
            .await
    }

    pub async fn create_workspace(
        &self,
        input: CreateWorkspaceInput,
    ) -> Result<Workspace, BridgeError> {
        self.request("workspaces.create", &input).await
    }

    pub async fn get_workspace(&self, id: &str) -> Result<Option<Workspace>, BridgeError> {
        self.request("workspaces.get", &json!({ "id": id })).await
    }

    pub async fn list_workspaces(
        &self,
        project_id: &str,
        include_archived: bool,
    ) -> Result<Vec<Workspace>, BridgeError> {
        self.request(
            "workspaces.list",
            &json!({ "projectId": project_id, "includeArchived": include_archived }),
        )
        .await
    }

    pub async fn archive_workspace(
        &self,
        workspace_id: &str,
        keep_branch: Option<bool>,
    ) -> Result<Workspace, BridgeError> {
        let mut params = serde_json::Map::from_iter([(
            "workspaceId".into(),
            Value::String(workspace_id.into()),
        )]);
        if let Some(keep_branch) = keep_branch {
            params.insert("keepBranch".into(), Value::Bool(keep_branch));
        }
        self.request("workspaces.archive", &Value::Object(params))
            .await
    }

    pub async fn create_session(
        &self,
        input: CreateSessionInput,
    ) -> Result<(Session, Run), BridgeError> {
        #[derive(serde::Deserialize)]
        struct SessionRun {
            session: Session,
            run: Run,
        }
        let result: SessionRun = self.request("sessions.create", &input).await?;
        Ok((result.session, result.run))
    }

    pub async fn get_session(&self, id: &str) -> Result<Option<Session>, BridgeError> {
        self.request("sessions.get", &json!({ "id": id })).await
    }

    pub async fn list_sessions(&self, workspace_id: &str) -> Result<Vec<Session>, BridgeError> {
        self.request("sessions.list", &json!({ "workspaceId": workspace_id }))
            .await
    }

    pub async fn send_session(
        &self,
        session_id: &str,
        prompt: &str,
    ) -> Result<(Session, Run), BridgeError> {
        #[derive(serde::Deserialize)]
        struct SessionRun {
            session: Session,
            run: Run,
        }
        let result: SessionRun = self
            .request(
                "sessions.send",
                &json!({ "sessionId": session_id, "prompt": prompt }),
            )
            .await?;
        Ok((result.session, result.run))
    }

    pub async fn get_run(&self, id: &str) -> Result<Option<Run>, BridgeError> {
        self.request("runs.get", &json!({ "id": id })).await
    }

    pub async fn list_runs(&self, session_id: &str) -> Result<Vec<Run>, BridgeError> {
        self.request("runs.list", &json!({ "sessionId": session_id }))
            .await
    }

    pub async fn wait_run(&self, run_id: &str) -> Result<RunResult, BridgeError> {
        self.request("runs.wait", &json!({ "runId": run_id })).await
    }

    pub async fn cancel_run(&self, run_id: &str) -> Result<RunResult, BridgeError> {
        self.request("runs.cancel", &json!({ "runId": run_id }))
            .await
    }

    pub async fn attach_run(
        &self,
        run_id: &str,
        after_sequence: Option<u64>,
    ) -> Result<RunSubscription, BridgeError> {
        if self.inner.subscriptions.lock().await.len() >= MAX_ACTIVE_SUBSCRIPTIONS {
            return Err(crate::protocol::ProtocolError::new(
                "subscription_limit",
                "too many active subscriptions",
            )
            .into());
        }
        let subscription_id = Ulid::new().to_string();
        let (sender, receiver) = mpsc::channel(MAX_SUBSCRIPTION_QUEUE_EVENTS + 1);
        self.inner.subscriptions.lock().await.insert(
            subscription_id.clone(),
            SubscriptionSink {
                run_id: run_id.into(),
                sender,
                bytes: Arc::new(Semaphore::new(MAX_SUBSCRIPTION_QUEUE_BYTES)),
            },
        );
        let mut params = serde_json::Map::from_iter([
            ("runId".into(), Value::String(run_id.into())),
            (
                "subscriptionId".into(),
                Value::String(subscription_id.clone()),
            ),
        ]);
        if let Some(after_sequence) = after_sequence {
            params.insert("afterSequence".into(), Value::from(after_sequence));
        }
        let result: Result<Value, BridgeError> =
            self.request("runs.attach", &Value::Object(params)).await;
        if let Err(error) = result {
            self.inner
                .subscriptions
                .lock()
                .await
                .remove(&subscription_id);
            return Err(error);
        }
        Ok(RunSubscription {
            id: subscription_id,
            client: self.clone(),
            receiver,
            closed: false,
        })
    }

    pub async fn diagnostic_operation(
        &self,
        operation_id: &str,
    ) -> Result<Option<Value>, BridgeError> {
        self.request(
            "diagnostics.operations.get",
            &json!({ "operationId": operation_id }),
        )
        .await
    }

    pub async fn diagnostic_operations(
        &self,
        filters: DiagnosticOperationFilters,
    ) -> Result<Vec<Value>, BridgeError> {
        self.request("diagnostics.operations.list", &filters).await
    }

    pub async fn close(&self) -> Result<(), BridgeError> {
        let _: Value = self.request("host.close", &json!({})).await?;
        Ok(())
    }
}

impl RunSubscription {
    pub fn id(&self) -> &str {
        &self.id
    }

    pub async fn recv(&mut self) -> Option<RunStreamItem> {
        let queued = self.receiver.recv().await?;
        if matches!(queued.item, RunStreamItem::End(_)) {
            self.closed = true;
        }
        Some(queued.item)
    }

    pub async fn unsubscribe(mut self) -> Result<bool, BridgeError> {
        let result: Value = self
            .client
            .request("runs.unsubscribe", &json!({ "subscriptionId": self.id }))
            .await?;
        self.closed = true;
        self.client
            .inner
            .subscriptions
            .lock()
            .await
            .remove(&self.id);
        Ok(result
            .get("unsubscribed")
            .and_then(Value::as_bool)
            .unwrap_or(false))
    }
}

impl Drop for RunSubscription {
    fn drop(&mut self) {
        if self.closed {
            return;
        }
        let client = self.client.clone();
        let subscription_id = self.id.clone();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                client
                    .inner
                    .subscriptions
                    .lock()
                    .await
                    .remove(&subscription_id);
                let _: Result<Value, BridgeError> = client
                    .request(
                        "runs.unsubscribe",
                        &json!({ "subscriptionId": subscription_id }),
                    )
                    .await;
            });
        }
    }
}

async fn enqueue(inner: &Arc<Inner>, value: Value) -> Result<(), BridgeError> {
    if inner.closed.load(Ordering::Acquire) {
        return Err(BridgeError::Disconnected);
    }
    validate_client(&value)?;
    let frame = encode_frame(&value)?;
    let byte_count = u32::try_from(frame.len())
        .map_err(|_| crate::protocol::ProtocolError::new("frame_too_large", "frame too large"))?;
    let permit = inner
        .outbound_bytes
        .clone()
        .acquire_many_owned(byte_count)
        .await
        .map_err(|_| BridgeError::Disconnected)?;
    inner
        .outbound
        .send(Outbound {
            frame,
            _bytes: permit,
        })
        .await
        .map_err(|_| BridgeError::Disconnected)
}

async fn writer_loop<W: AsyncWrite + Unpin>(
    mut writer: W,
    mut receiver: mpsc::Receiver<Outbound>,
    inner: Weak<Inner>,
    mut shutdown: watch::Receiver<bool>,
) {
    loop {
        if *shutdown.borrow() {
            return;
        }
        let outbound = tokio::select! {
            biased;
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    return;
                }
                continue;
            }
            outbound = receiver.recv() => match outbound {
                Some(outbound) => outbound,
                None => return,
            },
        };
        if let Err(error) = writer.write_all(&outbound.frame).await {
            if let Some(inner) = inner.upgrade() {
                disconnect(&inner, BridgeError::Io(error.to_string())).await;
            }
            return;
        }
        if let Err(error) = writer.flush().await {
            if let Some(inner) = inner.upgrade() {
                disconnect(&inner, BridgeError::Io(error.to_string())).await;
            }
            return;
        }
    }
}

async fn reader_loop<R: AsyncRead + Unpin>(
    mut reader: R,
    inner: Weak<Inner>,
    mut shutdown: watch::Receiver<bool>,
) {
    loop {
        if *shutdown.borrow() {
            return;
        }
        let read = tokio::select! {
            biased;
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    return;
                }
                continue;
            }
            read = read_value(&mut reader) => read,
        };
        let value = match read {
            Ok(value) => value,
            Err(error) => {
                if let Some(inner) = inner.upgrade() {
                    disconnect(&inner, error).await;
                }
                return;
            }
        };
        let Some(inner) = inner.upgrade() else {
            return;
        };
        if let Err(error) = validate_server(&value) {
            disconnect(&inner, error.into()).await;
            return;
        }
        let envelope = match serde_json::from_value::<ServerEnvelope>(value) {
            Ok(envelope) => envelope,
            Err(error) => {
                disconnect(&inner, BridgeError::InvalidResponse(error.to_string())).await;
                return;
            }
        };
        match envelope {
            ServerEnvelope::Result {
                request_id, result, ..
            } => {
                if let Some(sender) = inner.pending.lock().await.remove(&request_id) {
                    let _ = sender.send(Ok(result));
                }
            }
            ServerEnvelope::Error {
                request_id,
                fatal,
                error,
                ..
            } => {
                let bridge_error = remote_error(error);
                if let Some(request_id) = request_id
                    && let Some(sender) = inner.pending.lock().await.remove(&request_id)
                {
                    let _ = sender.send(Err(bridge_error.clone()));
                }
                if fatal {
                    disconnect(&inner, bridge_error).await;
                    return;
                }
            }
            ServerEnvelope::RunEvent {
                subscription_id,
                event,
                ..
            } => {
                deliver_event(&inner, subscription_id, event).await;
            }
            ServerEnvelope::StreamEnd {
                version,
                subscription_id,
                run_id,
                reason,
                result,
                error,
            } => {
                let sink = inner.subscriptions.lock().await.remove(&subscription_id);
                if let Some(sink) = sink {
                    let _ = sink.sender.try_send(QueuedRunItem {
                        item: RunStreamItem::End(StreamEndEnvelope {
                            version,
                            subscription_id,
                            run_id,
                            reason,
                            result,
                            error,
                        }),
                        _bytes: None,
                    });
                }
            }
            ServerEnvelope::HelloAck { .. } => {
                disconnect(
                    &inner,
                    BridgeError::InvalidResponse("unexpected hello acknowledgement".into()),
                )
                .await;
                return;
            }
        }
    }
}

async fn deliver_event(inner: &Arc<Inner>, subscription_id: String, event: HostEvent) {
    let size = serde_json::to_vec(&event)
        .map(|value| value.len())
        .unwrap_or(MAX_SUBSCRIPTION_QUEUE_BYTES + 1);
    let permit_count = u32::try_from(size).unwrap_or(u32::MAX);
    let mut subscriptions = inner.subscriptions.lock().await;
    let Some(sink) = subscriptions.get(&subscription_id) else {
        return;
    };
    let permit = if sink.sender.capacity() <= 1 {
        None
    } else {
        sink.bytes.clone().try_acquire_many_owned(permit_count).ok()
    };
    let delivered = permit.and_then(|permit| {
        sink.sender
            .try_send(QueuedRunItem {
                item: RunStreamItem::Event(event),
                _bytes: Some(permit),
            })
            .ok()
    });
    if delivered.is_some() {
        return;
    }
    let Some(sink) = subscriptions.remove(&subscription_id) else {
        return;
    };
    let run_id = sink.run_id.clone();
    let _ = sink.sender.try_send(QueuedRunItem {
        item: RunStreamItem::End(StreamEndEnvelope {
            version: PROTOCOL_VERSION,
            subscription_id: subscription_id.clone(),
            run_id,
            reason: "consumer_too_slow".into(),
            result: None,
            error: Some(WireError {
                code: "consumer_too_slow".into(),
                message: "run event consumer exceeded its bounded queue".into(),
                details: None,
            }),
        }),
        _bytes: None,
    });
    drop(subscriptions);
    let value = serde_json::to_value(RequestEnvelope {
        kind: "request".into(),
        version: PROTOCOL_VERSION,
        request_id: Ulid::new().to_string(),
        method: "runs.unsubscribe".into(),
        params: json!({ "subscriptionId": subscription_id }),
    });
    if let Ok(value) = value {
        let inner = Arc::clone(inner);
        tokio::spawn(async move {
            let _ = enqueue(&inner, value).await;
        });
    }
}

async fn disconnect(inner: &Arc<Inner>, error: BridgeError) {
    if inner.closed.swap(true, Ordering::AcqRel) {
        return;
    }
    let _ = inner.writer_shutdown.send(true);
    inner.outbound_bytes.close();
    inner.pending_slots.close();
    let pending = std::mem::take(&mut *inner.pending.lock().await);
    for (_, sender) in pending {
        let _ = sender.send(Err(error.clone()));
    }
    let subscriptions = std::mem::take(&mut *inner.subscriptions.lock().await);
    for (subscription_id, sink) in subscriptions {
        let _ = sink.sender.try_send(QueuedRunItem {
            item: RunStreamItem::End(StreamEndEnvelope {
                version: PROTOCOL_VERSION,
                subscription_id,
                run_id: sink.run_id,
                reason: "sidecar_disconnected".into(),
                result: None,
                error: Some(WireError {
                    code: "sidecar_disconnected".into(),
                    message: error.to_string(),
                    details: None,
                }),
            }),
            _bytes: None,
        });
    }
}

fn remote_error(error: WireError) -> BridgeError {
    BridgeError::Remote {
        code: error.code,
        message: error.message,
        details: error.details,
    }
}
