//! Real control connections validate identity, bounded replies and explicit recovery semantics.
#![allow(clippy::unwrap_used, clippy::expect_used)]
#![cfg(feature = "transport")]

use axum::{
    Router,
    body::{Body, to_bytes},
    extract::{Request as HttpRequest, State as AxumState},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use chopin_job_broker::*;
use serde_json::Value;
use std::{
    collections::BTreeMap,
    convert::Infallible,
    num::{NonZeroU64, NonZeroUsize},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{net::TcpListener, sync::oneshot, task::JoinHandle};
use uuid::Uuid;

#[derive(Clone)]
struct Reply {
    status: StatusCode,
    body: Vec<u8>,
    location: Option<String>,
    chunked: bool,
}
impl Reply {
    fn json(value: impl serde::Serialize) -> Self {
        Self {
            status: StatusCode::OK,
            body: serde_json::to_vec(&value).unwrap(),
            location: None,
            chunked: false,
        }
    }
}
struct Call {
    method: String,
    path: String,
    headers: HeaderMap,
    body: Vec<u8>,
}
struct State {
    reply: Mutex<Reply>,
    calls: Mutex<Vec<Call>>,
}
struct Server {
    address: String,
    state: Arc<State>,
    stop: Option<oneshot::Sender<()>>,
    task: Option<JoinHandle<()>>,
}
impl Server {
    async fn new(reply: Reply) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = format!("http://{}/", listener.local_addr().unwrap());
        let state = Arc::new(State {
            reply: Mutex::new(reply),
            calls: Mutex::new(Vec::new()),
        });
        let router = Router::new().fallback(answer).with_state(state.clone());
        let (stop, closed) = oneshot::channel();
        let task = tokio::spawn(async move {
            axum::serve(listener, router)
                .with_graceful_shutdown(async {
                    let _ = closed.await;
                })
                .await
                .unwrap();
        });
        Self {
            address,
            state,
            stop: Some(stop),
            task: Some(task),
        }
    }
    fn reply(&self, reply: Reply) {
        *self.state.reply.lock().unwrap() = reply;
    }
    fn endpoint(&self, worker: Uuid) -> WorkerEndpoint {
        WorkerEndpoint::new(
            &self.address,
            Credential::new("transport-fixture".into()).unwrap(),
            worker,
        )
        .unwrap()
    }
    async fn close(mut self) {
        self.stop.take().unwrap().send(()).unwrap();
        self.task.take().unwrap().await.unwrap();
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}
async fn answer(AxumState(state): AxumState<Arc<State>>, request: HttpRequest) -> Response {
    let (parts, body) = request.into_parts();
    let body = to_bytes(body, usize::MAX).await.unwrap();
    state.calls.lock().unwrap().push(Call {
        method: parts.method.to_string(),
        path: parts.uri.path().into(),
        headers: parts.headers,
        body: body.to_vec(),
    });
    let reply = state.reply.lock().unwrap().clone();
    let body = if reply.chunked {
        Body::from_stream(futures_util::stream::iter([Ok::<_, Infallible>(
            reply.body,
        )]))
    } else {
        Body::from(reply.body)
    };
    let mut response = (reply.status, body).into_response();
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, "application/json".parse().unwrap());
    if let Some(location) = reply.location {
        response
            .headers_mut()
            .insert(header::LOCATION, location.parse().unwrap());
    }
    response
}
fn id() -> JobId {
    JobId {
        scope: Uuid::new_v4(),
        operation: Uuid::new_v4(),
    }
}
fn tls(roots: rustls::RootCertStore) -> rustls::ClientConfig {
    rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_root_certificates(roots)
        .with_no_client_auth()
}
fn builder() -> reqwest::ClientBuilder {
    let contract: Value =
        serde_json::from_str(include_str!("../../protocol/contracts.json")).unwrap();
    reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_millis(
            contract["callTimeoutMs"].as_u64().unwrap(),
        ))
        .tls_backend_preconfigured(tls(rustls::RootCertStore::empty()))
}
fn policy(maximum: usize) -> TransportPolicy {
    TransportPolicy {
        response_bytes: NonZeroUsize::new(maximum).unwrap(),
        retry_after_ms: NonZeroU64::new(1).unwrap(),
    }
}
fn client(maximum: usize) -> ControlClient {
    ControlClient::new(builder(), policy(maximum)).unwrap()
}
fn launch(id: JobId) -> WorkerStart {
    WorkerStart {
        version: 1,
        id,
        request: Request {
            version: 1,
            domain: Uuid::new_v4(),
            source: Source::Tool {
                goal_id: "goal".into(),
                conversation_id: 1,
                task_id: 2,
                call_id: "call".into(),
            },
            grant: GrantReference {
                id: Uuid::new_v4(),
                version: 1,
            },
            argv: vec!["command".into()],
            cwd: "/workspace".into(),
            env: BTreeMap::new(),
            inherit_env: false,
            timeout_ms: None,
            policy_revision: "fixture".into(),
        },
        settings: Settings {
            version: 1,
            revision: "fixture".into(),
            poll_after_ms: 1,
            recovery_interval_ms: 7,
            request_timeout_ms: 1000,
            frame_bytes: 64,
            output_page_bytes: 64,
            max_body_bytes: 4096,
        },
        callback: Callback {
            url: "http://callback.invalid/operation/worker".into(),
            credential: Credential::new("callback-fixture".into()).unwrap(),
        },
    }
}

