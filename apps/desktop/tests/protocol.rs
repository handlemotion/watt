use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt, duplex, split};
use watt_desktop::{
    RunStreamItem, SidecarHostClient,
    protocol::{
        HostOptions, MAX_FRAME_BYTES, MAX_JSON_DEPTH, PROTOCOL_VERSION, ServerEnvelope,
        decode_payload, encode_frame, read_value, validate_client, validate_server, write_value,
    },
};

const PROJECT_ID: &str = "01J00000000000000000000010";
const WORKSPACE_ID: &str = "01J00000000000000000000011";
const SESSION_ID: &str = "01J00000000000000000000012";
const RUN_ID: &str = "01J00000000000000000000013";

#[derive(Deserialize)]
struct Fixture {
    name: String,
    direction: String,
    valid: bool,
    value: Value,
}

#[test]
fn accepts_and_rejects_shared_compatibility_fixtures() {
    let fixtures: Vec<Fixture> = serde_json::from_str(include_str!(
        "../../../packages/desktop-sidecar/test/fixtures/protocol-fixtures.json"
    ))
    .expect("fixtures parse");
    for fixture in fixtures {
        let result = if fixture.direction == "client" {
            validate_client(&fixture.value)
        } else {
            validate_server(&fixture.value)
        };
        assert_eq!(
            result.is_ok(),
            fixture.valid,
            "fixture {} validation mismatch: {result:?}",
            fixture.name
        );
    }
}

#[test]
fn rejects_oversized_invalid_utf8_and_excessive_nesting() {
    let invalid_utf8 = [0xc3, 0x28];
    assert_eq!(
        decode_payload(&invalid_utf8).unwrap_err().code(),
        "invalid_utf8"
    );

    let deep = format!(
        "{}0{}",
        "[".repeat(MAX_JSON_DEPTH + 1),
        "]".repeat(MAX_JSON_DEPTH + 1)
    );
    assert_eq!(
        decode_payload(deep.as_bytes()).unwrap_err().code(),
        "json_too_deep"
    );

    let oversized = "x".repeat(MAX_FRAME_BYTES);
    assert_eq!(
        encode_frame(&json!({ "payload": oversized }))
            .unwrap_err()
            .code(),
        "frame_too_large"
    );
}

#[tokio::test]
async fn correlates_requests_and_streams_terminal_events() {
    let (client_io, server_io) = duplex(256 * 1024);
    let (client_reader, client_writer) = split(client_io);
    let (mut server_reader, mut server_writer) = split(server_io);

    let server = tokio::spawn(async move {
        let hello = read_value(&mut server_reader).await.expect("read hello");
        validate_client(&hello).expect("valid hello");
        write_value(
            &mut server_writer,
            &json!({
                "type": "hello_ack",
                "version": PROTOCOL_VERSION,
                "capabilities": ["host.projects.v1", "host.runs.v1", "run-stream.v1"]
            }),
        )
        .await
        .expect("write hello ack");

        let list_request = read_value(&mut server_reader).await.expect("read list");
        let list_id = list_request["requestId"].as_str().unwrap().to_owned();
        write_value(
            &mut server_writer,
            &json!({
                "type": "result",
                "version": 1,
                "requestId": list_id,
                "result": [{ "id": PROJECT_ID, "repoRoot": "/tmp/repo" }]
            }),
        )
        .await
        .expect("write list result");

        let attach_request = read_value(&mut server_reader).await.expect("read attach");
        let attach_id = attach_request["requestId"].as_str().unwrap().to_owned();
        let subscription_id = attach_request["params"]["subscriptionId"]
            .as_str()
            .unwrap()
            .to_owned();
        write_value(
            &mut server_writer,
            &json!({
                "type": "result",
                "version": 1,
                "requestId": attach_id,
                "result": { "subscriptionId": subscription_id }
            }),
        )
        .await
        .expect("write attach result");
        write_value(
            &mut server_writer,
            &json!({
                "type": "run_event",
                "version": 1,
                "subscriptionId": subscription_id,
                "runId": RUN_ID,
                "event": {
                    "type": "text_delta",
                    "text": "hello",
                    "workspaceId": WORKSPACE_ID,
                    "sessionId": SESSION_ID,
                    "runId": RUN_ID,
                    "sequence": 1
                }
            }),
        )
        .await
        .expect("write event");
        write_value(
            &mut server_writer,
            &json!({
                "type": "stream_end",
                "version": 1,
                "subscriptionId": subscription_id,
                "runId": RUN_ID,
                "reason": "finished",
                "result": { "runId": RUN_ID, "status": "finished" }
            }),
        )
        .await
        .expect("write terminal");
    });

    let client = SidecarHostClient::connect(
        client_reader,
        client_writer,
        HostOptions {
            state_dir: "/tmp/state".into(),
            worktree_root: "/tmp/trees".into(),
            lease_timeout_ms: None,
        },
    )
    .await
    .expect("connect");
    let projects = client.list_projects().await.expect("list projects");
    assert_eq!(projects[0].id, PROJECT_ID);

    let mut subscription = client.attach_run(RUN_ID, None).await.expect("attach");
    match subscription.recv().await.expect("event") {
        RunStreamItem::Event(event) => assert_eq!(event.sequence, 1),
        other => panic!("unexpected first stream item: {other:?}"),
    }
    match subscription.recv().await.expect("terminal") {
        RunStreamItem::End(end) => {
            assert_eq!(end.reason, "finished");
            assert_eq!(end.result.unwrap().status, "finished");
        }
        other => panic!("unexpected terminal stream item: {other:?}"),
    }
    server.await.expect("server task");
}

