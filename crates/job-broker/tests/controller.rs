//! Production controller, transport and transactional broker against real isolated processes.
#![cfg(all(feature = "worker", feature = "transport", target_os = "linux"))]
#![allow(clippy::unwrap_used, clippy::expect_used)]

use axum::{
    Router,
    body::{Body, to_bytes},
    extract::{Request as HttpRequest, State},
    middleware::{self, Next},
    response::{IntoResponse, Response},
};
use base64::{Engine as _, prelude::BASE64_URL_SAFE_NO_PAD};
use chopin_job_broker::{runtime::*, *};
use serde::{Deserialize, Serialize};
use sqlx::{
    Executor, PgPool, Postgres, Transaction,
    postgres::{PgConnectOptions, PgPoolOptions},
};
use std::{
    collections::{BTreeMap, HashMap},
    fs::{self, File, OpenOptions},
    io::Write,
    num::{NonZeroU64, NonZeroUsize},
    os::fd::OwnedFd,
    path::PathBuf,
    process::Stdio,
    str::FromStr,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{
    net::TcpListener,
    process::Child,
    sync::{Notify, oneshot},
    task::JoinHandle,
    time::{sleep, timeout},
};
use uuid::Uuid;

fn deadline() -> Duration {
    let contract: serde_json::Value =
        serde_json::from_str(include_str!("../../protocol/contracts.json")).unwrap();
    Duration::from_millis(contract["callTimeoutMs"].as_u64().unwrap())
}
fn settings() -> Settings {
    Settings {
        version: 1,
        revision: "controller-fixture".into(),
        poll_after_ms: 1,
        recovery_interval_ms: 7,
        request_timeout_ms: deadline().as_millis().try_into().unwrap(),
        frame_bytes: 4096,
        output_page_bytes: 4096,
        max_body_bytes: 65536,
    }
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
            response_bytes: NonZeroUsize::new(settings().max_body_bytes).unwrap(),
            retry_after_ms: NonZeroU64::new(1).unwrap(),
        },
    )
    .unwrap()
}
struct Authority {
    caller: Caller,
    revoked: AtomicBool,
    tokens: Mutex<HashMap<String, WorkerCaller>>,
}
#[async_trait::async_trait]
impl HostAuthority for Authority {
    async fn authenticate(&self, credential: &str) -> Result<Caller> {
        if credential != "engine-fixture" {
            return Err(Error::Unauthorized);
        }
        Ok(self.caller.clone())
    }
    async fn authenticate_worker(&self, credential: &str) -> Result<WorkerCaller> {
        self.tokens
            .lock()
            .unwrap()
            .get(credential)
            .cloned()
            .ok_or(Error::Unauthorized)
    }
    async fn authorize_scope(
        &self,
        _: &mut Transaction<'_, Postgres>,
        caller: &Caller,
    ) -> Result<()> {
        if caller != &self.caller {
            return Err(Error::Forbidden);
        }
        Ok(())
    }
    async fn authorize(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        caller: &Caller,
        request: &Request,
        action: Action,
    ) -> Result<()> {
        self.authorize_scope(tx, caller).await?;
        if request.domain != caller.domain
            || action == Action::Submit && self.revoked.load(Ordering::SeqCst)
        {
            return Err(Error::Forbidden);
        }
        Ok(())
    }
    async fn authorize_worker(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        caller: &WorkerCaller,
        request: &Request,
        action: WorkerAction,
    ) -> Result<()> {
        self.authorize_scope(tx, &caller.caller).await?;
        if request.domain != caller.caller.domain
            || action == WorkerAction::Release && self.revoked.load(Ordering::SeqCst)
        {
            return Err(Error::Forbidden);
        }
        Ok(())
    }
    fn worker_credential(&self, caller: &Caller, id: JobId, worker: Uuid) -> Result<Credential> {
        let token = Uuid::new_v4().to_string();
        self.tokens.lock().unwrap().insert(
            token.clone(),
            WorkerCaller {
                caller: caller.clone(),
                operation: id.operation,
                worker,
            },
        );
        Credential::new(token)
    }
}
struct Directory {
    endpoint: Mutex<Option<WorkerEndpoint>>,
    domain: Uuid,
}
#[async_trait::async_trait]
impl WorkerDirectory for Directory {
    async fn locate(
        &self,
        caller: &Caller,
        request: &Request,
        expected: Option<Uuid>,
    ) -> Result<WorkerEndpoint> {
        let endpoint = self
            .endpoint
            .lock()
            .unwrap()
            .clone()
            .ok_or(Error::Unavailable { retry_after_ms: 1 })?;
        if caller.domain != self.domain
            || request.domain != self.domain
            || expected.is_some_and(|id| id != endpoint.worker())
        {
            return Err(Error::Conflict);
        }
        Ok(endpoint)
    }
}
struct Faults {
    lose_output: AtomicBool,
    pause: Mutex<Option<OwnedFd>>,
    committed: Notify,
    processes: Mutex<Vec<ProcessIdentity>>,
    revoke_on_attach: AtomicBool,
    authority: Arc<Authority>,
    hold_started: AtomicBool,
    started: Notify,
    release_started: Notify,
}
async fn intercept(
    State(faults): State<Arc<Faults>>,
    request: HttpRequest,
    next: Next,
) -> Response {
    let (parts, body) = request.into_parts();
    let bytes = to_bytes(body, settings().max_body_bytes).await.unwrap();
    let event = serde_json::from_slice::<WorkerEvent>(&bytes).ok();
    let response = next
        .run(HttpRequest::from_parts(parts, Body::from(bytes)))
        .await;
    if response.status().is_success() {
        if matches!(event, Some(WorkerEvent::Started))
            && faults.hold_started.swap(false, Ordering::SeqCst)
        {
            faults.started.notify_one();
            faults.release_started.notified().await;
        }
        if let Some(WorkerEvent::Attached { process }) = &event {
            let mut processes = faults.processes.lock().unwrap();
            if !processes.contains(process) {
                processes.push(process.clone());
            }
            if faults.revoke_on_attach.swap(false, Ordering::SeqCst) {
                faults.authority.revoked.store(true, Ordering::SeqCst);
            }
        }
        if matches!(event, Some(WorkerEvent::Output { .. }))
            && faults.lose_output.swap(false, Ordering::SeqCst)
        {
            if let Some(handle) = faults.pause.lock().unwrap().as_ref() {
                rustix::process::pidfd_send_signal(handle, rustix::process::Signal::STOP).unwrap();
            }
            faults.committed.notify_one();
            return Body::from_stream(futures_util::stream::iter([Err::<Vec<u8>, _>(
                std::io::Error::from(std::io::ErrorKind::ConnectionReset),
            )]))
            .into_response();
        }
    }
    response
}
struct Server {
    stop: Option<oneshot::Sender<()>>,
    task: Option<JoinHandle<()>>,
}
impl Server {
    fn start(listener: TcpListener, router: Router) -> Self {
        let (stop, stopped) = oneshot::channel();
        let task = tokio::spawn(async move {
            axum::serve(listener, router)
                .with_graceful_shutdown(async {
                    let _ = stopped.await;
                })
                .await
                .unwrap();
        });
        Self {
            stop: Some(stop),
            task: Some(task),
        }
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

#[derive(Clone, Serialize, Deserialize)]
struct ChildConfig {
    root: PathBuf,
    worker: Uuid,
    host: HostIdentity,
    scope: Uuid,
    create: bool,
    ready: PathBuf,
    profile: NamespaceConfig,
}
struct Policy {
    config: ChildConfig,
}
#[async_trait::async_trait]
impl WorkerPolicy for Policy {
    async fn profile(&self, start: &WorkerStart) -> Result<NamespaceConfig> {
        if start.id.scope != self.config.scope || start.request.domain != self.config.host.domain {
            return Err(Error::Forbidden);
        }
        let mut calls = OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.config.root.join("policy-calls"))?;
        writeln!(calls, "{}", start.id.operation)?;
        calls.sync_all()?;
        Ok(self.config.profile.clone())
    }
}
#[tokio::test]
#[ignore = "subprocess entry used by controller integration checks"]
async fn service_child() {
    let path = std::env::var_os("CHOPIN_CONTROLLER_FIXTURE").expect("controller fixture required");
    let config: ChildConfig = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    let key = Arc::new(JobKey::new([61; 32]));
    let journal = if config.create {
        WorkerJournal::create(
            &config.profile.private_root,
            config.worker,
            config.host.clone(),
            key,
        )
        .await
    } else {
        WorkerJournal::open(
            &config.profile.private_root,
            config.worker,
            config.host.clone(),
            key,
        )
        .await
    }
    .unwrap();
    let worker = Arc::new(LocalWorker::new(
        journal,
        Arc::new(Policy {
            config: config.clone(),
        }),
        client(),
        Arc::new(JobKey::new([62; 32])),
    ));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!("http://{}/", listener.local_addr().unwrap());
    let router = worker.clone().router(
        Credential::new("worker-fixture".into()).unwrap(),
        NonZeroUsize::new(settings().max_body_bytes).unwrap(),
    );
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    fs::write(&config.ready, address).unwrap();
    File::open(&config.ready).unwrap().sync_all().unwrap();
    let recovery = async {
        loop {
            let mut after = None;
            loop {
                let page = worker
                    .recover(after, NonZeroUsize::new(2).unwrap())
                    .await
                    .unwrap();
                for result in page.results {
                    if let Err(error) = result.result {
                        let mut log = OpenOptions::new()
                            .create(true)
                            .append(true)
                            .open(config.root.join("recovery.log"))
                            .unwrap();
                        writeln!(log, "{:?}: {error:?}", result.id).unwrap();
                    }
                }
                let Some(next) = page.next else {
                    break;
                };
                after = Some(next);
            }
            tokio::select! { _=sleep(Duration::from_millis(settings().recovery_interval_ms))=>{}, _=worker.changed()=>{} }
        }
    };
    tokio::select! { result=server=>{result.unwrap();panic!("worker server stopped");}, _=recovery=>panic!("worker recovery stopped") }
}

struct Fixture {
    config: ChildConfig,
    caller: Caller,
    pool: PgPool,
    broker: Arc<Broker>,
    directory: Arc<Directory>,
    authority: Arc<Authority>,
    faults: Arc<Faults>,
    server: Option<Server>,
    child: Option<Child>,
    callback: String,
}
impl Fixture {
    async fn new() -> Self {
        assert_ne!(rustix::process::geteuid().as_raw(), 0);
        let root = PathBuf::from("/tmp").join(format!("controller-{}", Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        fs::create_dir(root.join("private")).unwrap();
        fs::create_dir(root.join("workspace")).unwrap();
        println!("controller evidence: {}", root.display());
        let domain = Uuid::new_v4();
        let scope = Uuid::new_v4();
        let worker = Uuid::new_v4();
        let config = ChildConfig {
            root: root.clone(),
            worker,
            host: HostIdentity::current(domain).unwrap(),
            scope,
            create: true,
            ready: root.join("unused"),
            profile: NamespaceConfig {
                launcher: "/usr/local/bin/bwrap".into(),
                gate: env!("CARGO_BIN_EXE_chopin-job-gate").into(),
                capture: env!("CARGO_BIN_EXE_chopin-job-capture").into(),
                private_root: root.join("private"),
                workspace: root.join("workspace"),
                read_only: ["/usr", "/bin", "/lib", "/lib64"]
                    .into_iter()
                    .map(PathBuf::from)
                    .filter(|p| p.exists())
                    .collect(),
                environment: BTreeMap::from([
                    ("PROFILE_VALUE".into(), "original".into()),
                    ("profile.value".into(), "os-compatible".into()),
                ]),
            },
        };
        let caller = Caller {
            scope,
            domain,
            runtime: domain,
            generation: 1,
            owner: "controller-fixture".into(),
        };
        let authority = Arc::new(Authority {
            caller: caller.clone(),
            revoked: AtomicBool::new(false),
            tokens: Mutex::new(HashMap::new()),
        });
        let directory = Arc::new(Directory {
            endpoint: Mutex::new(None),
            domain,
        });
        let url = std::env::var("CHOPIN_TEST_DATABASE_URL").expect("isolated database required");
        let schema = format!("controller_{}", Uuid::new_v4().simple());
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
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let callback = format!("http://{}/", listener.local_addr().unwrap());
        let broker = Arc::new(
            Broker::new(
                pool.clone(),
                Ledger::new(JobKey::new([63; 32])),
                authority.clone(),
                Arc::new(HttpWorkerTransport::new(directory.clone(), client())),
                settings(),
                &callback,
            )
            .unwrap(),
        );
        let faults = Arc::new(Faults {
            lose_output: AtomicBool::new(false),
            pause: Mutex::new(None),
            committed: Notify::new(),
            processes: Mutex::new(Vec::new()),
            revoke_on_attach: AtomicBool::new(false),
            authority: authority.clone(),
            hold_started: AtomicBool::new(false),
            started: Notify::new(),
            release_started: Notify::new(),
        });
        let router = broker
            .clone()
            .router()
            .layer(middleware::from_fn_with_state(faults.clone(), intercept));
        let server = Server::start(listener, router);
        let mut result = Self {
            config,
            caller,
            pool,
            broker,
            directory,
            authority,
            faults,
            server: Some(server),
            child: None,
            callback,
        };
        result.start().await;
        result
    }
    async fn start(&mut self) {
        let mut config = self.config.clone();
        let instance = Uuid::new_v4();
        config.ready = config.root.join(format!("ready-{instance}"));
        let path = config.root.join(format!("fixture-{instance}.json"));
        fs::write(&path, serde_json::to_vec(&config).unwrap()).unwrap();
        let mut child = tokio::process::Command::new(std::env::current_exe().unwrap())
            .args(["--ignored", "--exact", "service_child", "--nocapture"])
            .env("CHOPIN_CONTROLLER_FIXTURE", path)
            .stdout(Stdio::null())
            .stderr(File::create(config.root.join(format!("service-{instance}.log"))).unwrap())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        self.event(&format!("spawn {}", child.id().unwrap()));
        let pid = rustix::process::Pid::from_raw(child.id().unwrap().try_into().unwrap()).unwrap();
        *self.faults.pause.lock().unwrap() =
            Some(rustix::process::pidfd_open(pid, rustix::process::PidfdFlags::empty()).unwrap());
        let address = timeout(deadline(), async {
            loop {
                if config.ready.exists() {
                    let address = fs::read_to_string(&config.ready).unwrap();
                    if !address.is_empty() {
                        break address;
                    }
                }
                assert!(
                    child.try_wait().unwrap().is_none(),
                    "worker failed to start"
                );
                sleep(Duration::from_millis(1)).await;
            }
        })
        .await
        .unwrap();
        let endpoint = WorkerEndpoint::new(
            &address,
            Credential::new("worker-fixture".into()).unwrap(),
            config.worker,
        )
        .unwrap();
        assert!(
            client()
                .observe(
                    &endpoint,
                    JobId {
                        scope: config.scope,
                        operation: Uuid::new_v4()
                    }
                )
                .await
                .unwrap()
                .is_none()
        );
        *self.directory.endpoint.lock().unwrap() = Some(endpoint);
        self.config.create = false;
        self.child = Some(child);
    }
    async fn kill(&mut self) {
        let mut child = self.child.take().unwrap();
        self.event(&format!("kill {}", child.id().unwrap()));
        child.start_kill().unwrap();
        assert!(
            !timeout(deadline(), child.wait())
                .await
                .unwrap()
                .unwrap()
                .success()
        );
        self.faults.pause.lock().unwrap().take();
    }
    fn event(&self, event: &str) {
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.config.root.join("events.log"))
            .unwrap();
        writeln!(file, "{event}").unwrap();
        file.sync_all().unwrap();
    }
    fn request(&self, script: &str) -> Request {
        Request {
            version: 1,
            domain: self.caller.domain,
            source: Source::Tool {
                goal_id: "goal".into(),
                conversation_id: 1,
                task_id: 2,
                call_id: "call".into(),
            },
            grant: GrantReference {
                id: self.caller.scope,
                version: 1,
            },
            argv: vec!["/usr/bin/python3".into(), "-c".into(), script.into()],
            cwd: "/workspace".into(),
            env: BTreeMap::from([("EXPLICIT_VALUE".into(), "approved".into())]),
            inherit_env: true,
            timeout_ms: None,
            policy_revision: "controller-fixture".into(),
        }
    }
    async fn done(&mut self, id: Uuid) -> Snapshot {
        timeout(deadline(), async {
            loop {
                assert!(
                    self.child.as_mut().unwrap().try_wait().unwrap().is_none(),
                    "worker exited"
                );
                let snapshot = self.broker.get(&self.caller, id).await.unwrap();
                if snapshot.state.phase == Phase::Drained {
                    break snapshot;
                }
                sleep(Duration::from_millis(settings().recovery_interval_ms)).await;
            }
        })
        .await
        .unwrap()
    }
    async fn output(&self, id: Uuid) -> (Vec<u8>, Vec<u8>) {
        let mut cursor = None;
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        loop {
            let page = self
                .broker
                .output(
                    &self.caller,
                    id,
                    cursor.as_deref(),
                    NonZeroUsize::new(settings().output_page_bytes).unwrap(),
                )
                .await
                .unwrap();
            let data = BASE64_URL_SAFE_NO_PAD.decode(page.data).unwrap();
            match page.stream {
                Some(Stream::Stdout) => stdout.extend(data),
                Some(Stream::Stderr) => stderr.extend(data),
                None => assert!(data.is_empty()),
            }
            if page.complete {
                break;
            }
            cursor = Some(page.cursor);
        }
        (stdout, stderr)
    }
    async fn close(mut self) {
        self.kill().await;
        self.server.take().unwrap().close().await;
        self.pool.close().await;
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        for process in self.faults.processes.lock().unwrap().iter() {
            if let Ok(ProcessObservation::Alive(handle)) =
                NamespaceProcess::open(&self.config.host, process)
            {
                let _ = handle.terminate();
            }
        }
        if let Some(child) = &mut self.child {
            let _ = child.start_kill();
        }
    }
}

#[tokio::test]
#[ignore = "requires real native isolation and an isolated transactional database"]
async fn command_roundtrip() {
    let mut f = Fixture::new().await;
    let id = Uuid::new_v4();
    let script = r#"import errno,os,pathlib,sys
assert 'CHOPIN_CONTROLLER_FIXTURE' not in os.environ
assert 'CHOPIN_TEST_DATABASE_URL' not in os.environ
assert os.environ['profile.value']=='os-compatible'
for entry in os.listdir('/proc/self/fd'):
 fd=int(entry)
 try: os.fstat(fd)
 except OSError as error:
  assert error.errno==errno.EBADF
  continue
 assert fd<=2
pathlib.Path('/workspace/effect').write_text('once')
sys.stdout.buffer.write(bytes(range(256))*41)
sys.stderr.write(os.environ['PROFILE_VALUE']+':'+os.environ['EXPLICIT_VALUE'])
"#;
    let request = f.request(script);
    f.broker.submit(&f.caller, id, &request).await.unwrap();
    f.broker.submit(&f.caller, id, &request).await.unwrap();
    let done = f.done(id).await;
    assert!(done.state.started && done.state.output_complete);
    assert_eq!(done.state.primary_exit, Some(ExitStatus::Code(0)));
    let (stdout, stderr) = f.output(id).await;
    assert_eq!(stdout, (0..41).flat_map(|_| 0_u8..=255).collect::<Vec<_>>());
    assert_eq!(stderr, b"original:approved");
    assert_eq!(
        fs::read_to_string(f.config.root.join("policy-calls"))
            .unwrap()
            .lines()
            .count(),
        1
    );
    assert_eq!(
        fs::read(f.config.root.join("workspace/effect")).unwrap(),
        b"once"
    );
    f.close().await;
}

#[tokio::test]
#[ignore = "requires real native isolation and an isolated transactional database"]
async fn cancel_tombstone() {
    let mut f = Fixture::new().await;
    let id = Uuid::new_v4();
    let endpoint = f.directory.endpoint.lock().unwrap().clone().unwrap();
    assert_eq!(
        client()
            .stop(
                &endpoint,
                JobId {
                    scope: f.caller.scope,
                    operation: id
                }
            )
            .await
            .unwrap()
            .state,
        WorkerState::Cancelled
    );
    f.broker
        .submit(
            &f.caller,
            id,
            &f.request("open('/workspace/forbidden','w').write('executed')"),
        )
        .await
        .unwrap();
    let done = f.done(id).await;
    assert!(!done.state.started && !done.state.released);
    assert!(!f.config.root.join("policy-calls").exists());
    assert!(!f.config.root.join("workspace/forbidden").exists());
    f.close().await;
}

#[tokio::test]
#[ignore = "requires real native isolation and an isolated transactional database"]
async fn revoked_release() {
    let mut f = Fixture::new().await;
    let id = Uuid::new_v4();
    f.faults.revoke_on_attach.store(true, Ordering::SeqCst);
    f.broker
        .submit(
            &f.caller,
            id,
            &f.request("open('/workspace/forbidden','w').write('executed')"),
        )
        .await
        .unwrap();
    let done = f.done(id).await;
    assert!(f.authority.revoked.load(Ordering::SeqCst));
    assert!(!done.state.released && !done.state.started);
    assert!(done.state.process.is_some() && done.state.output_complete);
    assert!(!f.config.root.join("workspace/forbidden").exists());
    f.close().await;
}

#[tokio::test]
#[ignore = "requires real native isolation and an isolated transactional database"]
async fn crash_resume() {
    let mut f = Fixture::new().await;
    let id = Uuid::new_v4();
    nix::unistd::mkfifo(
        &f.config.root.join("workspace/input"),
        nix::sys::stat::Mode::S_IRUSR | nix::sys::stat::Mode::S_IWUSR,
    )
    .unwrap();
    f.faults.lose_output.store(true, Ordering::SeqCst);
    let request=f.request("import os,pathlib,sys; pathlib.Path('/workspace/effect').write_text('once'); sys.stdout.write('before\\n'); sys.stdout.flush(); data=open('/workspace/input','rb').read(); sys.stdout.buffer.write(data); sys.stdout.flush(); sys.stderr.write(os.environ['PROFILE_VALUE'])");
    f.broker.submit(&f.caller, id, &request).await.unwrap();
    timeout(deadline(), f.faults.committed.notified())
        .await
        .unwrap();
    let before = f.broker.get(&f.caller, id).await.unwrap();
    assert_eq!(before.state.last_sequence, 1);
    assert!(!before.state.output_complete);
    let original = before.state.process.unwrap();
    f.kill().await;
    assert!(matches!(
        NamespaceProcess::open(&f.config.host, &original).unwrap(),
        ProcessObservation::Alive(_)
    ));
    f.config
        .profile
        .environment
        .insert("PROFILE_VALUE".into(), "updated".into());
    f.start().await;
    let endpoint = f.directory.endpoint.lock().unwrap().clone().unwrap();
    let observation = client()
        .observe(
            &endpoint,
            JobId {
                scope: f.caller.scope,
                operation: id,
            },
        )
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(observation.state,WorkerState::Running {process} if process==original));
    let mut input = OpenOptions::new()
        .write(true)
        .open(f.config.root.join("workspace/input"))
        .unwrap();
    input.write_all(b"after restart").unwrap();
    drop(input);
    let done = f.done(id).await;
    assert_eq!(done.state.process, Some(original));
    assert_eq!(
        f.output(id).await,
        (b"before\nafter restart".to_vec(), b"original".to_vec())
    );
    assert_eq!(
        fs::read_to_string(f.config.root.join("policy-calls"))
            .unwrap()
            .lines()
            .count(),
        1
    );
    f.close().await;
}

#[tokio::test]
#[ignore = "requires real native isolation and an isolated transactional database"]
async fn blocked_callback() {
    let mut f = Fixture::new().await;
    let id = Uuid::new_v4();
    f.faults.hold_started.store(true, Ordering::SeqCst);
    let mut request = f.request(
        "import pathlib,signal; pathlib.Path('/workspace/started').touch(); signal.pause()",
    );
    request.timeout_ms = Some(1000);
    f.broker.submit(&f.caller, id, &request).await.unwrap();
    timeout(deadline(), f.faults.started.notified())
        .await
        .unwrap();
    timeout(deadline(), async {
        while !f.config.root.join("workspace/started").exists() {
            sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap();
    let process = f
        .broker
        .get(&f.caller, id)
        .await
        .unwrap()
        .state
        .process
        .unwrap();
    match NamespaceProcess::open(&f.config.host, &process).unwrap() {
        ProcessObservation::Alive(handle) => {
            let observation = Duration::from_millis(request.timeout_ms.unwrap() * 2);
            timeout(observation, handle.wait()).await.unwrap().unwrap();
        }
        ProcessObservation::Exited => {}
    }
    f.faults.release_started.notify_one();
    let done = f.done(id).await;
    assert!(done.state.started && done.state.output_complete);
    assert!(
        done.state.primary_exit.is_some() && done.state.primary_exit != Some(ExitStatus::Code(0))
    );
    f.close().await;
}

#[tokio::test]
#[ignore = "requires real native isolation and an isolated transactional database"]
async fn worker_auth() {
    let f = Fixture::new().await;
    let id = JobId {
        scope: f.caller.scope,
        operation: Uuid::new_v4(),
    };
    let endpoint = f.directory.endpoint.lock().unwrap().clone().unwrap();
    let wrong = WorkerEndpoint::new(
        endpoint.url().as_str(),
        Credential::new("engine-fixture".into()).unwrap(),
        endpoint.worker(),
    )
    .unwrap();
    let start = WorkerStart {
        version: 1,
        id,
        request: f.request("print('forbidden')"),
        settings: settings(),
        callback: Callback {
            url: format!("{}{}/worker", f.callback, id.operation),
            credential: Credential::new("callback-fixture".into()).unwrap(),
        },
    };
    assert!(client().start(&wrong, &start).await.is_err());
    assert!(client().stop(&wrong, id).await.is_err());
    assert!(client().observe(&endpoint, id).await.unwrap().is_none());
    assert!(!f.config.root.join("policy-calls").exists());
    f.close().await;
}

#[tokio::test]
#[ignore = "requires real native isolation and an isolated transactional database"]
async fn failed_launch() {
    let mut f = Fixture::new().await;
    f.kill().await;
    f.config.profile.launcher = "/usr/bin/false".into();
    f.start().await;
    let id = Uuid::new_v4();
    f.broker
        .submit(
            &f.caller,
            id,
            &f.request("open('/workspace/forbidden','w').write('executed')"),
        )
        .await
        .unwrap();
    let done = f.done(id).await;
    assert!(!done.state.released && !done.state.started);
    assert!(done.state.process.is_none());
    assert!(!f.config.root.join("workspace/forbidden").exists());
    f.close().await;
}