#[tokio::test]
async fn worker_roundtrip() {
    let id = id();
    let worker = Uuid::new_v4();
    let absent = Reply::json(WorkerLookup::Absent { id, worker });
    let accepted = WorkerObservation {
        id,
        worker,
        state: WorkerState::Accepted,
    };
    let found = Reply::json(WorkerLookup::Found {
        observation: accepted.clone(),
    });
    let stopped = WorkerObservation {
        id,
        worker,
        state: WorkerState::Cancelled,
    };
    let maximum = found
        .body
        .len()
        .max(absent.body.len())
        .max(Reply::json(&stopped).body.len());
    let server = Server::new(absent).await;
    let endpoint = server.endpoint(worker);
    let client = client(maximum);
    assert!(client.observe(&endpoint, id).await.unwrap().is_none());
    server.reply(Reply::json(&accepted));
    let launch = launch(id);
    assert_eq!(client.start(&endpoint, &launch).await.unwrap(), accepted);
    server.reply(found);
    assert_eq!(client.observe(&endpoint, id).await.unwrap(), Some(accepted));
    server.reply(Reply::json(&stopped));
    assert_eq!(client.stop(&endpoint, id).await.unwrap(), stopped);
    {
        let calls = server.state.calls.lock().unwrap();
        assert_eq!(
            calls
                .iter()
                .map(|call| call.method.as_str())
                .collect::<Vec<_>>(),
            ["GET", "PUT", "GET", "DELETE"]
        );
        assert!(calls.iter().all(
            |call| call.path == format!("/{}/{}", id.scope, id.operation)
                && call.headers[header::AUTHORIZATION] == "Bearer transport-fixture"
                && call.headers[header::CACHE_CONTROL] == "no-cache, no-store"
        ));
        assert_eq!(
            serde_json::from_slice::<Value>(&calls[1].body).unwrap(),
            serde_json::to_value(launch).unwrap()
        );
    }
    server.close().await;
}

