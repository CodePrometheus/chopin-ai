//! Real transactions validate encrypted intent, output and process lifecycle invariants.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use base64::{Engine as _, prelude::BASE64_URL_SAFE_NO_PAD};
use chopin_job_broker::{
    Admission, Caller, Error, ExitStatus, GrantReference, JobId, JobKey, Ledger, Phase,
    ProcessIdentity, Request, SCHEMA_V1, Settings, Source, Stream, WorkerEvent,
};
use sqlx::{
    Executor, PgPool,
    postgres::{PgConnectOptions, PgPoolOptions},
};
use std::{collections::BTreeMap, num::NonZeroUsize, str::FromStr};
use uuid::Uuid;

struct Fixture {
    pool: PgPool,
    ledger: Ledger,
    caller: Caller,
    request: Request,
    settings: Settings,
}
impl Fixture {
    async fn new() -> Self {
        let url = std::env::var("CHOPIN_TEST_DATABASE_URL")
            .expect("an isolated transactional database is required");
        let schema = format!("command_{}", Uuid::new_v4().simple());
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
            argv: vec!["sh".into(), "-c".into(), "sensitive command".into()],
            cwd: "/workspace".into(),
            env: BTreeMap::new(),
            inherit_env: false,
            timeout_ms: None,
            policy_revision: "fixture".into(),
        };
        Self {
            pool,
            ledger: Ledger::new(JobKey::new([31; 32])),
            caller,
            request,
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
        }
    }
    fn id(&self) -> JobId {
        JobId {
            scope: self.caller.scope,
            operation: Uuid::new_v4(),
        }
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
fn bound() -> NonZeroUsize {
    NonZeroUsize::new(64).unwrap()
}

#[tokio::test]
#[ignore = "requires a real isolated transactional database"]
async fn immutable_intent() {
    let f = Fixture::new().await;
    let id = f.id();
    let mut tx = f.pool.begin().await.unwrap();
    let (first, inserted) = f
        .ledger
        .record(
            &mut tx,
            &f.caller,
            id.operation,
            &f.request,
            Admission::Execute(&f.settings),
        )
        .await
        .unwrap();
    assert!(inserted);
    tx.rollback().await.unwrap();
    let mut tx = f.pool.begin().await.unwrap();
    assert!(f.ledger.read(&mut tx, id).await.unwrap().is_none());
    f.ledger
        .record(
            &mut tx,
            &f.caller,
            id.operation,
            &f.request,
            Admission::Execute(&f.settings),
        )
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let mut tx = f.pool.begin().await.unwrap();
    let (again, inserted) = f
        .ledger
        .record(
            &mut tx,
            &f.caller,
            id.operation,
            &f.request,
            Admission::Execute(&f.settings),
        )
        .await
        .unwrap();
    assert!(!inserted);
    assert_eq!(first.snapshot(), again.snapshot());
    let mut changed = f.request.clone();
    changed.argv.push("different".into());
    assert!(matches!(
        f.ledger
            .record(
                &mut tx,
                &f.caller,
                id.operation,
                &changed,
                Admission::Execute(&f.settings)
            )
            .await,
        Err(Error::Conflict)
    ));
    tx.rollback().await.unwrap();
    f.pool.close().await;
}

#[tokio::test]
#[ignore = "requires a real isolated transactional database"]
async fn cancel_before_submit() {
    let f = Fixture::new().await;
    let id = f.id();
    let mut tx = f.pool.begin().await.unwrap();
    let (cancelled, _) = f
        .ledger
        .record(
            &mut tx,
            &f.caller,
            id.operation,
            &f.request,
            Admission::Cancel(&f.settings),
        )
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let mut tx = f.pool.begin().await.unwrap();
    let (mut late, inserted) = f
        .ledger
        .record(
            &mut tx,
            &f.caller,
            id.operation,
            &f.request,
            Admission::Execute(&f.settings),
        )
        .await
        .unwrap();
    assert!(!inserted);
    assert_eq!(late.snapshot(), cancelled.snapshot());
    assert_eq!(late.snapshot().state.phase, Phase::Drained);
    assert!(matches!(
        f.ledger.reserve(&mut tx, &mut late, Uuid::new_v4()).await,
        Err(Error::Conflict)
    ));
    tx.rollback().await.unwrap();
    f.pool.close().await;
}

#[tokio::test]
#[ignore = "requires a real isolated transactional database"]
async fn output_and_drain() {
    let f = Fixture::new().await;
    let id = f.id();
    let worker = Uuid::new_v4();
    let process = f.process();
    let mut tx = f.pool.begin().await.unwrap();
    let (mut record, _) = f
        .ledger
        .record(
            &mut tx,
            &f.caller,
            id.operation,
            &f.request,
            Admission::Execute(&f.settings),
        )
        .await
        .unwrap();
    f.ledger
        .reserve(&mut tx, &mut record, worker)
        .await
        .unwrap();
    assert!(matches!(
        f.ledger.reserve(&mut tx, &mut record, Uuid::new_v4()).await,
        Err(Error::Conflict)
    ));
    f.ledger
        .event(
            &mut tx,
            &mut record,
            worker,
            &WorkerEvent::Attached {
                process: process.clone(),
            },
        )
        .await
        .unwrap();
    f.ledger
        .event(&mut tx, &mut record, worker, &WorkerEvent::Release)
        .await
        .unwrap();
    let frame = WorkerEvent::Output {
        sequence: 1,
        stream: Stream::Stdout,
        data: BASE64_URL_SAFE_NO_PAD.encode(b"result"),
    };
    f.ledger
        .event(&mut tx, &mut record, worker, &frame)
        .await
        .unwrap();
    let version = record.snapshot().state.version;
    f.ledger
        .event(&mut tx, &mut record, worker, &frame)
        .await
        .unwrap();
    assert_eq!(record.snapshot().state.version, version);
    let conflict = WorkerEvent::Output {
        sequence: 1,
        stream: Stream::Stdout,
        data: BASE64_URL_SAFE_NO_PAD.encode(b"changed"),
    };
    assert!(matches!(
        f.ledger
            .event(&mut tx, &mut record, worker, &conflict)
            .await,
        Err(Error::Conflict)
    ));
    let gap = WorkerEvent::Output {
        sequence: 3,
        stream: Stream::Stdout,
        data: BASE64_URL_SAFE_NO_PAD.encode(b"gap"),
    };
    assert!(matches!(
        f.ledger.event(&mut tx, &mut record, worker, &gap).await,
        Err(Error::Conflict)
    ));
    f.ledger
        .event(
            &mut tx,
            &mut record,
            worker,
            &WorkerEvent::Exited {
                exit: ExitStatus::Code(23),
            },
        )
        .await
        .unwrap();
    assert_eq!(record.snapshot().state.phase, Phase::Exited);
    let drained = WorkerEvent::Drained {
        process: process.clone(),
        sequence: 1,
    };
    assert!(matches!(
        f.ledger.event(&mut tx, &mut record, worker, &drained).await,
        Err(Error::Conflict)
    ));
    f.ledger
        .event(
            &mut tx,
            &mut record,
            worker,
            &WorkerEvent::OutputComplete { sequence: 1 },
        )
        .await
        .unwrap();
    let mut wrong = process;
    wrong.start_ticks += 1;
    assert!(matches!(
        f.ledger
            .event(
                &mut tx,
                &mut record,
                worker,
                &WorkerEvent::Drained {
                    process: wrong,
                    sequence: 1
                },
            )
            .await,
        Err(Error::Conflict)
    ));
    f.ledger
        .event(&mut tx, &mut record, worker, &drained)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let mut tx = f.pool.begin().await.unwrap();
    let record = f.ledger.read(&mut tx, id).await.unwrap().unwrap();
    assert_eq!(record.snapshot().state.phase, Phase::Drained);
    let first = f
        .ledger
        .output(&mut tx, &record, None, NonZeroUsize::new(3).unwrap())
        .await
        .unwrap();
    assert_eq!(BASE64_URL_SAFE_NO_PAD.decode(first.data).unwrap(), b"res");
    assert!(!first.complete);
    let last = f
        .ledger
        .output(&mut tx, &record, Some(&first.cursor), bound())
        .await
        .unwrap();
    assert_eq!(BASE64_URL_SAFE_NO_PAD.decode(last.data).unwrap(), b"ult");
    assert!(last.complete);
    let end = f
        .ledger
        .output(&mut tx, &record, Some(&last.cursor), bound())
        .await
        .unwrap();
    assert_eq!(end.data, "");
    assert!(end.complete);
    tx.commit().await.unwrap();
    f.pool.close().await;
}

#[tokio::test]
#[ignore = "requires a real isolated transactional database"]
async fn ciphertext_binding() {
    let f = Fixture::new().await;
    let first = f.id();
    let second = f.id();
    let mut tx = f.pool.begin().await.unwrap();
    f.ledger
        .record(
            &mut tx,
            &f.caller,
            first.operation,
            &f.request,
            Admission::Execute(&f.settings),
        )
        .await
        .unwrap();
    f.ledger
        .record(
            &mut tx,
            &f.caller,
            second.operation,
            &f.request,
            Admission::Execute(&f.settings),
        )
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let sealed: Vec<u8> =
        sqlx::query_scalar("SELECT content FROM chopin_jobs WHERE scope=$1 AND operation=$2")
            .bind(first.scope)
            .bind(first.operation)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert!(
        !sealed
            .windows(b"sensitive command".len())
            .any(|part| part == b"sensitive command")
    );
    sqlx::query("UPDATE chopin_jobs SET content=$3 WHERE scope=$1 AND operation=$2")
        .bind(second.scope)
        .bind(second.operation)
        .bind(sealed)
        .execute(&f.pool)
        .await
        .unwrap();
    let mut tx = f.pool.begin().await.unwrap();
    assert!(matches!(
        f.ledger.read(&mut tx, second).await,
        Err(Error::Ciphertext)
    ));
    tx.rollback().await.unwrap();
    f.pool.close().await;
}

#[tokio::test]
#[ignore = "requires a real isolated transactional database"]
async fn durable_transaction() {
    let f = Fixture::new().await;
    let id = f.id();
    let mut tx = f.pool.begin().await.unwrap();
    sqlx::query("SET LOCAL synchronous_commit='off'")
        .execute(&mut *tx)
        .await
        .unwrap();
    assert!(matches!(
        f.ledger
            .record(
                &mut tx,
                &f.caller,
                id.operation,
                &f.request,
                Admission::Execute(&f.settings)
            )
            .await,
        Err(Error::Durability)
    ));
    tx.rollback().await.unwrap();
    f.pool.close().await;
}

#[tokio::test]
#[ignore = "requires a real isolated transactional database"]
async fn concurrent_reservation() {
    let f = Fixture::new().await;
    let id = f.id();
    let barrier = tokio::sync::Barrier::new(2);
    let admit = async |worker| {
        let mut tx = f.pool.begin().await.unwrap();
        barrier.wait().await;
        let (mut record, inserted) = f
            .ledger
            .record(
                &mut tx,
                &f.caller,
                id.operation,
                &f.request,
                Admission::Execute(&f.settings),
            )
            .await
            .unwrap();
        if inserted {
            f.ledger
                .reserve(&mut tx, &mut record, worker)
                .await
                .unwrap();
        }
        tx.commit().await.unwrap();
        (record.snapshot(), inserted)
    };
    let (first, second) = tokio::join!(admit(Uuid::new_v4()), admit(Uuid::new_v4()));
    assert_eq!(first.0, second.0);
    assert_ne!(first.1, second.1);
    assert!(first.0.state.worker.is_some());
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM chopin_jobs")
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
    f.pool.close().await;
}

#[tokio::test]
#[ignore = "requires a real isolated transactional database"]
async fn output_key_and_cursor() {
    let f = Fixture::new().await;
    let id = f.id();
    let worker = Uuid::new_v4();
    let wrong_key = Ledger::new(JobKey::new([32; 32]));
    let mut tx = f.pool.begin().await.unwrap();
    let (mut record, _) = f
        .ledger
        .record(
            &mut tx,
            &f.caller,
            id.operation,
            &f.request,
            Admission::Execute(&f.settings),
        )
        .await
        .unwrap();
    f.ledger
        .reserve(&mut tx, &mut record, worker)
        .await
        .unwrap();
    for event in [
        WorkerEvent::Attached {
            process: f.process(),
        },
        WorkerEvent::Release,
        WorkerEvent::Output {
            sequence: 1,
            stream: Stream::Stdout,
            data: BASE64_URL_SAFE_NO_PAD.encode([0, 255, 1, 2]),
        },
    ] {
        f.ledger
            .event(&mut tx, &mut record, worker, &event)
            .await
            .unwrap();
    }
    tx.commit().await.unwrap();
    let mut tx = f.pool.begin().await.unwrap();
    let record = f.ledger.read(&mut tx, id).await.unwrap().unwrap();
    assert!(matches!(
        wrong_key.read(&mut tx, id).await,
        Err(Error::Ciphertext)
    ));
    assert!(matches!(
        wrong_key.output(&mut tx, &record, None, bound()).await,
        Err(Error::Ciphertext)
    ));
    let page = f
        .ledger
        .output(&mut tx, &record, None, bound())
        .await
        .unwrap();
    assert_eq!(
        BASE64_URL_SAFE_NO_PAD.decode(&page.data).unwrap(),
        [0, 255, 1, 2]
    );
    let other = f.id();
    let (foreign, _) = f
        .ledger
        .record(
            &mut tx,
            &f.caller,
            other.operation,
            &f.request,
            Admission::Execute(&f.settings),
        )
        .await
        .unwrap();
    assert!(matches!(
        f.ledger
            .output(&mut tx, &foreign, Some(&page.cursor), bound())
            .await,
        Err(Error::Invalid)
    ));
    tx.rollback().await.unwrap();
    f.pool.close().await;
}

#[tokio::test]
#[ignore = "requires a real isolated transactional database"]
async fn policy_bounds() {
    let mut f = Fixture::new().await;
    f.settings.frame_bytes = 4;
    f.settings.output_page_bytes = 2;
    let id = f.id();
    let worker = Uuid::new_v4();
    let mut tx = f.pool.begin().await.unwrap();
    let (mut record, _) = f
        .ledger
        .record(
            &mut tx,
            &f.caller,
            id.operation,
            &f.request,
            Admission::Execute(&f.settings),
        )
        .await
        .unwrap();
    f.ledger
        .reserve(&mut tx, &mut record, worker)
        .await
        .unwrap();
    for event in [
        WorkerEvent::Attached {
            process: f.process(),
        },
        WorkerEvent::Release,
        WorkerEvent::Output {
            sequence: 1,
            stream: Stream::Stdout,
            data: BASE64_URL_SAFE_NO_PAD.encode([0, 1, 2, 3]),
        },
    ] {
        f.ledger
            .event(&mut tx, &mut record, worker, &event)
            .await
            .unwrap();
    }
    tx.commit().await.unwrap();
    let mut replacement = f.settings.clone();
    replacement.frame_bytes = 64;
    replacement.output_page_bytes = 64;
    let mut tx = f.pool.begin().await.unwrap();
    let (mut record, inserted) = f
        .ledger
        .record(
            &mut tx,
            &f.caller,
            id.operation,
            &f.request,
            Admission::Execute(&replacement),
        )
        .await
        .unwrap();
    assert!(!inserted);
    assert_eq!(record.settings(), &f.settings);
    let oversized = WorkerEvent::Output {
        sequence: 2,
        stream: Stream::Stdout,
        data: BASE64_URL_SAFE_NO_PAD.encode([0, 1, 2, 3, 4]),
    };
    assert!(matches!(
        f.ledger
            .event(&mut tx, &mut record, worker, &oversized)
            .await,
        Err(Error::Invalid)
    ));
    let first = f
        .ledger
        .output(&mut tx, &record, None, bound())
        .await
        .unwrap();
    assert_eq!(BASE64_URL_SAFE_NO_PAD.decode(&first.data).unwrap(), [0, 1]);
    let second = f
        .ledger
        .output(&mut tx, &record, Some(&first.cursor), bound())
        .await
        .unwrap();
    assert_eq!(BASE64_URL_SAFE_NO_PAD.decode(second.data).unwrap(), [2, 3]);
    tx.commit().await.unwrap();
    f.pool.close().await;
}
