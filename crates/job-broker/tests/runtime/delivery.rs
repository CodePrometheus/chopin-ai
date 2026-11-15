use super::*;
use axum::{
    Json, Router,
    body::Body,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
};
use chopin_job_broker::{
    Admission, Callback, Caller, ControlClient, Credential, GrantReference, Ledger, Phase, Request,
    SCHEMA_V1, Settings, Snapshot, Source, TransportPolicy, WorkerEvent,
};
use sqlx::{
    Executor, PgPool,
    postgres::{PgConnectOptions, PgPoolOptions},
};
use std::{
    num::NonZeroU64,
    str::FromStr,
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::{net::TcpListener, sync::oneshot, task::JoinHandle};

struct Service {
    pool: PgPool,
    ledger: Ledger,
    id: JobId,
    worker: Uuid,
    lose_ack: AtomicBool,
    frames: Mutex<Vec<u64>>,
}
impl Service {
    async fn snapshot(&self) -> Snapshot {
        let mut tx = self.pool.begin().await.unwrap();
        let record = self.ledger.read(&mut tx, self.id).await.unwrap().unwrap();
        tx.commit().await.unwrap();
        record.snapshot()
    }
}
async fn receive(
    State(service): State<Arc<Service>>,
    headers: HeaderMap,
    Json(event): Json<WorkerEvent>,
) -> Response {
    if headers.get("authorization").unwrap() != "Bearer output-fixture" {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let mut tx = service.pool.begin().await.unwrap();
    let mut record = service
        .ledger
        .read(&mut tx, service.id)
        .await
        .unwrap()
        .unwrap();
    service
        .ledger
        .event(&mut tx, &mut record, service.worker, &event)
        .await
        .unwrap();
    let snapshot = record.snapshot();
    tx.commit().await.unwrap();
    if let WorkerEvent::Output { sequence, .. } = event {
        service.frames.lock().unwrap().push(sequence);
        if service.lose_ack.swap(false, Ordering::SeqCst) {
            return Body::from_stream(futures_util::stream::iter([Err::<Vec<u8>, _>(
                std::io::Error::from(std::io::ErrorKind::ConnectionReset),
            )]))
            .into_response();
        }
    }
    Json(snapshot).into_response()
}
struct Server {
    service: Arc<Service>,
    callback: Callback,
    stop: Option<oneshot::Sender<()>>,
    task: Option<JoinHandle<()>>,
}
impl Server {
    async fn new(
        f: &Fixture,
        process: ProcessIdentity,
        command: &GateCommand,
        release: bool,
    ) -> Self {
        let url = std::env::var("CHOPIN_TEST_DATABASE_URL")
            .expect("an isolated transactional database is required");
        let schema = format!("capture_{}", Uuid::new_v4().simple());
        let bootstrap = PgPoolOptions::new().connect(&url).await.unwrap();
        bootstrap
            .execute(sqlx::AssertSqlSafe(format!("CREATE SCHEMA {schema}")))
            .await
            .unwrap();
        bootstrap.close().await;
        let pool = PgPoolOptions::new()
            .connect_with(
                PgConnectOptions::from_str(&url)
                    .unwrap()
                    .options([("search_path", schema.as_str())]),
            )
            .await
            .unwrap();
        sqlx::raw_sql(SCHEMA_V1).execute(&pool).await.unwrap();
        let service = Arc::new(Service {
            pool,
            ledger: Ledger::new(JobKey::new([47; 32])),
            id: f.capture.id,
            worker: f.capture.worker,
            lose_ack: AtomicBool::new(true),
            frames: Mutex::new(Vec::new()),
        });
        let caller = Caller {
            scope: f.capture.id.scope,
            domain: f.host.domain,
            runtime: Uuid::new_v4(),
            generation: 1,
            owner: "capture-fixture".into(),
        };
        let request = Request {
            version: 1,
            domain: f.host.domain,
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
            argv: command.argv.clone(),
            cwd: command.cwd.clone(),
            env: command.env.clone(),
            inherit_env: false,
            timeout_ms: None,
            policy_revision: "capture-fixture".into(),
        };
        let settings = Settings {
            version: 1,
            revision: "capture-fixture".into(),
            poll_after_ms: 1,
            recovery_interval_ms: 7,
            request_timeout_ms: deadline().as_millis().try_into().unwrap(),
            frame_bytes: f.capture.frame_bytes.get(),
            output_page_bytes: f.capture.frame_bytes.get(),
            max_body_bytes: 65536,
        };
        let mut tx = service.pool.begin().await.unwrap();
        let (mut record, _) = service
            .ledger
            .record(
                &mut tx,
                &caller,
                f.capture.id.operation,
                &request,
                Admission::Execute(&settings),
            )
            .await
            .unwrap();
        service
            .ledger
            .reserve(&mut tx, &mut record, service.worker)
            .await
            .unwrap();
        assert!(matches!(
            service
                .ledger
                .event(
                    &mut tx,
                    &mut record,
                    service.worker,
                    &WorkerEvent::Output {
                        sequence: 1,
                        stream: Stream::Stderr,
                        data: BASE64_URL_SAFE_NO_PAD.encode(b"unattached")
                    }
                )
                .await,
            Err(Error::Conflict)
        ));
        service
            .ledger
            .event(
                &mut tx,
                &mut record,
                service.worker,
                &WorkerEvent::Attached { process },
            )
            .await
            .unwrap();
        if release {
            service
                .ledger
                .event(&mut tx, &mut record, service.worker, &WorkerEvent::Release)
                .await
                .unwrap();
        }
        tx.commit().await.unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let callback = Callback {
            url: format!("http://{}/", listener.local_addr().unwrap()),
            credential: Credential::new("output-fixture".into()).unwrap(),
        };
        let (stop, stopped) = oneshot::channel();
        let router = Router::new()
            .route("/", post(receive))
            .with_state(service.clone());
        let task = tokio::spawn(async move {
            axum::serve(listener, router)
                .with_graceful_shutdown(async {
                    let _ = stopped.await;
                })
                .await
                .unwrap();
        });
        Self {
            service,
            callback,
            stop: Some(stop),
            task: Some(task),
        }
    }
    async fn close(mut self) {
        self.stop.take().unwrap().send(()).unwrap();
        self.task.take().unwrap().await.unwrap();
        self.service.pool.close().await;
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
#[tokio::test]
#[ignore = "requires a real isolated transactional database and native command isolation"]
async fn lost_output_ack() {
    let mut f = Fixture::new();
    let process = f.ready().await;
    let command = f.command(vec!["/usr/bin/python3".into(), "-c".into(), "import sys; sys.stdout.buffer.write(bytes(range(256))*41); sys.stderr.buffer.write(b'error channel')".into()]);
    let server = Server::new(&f, process, &command, true).await;
    f.namespace.release(&command).await.unwrap();
    assert!(f.ended().await.success());
    let expected = f.stdout().await;
    let client = client();
    assert!(
        f.namespace
            .output()
            .deliver(&client, &server.callback)
            .await
            .is_err()
    );
    let lost = server.service.snapshot().await;
    assert_eq!(lost.state.last_sequence, 1);
    assert!(!lost.state.output_complete);
    let reopened = OutputReader::open(f.namespace.directory(), &f.capture).unwrap();
    let delivered = reopened.deliver(&client, &server.callback).await.unwrap();
    assert!(delivered.state.output_complete);
    assert_eq!(
        delivered.state.last_sequence,
        reopened.complete().unwrap().unwrap()
    );
    assert_ne!(delivered.state.phase, Phase::Drained);
    assert_eq!(
        *server.service.frames.lock().unwrap(),
        (1..=delivered.state.last_sequence).collect::<Vec<_>>()
    );
    assert_eq!(
        reopened.deliver(&client, &server.callback).await.unwrap(),
        delivered
    );
    let mut cursor = None;
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    loop {
        let mut tx = server.service.pool.begin().await.unwrap();
        let record = server
            .service
            .ledger
            .read(&mut tx, f.capture.id)
            .await
            .unwrap()
            .unwrap();
        let page = server
            .service
            .ledger
            .output(&mut tx, &record, cursor.as_deref(), f.capture.frame_bytes)
            .await
            .unwrap();
        tx.commit().await.unwrap();
        let bytes = BASE64_URL_SAFE_NO_PAD.decode(page.data).unwrap();
        match page.stream {
            Some(Stream::Stdout) => stdout.extend(bytes),
            Some(Stream::Stderr) => stderr.extend(bytes),
            None => assert!(bytes.is_empty()),
        }
        if page.complete {
            break;
        }
        cursor = Some(page.cursor);
    }
    assert_eq!(stdout, expected);
    assert_eq!(stderr, b"error channel");
    server.close().await;
}

fn client() -> ControlClient {
    let tls = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .unwrap()
    .with_root_certificates(rustls::RootCertStore::empty())
    .with_no_client_auth();
    ControlClient::new(
        reqwest::Client::builder()
            .no_proxy()
            .timeout(deadline())
            .tls_backend_preconfigured(tls),
        TransportPolicy {
            response_bytes: NonZeroUsize::new(65536).unwrap(),
            retry_after_ms: NonZeroU64::new(1).unwrap(),
        },
    )
    .unwrap()
}

#[tokio::test]
#[ignore = "requires a real isolated transactional database and native command isolation"]
async fn refused_output() {
    let mut f = Fixture::new();
    let process = f.ready().await;
    let command = f.command(vec![
        "/bin/sh".into(),
        "-c".into(),
        "printf forbidden > executed".into(),
    ]);
    let server = Server::new(&f, process.clone(), &command, false).await;
    server.service.lose_ack.store(false, Ordering::SeqCst);
    f.namespace.refuse();
    let exit = f.ended().await;
    assert!(!exit.success());
    timeout(deadline(), f.process.as_ref().unwrap().wait())
        .await
        .unwrap()
        .unwrap();
    timeout(deadline(), f.namespace.wait_output())
        .await
        .unwrap()
        .unwrap();
    assert!(!f.base.join("workspace/executed").exists());
    let client = client();
    let delivered = f
        .namespace
        .output()
        .deliver(&client, &server.callback)
        .await
        .unwrap();
    assert!(delivered.state.output_complete);
    assert!(!delivered.state.released);
    assert!(!delivered.state.started);
    assert!(delivered.state.last_sequence > 0);
    for event in [
        WorkerEvent::Exited {
            exit: chopin_job_broker::ExitStatus::Code(exit.code().unwrap()),
        },
        WorkerEvent::Drained {
            process,
            sequence: delivered.state.last_sequence,
        },
    ] {
        client
            .event(&server.callback, f.capture.id, f.capture.worker, &event)
            .await
            .unwrap();
    }
    let stopped = server.service.snapshot().await;
    assert_eq!(stopped.state.phase, Phase::Drained);
    assert!(!stopped.state.released);
    assert!(!stopped.state.started);
    server.close().await;
}