#[tokio::test]
async fn absent_requires_proof() {
    let id = id();
    let worker = Uuid::new_v4();
    let valid = Reply::json(WorkerLookup::Absent { id, worker });
    let server = Server::new(Reply {
        status: StatusCode::NOT_FOUND,
        ..valid.clone()
    })
    .await;
    let endpoint = server.endpoint(worker);
    let client = client(valid.body.len());
    assert!(matches!(
        client.observe(&endpoint, id).await,
        Err(Error::Unavailable { .. })
    ));
    server.reply(Reply {
        body: b"{invalid".to_vec(),
        ..valid.clone()
    });
    assert!(matches!(
        client.observe(&endpoint, id).await,
        Err(Error::Unavailable { .. })
    ));
    server.reply(Reply::json(WorkerLookup::Absent {
        id: JobId {
            operation: Uuid::new_v4(),
            ..id
        },
        worker,
    }));
    assert!(matches!(
        client.observe(&endpoint, id).await,
        Err(Error::Conflict)
    ));
    server.reply(Reply::json(WorkerLookup::Absent {
        id,
        worker: Uuid::new_v4(),
    }));
    assert!(matches!(
        client.observe(&endpoint, id).await,
        Err(Error::Conflict)
    ));
    assert_eq!(server.state.calls.lock().unwrap().len(), 4);
    server.close().await;
}

#[tokio::test]
async fn bounded_chunked_reply() {
    let id = id();
    let worker = Uuid::new_v4();
    let mut reply = Reply::json(WorkerLookup::Absent { id, worker });
    reply.chunked = true;
    let maximum = reply.body.len() - 1;
    let server = Server::new(reply).await;
    assert!(matches!(
        client(maximum).observe(&server.endpoint(worker), id).await,
        Err(Error::Unavailable { .. })
    ));
    assert_eq!(server.state.calls.lock().unwrap().len(), 1);
    server.close().await;
}

#[tokio::test]
async fn no_redirect() {
    let id = id();
    let worker = Uuid::new_v4();
    let reply = Reply {
        status: StatusCode::TEMPORARY_REDIRECT,
        body: b"redirect".to_vec(),
        location: Some("/other".into()),
        chunked: false,
    };
    let server = Server::new(reply).await;
    assert!(matches!(
        client(b"redirect".len())
            .start(&server.endpoint(worker), &launch(id))
            .await,
        Err(Error::Unavailable { .. })
    ));
    assert_eq!(server.state.calls.lock().unwrap().len(), 1);
    server.close().await;
}

#[tokio::test]
async fn no_implicit_retry() {
    let id = id();
    let worker = Uuid::new_v4();
    let reply = Reply {
        status: StatusCode::SERVICE_UNAVAILABLE,
        body: b"unknown".to_vec(),
        location: None,
        chunked: false,
    };
    let server = Server::new(reply).await;
    let retries = reqwest::retry::for_host("127.0.0.1")
        .no_budget()
        .max_retries_per_request(1)
        .classify_fn(|result| {
            if result.status() == Some(StatusCode::SERVICE_UNAVAILABLE) {
                result.retryable()
            } else {
                result.success()
            }
        });
    let client = ControlClient::new(builder().retry(retries), policy(b"unknown".len())).unwrap();
    assert!(matches!(
        client.start(&server.endpoint(worker), &launch(id)).await,
        Err(Error::Unavailable { .. })
    ));
    assert_eq!(server.state.calls.lock().unwrap().len(), 1);
    server.close().await;
}