#[tokio::test]
async fn terminates_a_slow_run_consumer_at_the_bounded_queue() {
    let (client_io, server_io) = duplex(512 * 1024);
    let (client_reader, client_writer) = split(client_io);
    let (mut server_reader, mut server_writer) = split(server_io);
    let server = tokio::spawn(async move {
        let _hello = read_value(&mut server_reader).await.unwrap();
        write_value(
            &mut server_writer,
            &json!({
                "type": "hello_ack",
                "version": 1,
                "capabilities": ["host.runs.v1", "run-stream.v1"]
            }),
        )
        .await
        .unwrap();
        let attach = read_value(&mut server_reader).await.unwrap();
        let request_id = attach["requestId"].as_str().unwrap();
        let subscription_id = attach["params"]["subscriptionId"].as_str().unwrap();
        write_value(
            &mut server_writer,
            &json!({
                "type": "result",
                "version": 1,
                "requestId": request_id,
                "result": { "subscriptionId": subscription_id }
            }),
        )
        .await
        .unwrap();
        for sequence in 1..=65 {
            write_value(
                &mut server_writer,
                &json!({
                    "type": "run_event",
                    "version": 1,
                    "subscriptionId": subscription_id,
                    "runId": RUN_ID,
                    "event": {
                        "type": "status",
                        "status": "running",
                        "workspaceId": WORKSPACE_ID,
                        "sessionId": SESSION_ID,
                        "runId": RUN_ID,
                        "sequence": sequence
                    }
                }),
            )
            .await
            .unwrap();
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    });
    let client = SidecarHostClient::connect(
        client_reader,
        client_writer,
        HostOptions {
            state_dir: "/tmp/state".into(),
            worktree_root: "/tmp/trees".into(),
            lease_timeout_ms: None,
        },
    )
    .await
    .unwrap();
    let mut subscription = client.attach_run(RUN_ID, None).await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let mut event_count = 0;
    loop {
        match subscription.recv().await.expect("bounded terminal") {
            RunStreamItem::Event(_) => event_count += 1,
            RunStreamItem::End(end) => {
                assert_eq!(end.reason, "consumer_too_slow");
                break;
            }
        }
    }
    assert_eq!(event_count, 64);
    server.await.unwrap();
}

#[tokio::test]
async fn closes_the_writer_after_a_reader_side_disconnect() {
    let (client_io, server_io) = duplex(64 * 1024);
    let (client_reader, client_writer) = split(client_io);
    let (mut server_reader, mut server_writer) = split(server_io);
    let server = tokio::spawn(async move {
        let _hello = read_value(&mut server_reader).await.unwrap();
        write_value(
            &mut server_writer,
            &json!({
                "type": "hello_ack",
                "version": 1,
                "capabilities": []
            }),
        )
        .await
        .unwrap();
        server_writer.shutdown().await.unwrap();
        drop(server_writer);
        let mut remaining = Vec::new();
        tokio::time::timeout(
            std::time::Duration::from_millis(250),
            server_reader.read_to_end(&mut remaining),
        )
        .await
        .expect("client writer should close after reader disconnect")
        .unwrap();
    });

    let _client = SidecarHostClient::connect(
        client_reader,
        client_writer,
        HostOptions {
            state_dir: "/tmp/state".into(),
            worktree_root: "/tmp/trees".into(),
            lease_timeout_ms: None,
        },
    )
    .await
    .unwrap();
    server.await.unwrap();
}

#[tokio::test]
async fn closes_bridge_io_when_the_last_client_handle_is_dropped() {
    let (client_io, server_io) = duplex(64 * 1024);
    let (client_reader, client_writer) = split(client_io);
    let (mut server_reader, mut server_writer) = split(server_io);
    let server = tokio::spawn(async move {
        let _hello = read_value(&mut server_reader).await.unwrap();
        write_value(
            &mut server_writer,
            &json!({
                "type": "hello_ack",
                "version": 1,
                "capabilities": []
            }),
        )
        .await
        .unwrap();
        let mut remaining = Vec::new();
        tokio::time::timeout(
            std::time::Duration::from_millis(250),
            server_reader.read_to_end(&mut remaining),
        )
        .await
        .expect("bridge I/O should close when the client is dropped")
        .unwrap();
    });

    let client = SidecarHostClient::connect(
        client_reader,
        client_writer,
        HostOptions {
            state_dir: "/tmp/state".into(),
            worktree_root: "/tmp/trees".into(),
            lease_timeout_ms: None,
        },
    )
    .await
    .unwrap();
    drop(client);
    server.await.unwrap();
}

#[test]
fn server_envelope_deserializes_all_stream_fields() {
    let value = json!({
        "type": "stream_end",
        "version": 1,
        "subscriptionId": "01J00000000000000000000015",
        "runId": RUN_ID,
        "reason": "cancelled",
        "result": { "runId": RUN_ID, "status": "cancelled" }
    });
    let envelope: ServerEnvelope = serde_json::from_value(value).expect("stream end parses");
    assert!(matches!(envelope, ServerEnvelope::StreamEnd { reason, .. } if reason == "cancelled"));
}
