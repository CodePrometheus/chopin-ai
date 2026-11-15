//! Real transaction and router paths; the worker fixture exposes controlled remote outcomes.
#![allow(clippy::unwrap_used, clippy::expect_used)]
#![cfg(feature = "transport")]

use async_trait::async_trait;
use axum::{
    body::{Body, to_bytes},
    http::{Request as HttpRequest, StatusCode, header},
};
use base64::{Engine as _, prelude::BASE64_URL_SAFE_NO_PAD};
use chopin_job_broker::*;
use sqlx::{
    Executor, PgPool, Postgres, Transaction,
    postgres::{PgConnectOptions, PgPoolOptions},
};
use std::{
    collections::{BTreeMap, HashMap},
    str::FromStr,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};
use tower::ServiceExt;
use uuid::Uuid;

struct Authority {
    caller: Caller,
    deny: AtomicBool,
    tokens: Mutex<HashMap<String, WorkerCaller>>,
}
#[async_trait]
impl HostAuthority for Authority {
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
    async fn authenticate(&self, credential: &str) -> Result<Caller> {
        if credential == "engine" {
            Ok(self.caller.clone())
        } else {
            Err(Error::Unauthorized)
        }
    }
    async fn authenticate_worker(&self, credential: &str) -> Result<WorkerCaller> {
        self.tokens
            .lock()
            .unwrap()
            .get(credential)
            .cloned()
            .ok_or(Error::Unauthorized)
    }
    async fn authorize(
        &self,
        _: &mut Transaction<'_, Postgres>,
        caller: &Caller,
        request: &Request,
        action: Action,
    ) -> Result<()> {
        if caller != &self.caller
            || request.domain != caller.domain
            || (action == Action::Submit && self.deny.load(Ordering::SeqCst))
        {
            return Err(Error::Forbidden);
        }
        Ok(())
    }
    async fn authorize_worker(
        &self,
        _: &mut Transaction<'_, Postgres>,
        caller: &WorkerCaller,
        request: &Request,
        action: WorkerAction,
    ) -> Result<()> {
        if caller.caller != self.caller
            || request.domain != caller.caller.domain
            || (action == WorkerAction::Release && self.deny.load(Ordering::SeqCst))
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
struct Work {
    launch: Option<WorkerStart>,
    state: WorkerState,
}
struct Worker {
    id: Uuid,
    operations: Mutex<HashMap<(Uuid, Uuid), Work>>,
    starts: AtomicUsize,
    lose_reply: AtomicBool,
    fail_observe: AtomicBool,
    wrong_identity: Mutex<Option<JobId>>,
}
impl Worker {
    fn observation(&self, id: JobId, state: WorkerState) -> WorkerObservation {
        WorkerObservation {
            id: self.wrong_identity.lock().unwrap().unwrap_or(id),
            worker: self.id,
            state,
        }
    }
}
#[async_trait]
impl WorkerTransport for Worker {
    async fn locate(
        &self,
        _: &Caller,
        _: &Request,
        expected: Option<Uuid>,
    ) -> Result<WorkerEndpoint> {
        if expected.is_some_and(|expected| expected != self.id) {
            return Err(Error::Conflict);
        }
        WorkerEndpoint::new(
            "http://worker.invalid/",
            Credential::new("transport".into())?,
            self.id,
        )
    }
    async fn start(&self, _: &WorkerEndpoint, launch: &WorkerStart) -> Result<WorkerObservation> {
        self.starts.fetch_add(1, Ordering::SeqCst);
        let state = {
            let mut operations = self.operations.lock().unwrap();
            let work = operations
                .entry((launch.id.scope, launch.id.operation))
                .or_insert_with(|| Work {
                    launch: Some(launch.clone()),
                    state: WorkerState::Accepted,
                });
            if let Some(original) = &work.launch
                && (original.request != launch.request || original.settings != launch.settings)
            {
                return Err(Error::Conflict);
            }
            work.state.clone()
        };
        if self.lose_reply.swap(false, Ordering::SeqCst) {
            return Err(Error::Unavailable { retry_after_ms: 1 });
        }
        Ok(self.observation(launch.id, state))
    }
    async fn observe(&self, _: &WorkerEndpoint, id: JobId) -> Result<Option<WorkerObservation>> {
        if self.fail_observe.load(Ordering::SeqCst) {
            return Err(Error::Unavailable { retry_after_ms: 1 });
        }
        Ok(self
            .operations
            .lock()
            .unwrap()
            .get(&(id.scope, id.operation))
            .map(|work| self.observation(id, work.state.clone())))
    }
    async fn stop(&self, _: &WorkerEndpoint, id: JobId) -> Result<WorkerObservation> {
        let state = {
            let mut operations = self.operations.lock().unwrap();
            let work = operations
                .entry((id.scope, id.operation))
                .or_insert_with(|| Work {
                    launch: None,
                    state: WorkerState::Cancelled,
                });
            if matches!(work.state, WorkerState::Accepted) {
                work.state = WorkerState::Cancelled;
            }
            work.state.clone()
        };
        Ok(self.observation(id, state))
    }
}
struct Fixture {
    pool: PgPool,
    authority: Arc<Authority>,
    worker: Arc<Worker>,
    settings: Settings,
    request: Request,
    broker: Arc<Broker>,
}
impl Fixture {
    async fn new() -> Self {
        let url = std::env::var("CHOPIN_TEST_DATABASE_URL")
            .expect("isolated transactional database required");
        let schema = format!("broker_{}", Uuid::new_v4().simple());
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
        let domain = Uuid::new_v4();
        let caller = Caller {
            scope: Uuid::new_v4(),
            domain,
            runtime: domain,
            generation: 1,
            owner: "fixture".into(),
        };
        let authority = Arc::new(Authority {
            caller,
            deny: AtomicBool::new(false),
            tokens: Mutex::new(HashMap::new()),
        });
        let worker = Arc::new(Worker {
            id: Uuid::new_v4(),
            operations: Mutex::new(HashMap::new()),
            starts: AtomicUsize::new(0),
            lose_reply: AtomicBool::new(false),
            fail_observe: AtomicBool::new(false),
            wrong_identity: Mutex::new(None),
        });
        let settings = Settings {
            version: 1,
            revision: "fixture".into(),
            poll_after_ms: 1,
            recovery_interval_ms: 7,
            request_timeout_ms: 1000,
            frame_bytes: 64,
            output_page_bytes: 64,
            max_body_bytes: 4096,
        };
        let request = Request {
            version: 1,
            domain,
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
        };
        let broker = Arc::new(
            Broker::new(
                pool.clone(),
                Ledger::new(JobKey::new([31; 32])),
                authority.clone(),
                worker.clone(),
                settings.clone(),
                "http://broker.invalid/jobs/",
            )
            .unwrap(),
        );
        Self {
            pool,
            authority,
            worker,
            settings,
            request,
            broker,
        }
    }
    fn caller(&self) -> &Caller {
        &self.authority.caller
    }
    fn id(&self, operation: Uuid) -> JobId {
        JobId {
            scope: self.caller().scope,
            operation,
        }
    }
    fn rebuilt(&self, settings: Settings) -> Arc<Broker> {
        Arc::new(
            Broker::new(
                self.pool.clone(),
                Ledger::new(JobKey::new([31; 32])),
                self.authority.clone(),
                self.worker.clone(),
                settings,
                "http://broker.invalid/jobs/",
            )
            .unwrap(),
        )
    }
    async fn callback(&self, operation: Uuid) -> (String, WorkerCaller) {
        let token = self.worker.operations.lock().unwrap()[&(self.caller().scope, operation)]
            .launch
            .as_ref()
            .unwrap()
            .callback
            .credential
            .expose()
            .to_owned();
        let caller = self.authority.authenticate_worker(&token).await.unwrap();
        (token, caller)
    }
    fn process(&self) -> ProcessIdentity {
        ProcessIdentity {
            domain: self.request.domain,
            boot: Uuid::new_v4(),
            init_pid: 42,
            start_ticks: 11,
            namespace_inode: 23,
        }
    }
}

#[tokio::test]
#[ignore = "requires a real isolated transactional database"]
async fn unknown_observation() {
    let f = Fixture::new().await;
    let operation = Uuid::new_v4();
    f.worker.fail_observe.store(true, Ordering::SeqCst);
    assert!(matches!(
        f.broker.submit(f.caller(), operation, &f.request).await,
        Err(Error::Unavailable { .. })
    ));
    assert_eq!(
        f.broker
            .get(f.caller(), operation)
            .await
            .unwrap()
            .state
            .phase,
        Phase::Reserved
    );
    assert!(matches!(
        f.broker.reconcile(f.caller(), operation).await,
        Err(Error::Unavailable { .. })
    ));
    assert_eq!(f.worker.starts.load(Ordering::SeqCst), 0);
    f.worker.fail_observe.store(false, Ordering::SeqCst);
    let accepted = f.broker.reconcile(f.caller(), operation).await.unwrap();
    assert_eq!(accepted.state.phase, Phase::Reserved);
    assert!(!accepted.state.released);
    assert!(!accepted.state.output_complete);
    assert_eq!(f.worker.starts.load(Ordering::SeqCst), 1);
    f.pool.close().await;
}

#[tokio::test]
#[ignore = "requires a real isolated transactional database"]
async fn lost_start_reply() {
    let f = Fixture::new().await;
    let operation = Uuid::new_v4();
    f.worker.lose_reply.store(true, Ordering::SeqCst);
    assert!(matches!(
        f.broker.submit(f.caller(), operation, &f.request).await,
        Err(Error::Unavailable { .. })
    ));
    let reopened = f.rebuilt(f.settings.clone());
    reopened.reconcile(f.caller(), operation).await.unwrap();
    reopened
        .submit(f.caller(), operation, &f.request)
        .await
        .unwrap();
    assert_eq!(f.worker.starts.load(Ordering::SeqCst), 1);
    assert_eq!(f.worker.operations.lock().unwrap().len(), 1);
    assert_eq!(
        f.worker
            .operations
            .lock()
            .unwrap()
            .values()
            .next()
            .unwrap()
            .launch
            .as_ref()
            .unwrap()
            .id,
        f.id(operation)
    );
    f.pool.close().await;
}

#[tokio::test]
#[ignore = "requires a real isolated transactional database"]
async fn cancelled_reservation() {
    let f = Fixture::new().await;
    let operation = Uuid::new_v4();
    f.worker.fail_observe.store(true, Ordering::SeqCst);
    assert!(
        f.broker
            .submit(f.caller(), operation, &f.request)
            .await
            .is_err()
    );
    f.authority.deny.store(true, Ordering::SeqCst);
    let stopped = f.broker.stop(f.caller(), operation).await.unwrap();
    assert_eq!(stopped.state.phase, Phase::Drained);
    assert!(stopped.state.stop_requested);
    assert!(!stopped.state.released);
    assert_eq!(
        f.broker
            .submit(f.caller(), operation, &f.request)
            .await
            .unwrap(),
        stopped
    );
    assert_eq!(f.worker.starts.load(Ordering::SeqCst), 0);
    assert!(
        f.worker.operations.lock().unwrap()[&(f.caller().scope, operation)]
            .launch
            .is_none()
    );
    f.pool.close().await;
}

#[tokio::test]
#[ignore = "requires a real isolated transactional database"]
async fn response_identity() {
    let f = Fixture::new().await;
    let operation = Uuid::new_v4();
    let other = Uuid::new_v4();
    let previous = f
        .broker
        .submit(f.caller(), other, &f.request)
        .await
        .unwrap();
    *f.worker.wrong_identity.lock().unwrap() = Some(f.id(other));
    assert!(matches!(
        f.broker.submit(f.caller(), operation, &f.request).await,
        Err(Error::Conflict)
    ));
    assert_eq!(f.broker.get(f.caller(), other).await.unwrap(), previous);
    *f.worker.wrong_identity.lock().unwrap() = None;
    f.broker.reconcile(f.caller(), operation).await.unwrap();
    assert_eq!(f.worker.starts.load(Ordering::SeqCst), 2);
    f.pool.close().await;
}

#[tokio::test]
#[ignore = "requires a real isolated transactional database"]
async fn pinned_policy() {
    let f = Fixture::new().await;
    let operation = Uuid::new_v4();
    f.broker
        .submit(f.caller(), operation, &f.request)
        .await
        .unwrap();
    let (token, caller) = f.callback(operation).await;
    f.broker
        .worker_event(
            &caller,
            WorkerEvent::Attached {
                process: f.process(),
            },
        )
        .await
        .unwrap();
    f.broker
        .worker_event(&caller, WorkerEvent::Release)
        .await
        .unwrap();
    let mut changed = f.settings.clone();
    changed.revision = "replacement".into();
    changed.frame_bytes = 1;
    changed.max_body_bytes = 128;
    let rebuilt = f.rebuilt(changed.clone());
    let frame = WorkerEvent::Output {
        sequence: 1,
        stream: Stream::Stdout,
        data: BASE64_URL_SAFE_NO_PAD.encode(vec![7; f.settings.frame_bytes]),
    };
    let bytes = serde_json::to_vec(&frame).unwrap();
    assert!(bytes.len() > changed.max_body_bytes);
    let response = rebuilt
        .router()
        .oneshot(
            HttpRequest::builder()
                .method("POST")
                .uri(format!("/{operation}/worker"))
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .body(Body::from(bytes))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    let snapshot: Snapshot =
        serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert_eq!(snapshot.state.last_sequence, 1);
    f.pool.close().await;
}

#[tokio::test]
#[ignore = "requires a real isolated transactional database"]
async fn pending_output() {
    let f = Fixture::new().await;
    let operation = Uuid::new_v4();
    f.broker
        .submit(f.caller(), operation, &f.request)
        .await
        .unwrap();
    let (_, caller) = f.callback(operation).await;
    let process = f.process();
    f.broker
        .worker_event(
            &caller,
            WorkerEvent::Attached {
                process: process.clone(),
            },
        )
        .await
        .unwrap();
    f.broker
        .worker_event(&caller, WorkerEvent::Release)
        .await
        .unwrap();
    f.worker
        .operations
        .lock()
        .unwrap()
        .get_mut(&(f.caller().scope, operation))
        .unwrap()
        .state = WorkerState::Drained {
        process,
        exit: ExitStatus::Code(0),
        sequence: 1,
    };
    let draining = f.broker.reconcile(f.caller(), operation).await.unwrap();
    assert_eq!(draining.state.phase, Phase::Exited);
    assert!(!draining.state.output_complete);
    f.broker
        .worker_event(
            &caller,
            WorkerEvent::Output {
                sequence: 1,
                stream: Stream::Stdout,
                data: BASE64_URL_SAFE_NO_PAD.encode(b"kept"),
            },
        )
        .await
        .unwrap();
    let drained = f.broker.reconcile(f.caller(), operation).await.unwrap();
    assert_eq!(drained.state.phase, Phase::Drained);
    assert!(drained.state.output_complete);
    f.pool.close().await;
}

#[tokio::test]
#[ignore = "requires a real isolated transactional database"]
async fn route_authority() {
    let f = Fixture::new().await;
    let operation = Uuid::new_v4();
    f.broker
        .submit(f.caller(), operation, &f.request)
        .await
        .unwrap();
    let (token, _) = f.callback(operation).await;
    let router = f.broker.clone().router();
    for (method, path, credential, expected) in [
        ("GET", format!("/{operation}"), "engine", StatusCode::OK),
        (
            "GET",
            format!("/{operation}"),
            token.as_str(),
            StatusCode::UNAUTHORIZED,
        ),
        (
            "POST",
            format!("/{operation}/worker"),
            "engine",
            StatusCode::UNAUTHORIZED,
        ),
        (
            "POST",
            format!("/{operation}/worker"),
            token.as_str(),
            StatusCode::OK,
        ),
        (
            "POST",
            format!("/{}/worker", Uuid::new_v4()),
            token.as_str(),
            StatusCode::FORBIDDEN,
        ),
        (
            "GET",
            format!("/{operation}/output?limit=0"),
            "engine",
            StatusCode::BAD_REQUEST,
        ),
    ] {
        let response = router
            .clone()
            .oneshot(
                HttpRequest::builder()
                    .method(method)
                    .uri(path)
                    .header(header::AUTHORIZATION, format!("Bearer {credential}"))
                    .body(Body::from(serde_json::to_vec(&WorkerEvent::Read).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), expected);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    }
    f.pool.close().await;
}

#[tokio::test]
#[ignore = "requires a real isolated transactional database"]
async fn recovery_pages() {
    use std::{collections::BTreeSet, num::NonZeroUsize};
    let f = Fixture::new().await;
    assert!(!f.broker.has_pending(f.caller()).await.unwrap());
    let operations = [Uuid::new_v4(), Uuid::new_v4()];
    f.worker.fail_observe.store(true, Ordering::SeqCst);
    for operation in operations {
        assert!(
            f.broker
                .submit(f.caller(), operation, &f.request)
                .await
                .is_err()
        );
    }
    f.broker
        .cancel(f.caller(), Uuid::new_v4(), &f.request)
        .await
        .unwrap();
    assert!(f.broker.has_pending(f.caller()).await.unwrap());
    let first = f
        .broker
        .recover(f.caller(), NonZeroUsize::new(1).unwrap(), None)
        .await
        .unwrap();
    assert_eq!(first.outcomes.len(), 1);
    assert!(matches!(
        first.outcomes[0].result,
        Err(Error::Unavailable { .. })
    ));
    let second = f
        .broker
        .recover(
            f.caller(),
            NonZeroUsize::new(1).unwrap(),
            first.cursor.as_deref(),
        )
        .await
        .unwrap();
    assert_eq!(second.outcomes.len(), 1);
    assert!(second.cursor.is_none());
    assert!(matches!(
        second.outcomes[0].result,
        Err(Error::Unavailable { .. })
    ));
    assert_eq!(
        BTreeSet::from([
            first.outcomes[0].operation_id,
            second.outcomes[0].operation_id
        ]),
        BTreeSet::from(operations)
    );
    assert_eq!(f.worker.starts.load(Ordering::SeqCst), 0);
    let other = Fixture::new().await;
    assert!(matches!(
        other
            .broker
            .recover(
                other.caller(),
                NonZeroUsize::new(1).unwrap(),
                first.cursor.as_deref()
            )
            .await,
        Err(Error::Invalid)
    ));
    other.pool.close().await;
    let mut stale = f.caller().clone();
    stale.generation += 1;
    assert!(matches!(
        f.broker.has_pending(&stale).await,
        Err(Error::Forbidden)
    ));
    f.worker.fail_observe.store(false, Ordering::SeqCst);
    let resumed = f
        .broker
        .recover(
            f.caller(),
            NonZeroUsize::new(operations.len()).unwrap(),
            None,
        )
        .await
        .unwrap();
    assert_eq!(resumed.outcomes.len(), operations.len());
    assert!(resumed.outcomes.iter().all(|result| result.result.is_ok()));
    assert!(f.broker.has_pending(f.caller()).await.unwrap());
    for operation in operations {
        f.broker.stop(f.caller(), operation).await.unwrap();
    }
    assert!(!f.broker.has_pending(f.caller()).await.unwrap());
    f.pool.close().await;
    assert!(matches!(
        f.broker.has_pending(f.caller()).await,
        Err(Error::Database(_))
    ));
}