#[tokio::test]
async fn callback_receipt() {
    let id = id();
    let worker = Uuid::new_v4();
    let mut snapshot = Snapshot {
        scope_id: id.scope,
        operation_id: id.operation,
        state: chopin_job_broker::State {
            version: 3,
            phase: Phase::Running,
            stop_requested: false,
            worker: Some(worker),
            process: Some(ProcessIdentity {
                domain: Uuid::new_v4(),
                boot: Uuid::new_v4(),
                init_pid: 42,
                start_ticks: 11,
                namespace_inode: 23,
            }),
            released: true,
            started: true,
            primary_exit: None,
            output_complete: false,
            last_sequence: 1,
        },
    };
    let reply = Reply::json(&snapshot);
    let maximum = reply.body.len();
    let server = Server::new(reply).await;
    let callback = Callback {
        url: format!("{}callback", server.address),
        credential: Credential::new("callback-fixture".into()).unwrap(),
    };
    let client = client(maximum);
    let event = WorkerEvent::Output {
        sequence: 2,
        stream: Stream::Stdout,
        data: "a2VwdA".into(),
    };
    assert!(matches!(
        client.event(&callback, id, worker, &event).await,
        Err(Error::Unavailable { .. })
    ));
    snapshot.state.last_sequence = 2;
    snapshot.state.version += 1;
    server.reply(Reply::json(&snapshot));
    assert_eq!(
        client.event(&callback, id, worker, &event).await.unwrap(),
        snapshot
    );
    snapshot.scope_id = Uuid::new_v4();
    server.reply(Reply::json(&snapshot));
    assert!(matches!(
        client.event(&callback, id, worker, &event).await,
        Err(Error::Conflict)
    ));
    assert!(
        server
            .state
            .calls
            .lock()
            .unwrap()
            .iter()
            .all(|call| call.headers[header::AUTHORIZATION] == "Bearer callback-fixture")
    );
    server.close().await;
}

#[tokio::test]
async fn tls_trust() {
    use rcgen::generate_simple_self_signed;
    use rustls::{
        ServerConfig,
        crypto::{CryptoProvider, ring},
        pki_types::PrivatePkcs8KeyDer,
    };
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio_rustls::TlsAcceptor;
    assert!(CryptoProvider::get_default().is_none());
    let generated = generate_simple_self_signed(vec!["127.0.0.1".into()]).unwrap();
    let certificate = generated.cert.der().clone();
    let server = ServerConfig::builder_with_provider(Arc::new(ring::default_provider()))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(
            vec![certificate.clone()],
            PrivatePkcs8KeyDer::from(generated.signing_key.serialize_der()).into(),
        )
        .unwrap();
    let acceptor = TlsAcceptor::from(Arc::new(server));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = WorkerEndpoint::new(
        &format!("https://{}/", listener.local_addr().unwrap()),
        Credential::new("transport-fixture".into()).unwrap(),
        Uuid::new_v4(),
    )
    .unwrap();
    let id = id();
    let worker = endpoint.worker();
    let payload = serde_json::to_vec(&WorkerLookup::Absent { id, worker }).unwrap();
    let maximum = payload.len();
    let task = tokio::spawn(async move {
        let (untrusted, _) = listener.accept().await.unwrap();
        assert!(acceptor.accept(untrusted).await.is_err());
        let (trusted, _) = listener.accept().await.unwrap();
        let socket = acceptor.accept(trusted).await.unwrap();
        let mut socket = BufReader::new(socket);
        let mut headers = String::new();
        loop {
            let mut line = String::new();
            assert_ne!(socket.read_line(&mut line).await.unwrap(), 0);
            if line == "\r\n" {
                break;
            }
            headers.push_str(&line);
        }
        assert!(headers.starts_with(&format!("GET /{}/{} HTTP/1.1\r\n", id.scope, id.operation)));
        assert!(
            headers
                .to_ascii_lowercase()
                .contains("authorization: bearer transport-fixture\r\n")
        );
        let head = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            payload.len()
        );
        socket.get_mut().write_all(head.as_bytes()).await.unwrap();
        socket.get_mut().write_all(&payload).await.unwrap();
        socket.get_mut().shutdown().await.unwrap();
    });
    assert!(matches!(
        client(maximum).observe(&endpoint, id).await,
        Err(Error::Unavailable { .. })
    ));
    let mut roots = rustls::RootCertStore::empty();
    roots.add(certificate).unwrap();
    let trusted = ControlClient::new(
        builder().tls_backend_preconfigured(tls(roots)),
        policy(maximum),
    )
    .unwrap();
    assert!(trusted.observe(&endpoint, id).await.unwrap().is_none());
    task.await.unwrap();
    assert!(CryptoProvider::get_default().is_none());
}
