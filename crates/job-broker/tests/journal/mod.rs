#![allow(clippy::unwrap_used, clippy::expect_used)]

use super::*;
use crate::{Callback, Credential, GrantReference, Request, Settings, Source};
use std::{collections::BTreeMap, process::Stdio};
use tokio::time::{sleep, timeout};

#[derive(Serialize, Deserialize)]
struct Fixture {
    root: PathBuf,
    worker: Uuid,
    host: HostIdentity,
    id: JobId,
}
impl Fixture {
    fn new() -> Self {
        assert_ne!(rustix::process::geteuid().as_raw(), 0);
        let root = PathBuf::from("/tmp").join(format!("journal-{}", Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        fs::create_dir(root.join("private")).unwrap();
        fs::create_dir(root.join("workspace")).unwrap();
        println!("journal evidence: {}", root.display());
        Self {
            root,
            worker: Uuid::new_v4(),
            host: HostIdentity::current(Uuid::new_v4()).unwrap(),
            id: JobId {
                scope: Uuid::new_v4(),
                operation: Uuid::new_v4(),
            },
        }
    }
    fn key(&self) -> Arc<JobKey> {
        Arc::new(JobKey::new([53; 32]))
    }
    fn process(&self) -> ProcessIdentity {
        ProcessIdentity {
            domain: self.host.domain,
            boot: self.host.boot,
            init_pid: 42,
            start_ticks: 17,
            namespace_inode: self.host.pid_namespace_inode + 1,
        }
    }
    fn profile(&self) -> NamespaceConfig {
        NamespaceConfig {
            launcher: "/usr/bin/true".into(),
            gate: "/usr/bin/true".into(),
            capture: "/usr/bin/true".into(),
            private_root: self.root.join("private"),
            workspace: self.root.join("workspace"),
            read_only: vec!["/usr".into()],
            environment: BTreeMap::new(),
        }
    }
    fn start(&self) -> WorkerStart {
        WorkerStart {
            version: 1,
            id: self.id,
            request: Request {
                version: 1,
                domain: self.host.domain,
                source: Source::Tool {
                    goal_id: "goal".into(),
                    conversation_id: 1,
                    task_id: 2,
                    call_id: "call".into(),
                },
                grant: GrantReference {
                    id: self.id.scope,
                    version: 1,
                },
                argv: vec!["/usr/bin/true".into()],
                cwd: "/workspace".into(),
                env: BTreeMap::from([("PRIVATE_VALUE".into(), "journal-secret-fixture".into())]),
                inherit_env: false,
                timeout_ms: None,
                policy_revision: "journal-fixture".into(),
            },
            settings: Settings {
                version: 1,
                revision: "journal-fixture".into(),
                poll_after_ms: 1,
                recovery_interval_ms: 7,
                request_timeout_ms: deadline().as_millis().try_into().unwrap(),
                frame_bytes: 4096,
                output_page_bytes: 4096,
                max_body_bytes: 65536,
            },
            callback: Callback {
                url: "http://callback.invalid/operation/worker".into(),
                credential: Credential::new("journal-callback-fixture".into()).unwrap(),
            },
        }
    }
    async fn create(&self) -> WorkerJournal {
        WorkerJournal::create(
            &self.root.join("private"),
            self.worker,
            self.host.clone(),
            self.key(),
        )
        .await
        .unwrap()
    }
    async fn open(&self) -> Result<WorkerJournal> {
        WorkerJournal::open(
            &self.root.join("private"),
            self.worker,
            self.host.clone(),
            self.key(),
        )
        .await
    }
}
fn deadline() -> Duration {
    let contract: serde_json::Value =
        serde_json::from_str(include_str!("../../../protocol/contracts.json")).unwrap();
    Duration::from_millis(contract["callTimeoutMs"].as_u64().unwrap())
}

#[tokio::test]
async fn immutable_admission() {
    let f = Fixture::new();
    let journal = f.create().await;
    let start = f.start();
    let first = journal.admit(&start, &f.profile()).await.unwrap();
    assert_eq!(first.stage(), Some(LaunchStage::Accepted));
    let mut profile = f.profile();
    profile.workspace = f.root.join("unadopted-workspace");
    let repeated = journal.admit(&start, &profile).await.unwrap();
    assert_eq!(first.revision(), repeated.revision());
    assert_eq!(repeated.namespace(), Some(&f.profile()));
    for field in ["command", "settings", "callback"] {
        let mut changed = start.clone();
        match field {
            "command" => changed.request.argv.push("different".into()),
            "settings" => changed.settings.revision = "different".into(),
            "callback" => {
                changed.callback.credential = Credential::new("different".into()).unwrap()
            }
            _ => unreachable!(),
        }
        assert!(matches!(
            journal.admit(&changed, &f.profile()).await,
            Err(Error::Conflict)
        ));
    }
    journal.close().await.unwrap();
    drop(journal);
    for path in fs::read_dir(f.root.join("private")).unwrap() {
        let path = path.unwrap().path();
        if !path.is_file() {
            continue;
        }
        let bytes = fs::read(path).unwrap();
        for secret in [
            b"journal-secret-fixture".as_slice(),
            b"journal-callback-fixture",
        ] {
            assert!(!bytes.windows(secret.len()).any(|value| value == secret));
        }
    }
    let reopened = f.open().await.unwrap();
    assert_eq!(
        reopened.get(f.id).await.unwrap().unwrap().start(),
        Some(&start)
    );
    reopened.close().await.unwrap();
}

#[tokio::test]
async fn cancellation() {
    let f = Fixture::new();
    let journal = f.create().await;
    let cancelled = journal.stop(f.id).await.unwrap();
    assert!(cancelled.stopped());
    assert_eq!(cancelled.terminal(), Some(&WorkerState::Cancelled));
    assert!(
        journal
            .admit(&f.start(), &f.profile())
            .await
            .unwrap()
            .start()
            .is_none()
    );
    assert!(matches!(journal.spawn(f.id).await, Err(Error::Conflict)));
    let mut start = f.start();
    start.id.operation = Uuid::new_v4();
    let profile = f.profile();
    let (admission, stop) = tokio::join!(journal.admit(&start, &profile), journal.stop(start.id));
    admission.unwrap();
    stop.unwrap();
    assert_eq!(
        journal.get(start.id).await.unwrap().unwrap().terminal(),
        Some(&WorkerState::Cancelled)
    );
    assert!(
        journal
            .pending(None, NonZeroUsize::new(1).unwrap())
            .await
            .unwrap()
            .is_empty()
    );
    journal.close().await.unwrap();
}

#[tokio::test]
async fn original_attempt() {
    let f = Fixture::new();
    let journal = f.create().await;
    journal.admit(&f.start(), &f.profile()).await.unwrap();
    assert!(matches!(journal.release(f.id).await, Err(Error::Conflict)));
    let (first, second) = tokio::join!(journal.spawn(f.id), journal.spawn(f.id));
    assert_ne!(first.unwrap(), second.unwrap());
    assert!(matches!(journal.release(f.id).await, Err(Error::Conflict)));
    journal.bind(f.id, f.process()).await.unwrap();
    assert!(journal.release(f.id).await.unwrap());
    assert!(!journal.release(f.id).await.unwrap());
    assert!(!journal.spawn(f.id).await.unwrap());
    assert!(matches!(
        journal.finish(f.id, WorkerState::Cancelled).await,
        Err(Error::Conflict)
    ));
    journal.close().await.unwrap();
    drop(journal);
    let reopened = f.open().await.unwrap();
    assert!(!reopened.release(f.id).await.unwrap());
    assert!(!reopened.spawn(f.id).await.unwrap());
    assert!(reopened.stop(f.id).await.unwrap().terminal().is_none());
    assert!(matches!(reopened.release(f.id).await, Err(Error::Conflict)));
    reopened.close().await.unwrap();
}

#[tokio::test]
async fn controller_ownership() {
    let f = Fixture::new();
    let journal = f.create().await;
    assert!(matches!(f.open().await, Err(Error::Conflict)));
    journal.close().await.unwrap();
    assert!(matches!(f.open().await, Err(Error::Conflict)));
    drop(journal);
    let next = f.open().await.unwrap();
    assert!(next.get(f.id).await.unwrap().is_none());
    next.close().await.unwrap();
}

#[tokio::test]
async fn storage_identity() {
    let f = Fixture::new();
    let journal = f.create().await;
    journal.admit(&f.start(), &f.profile()).await.unwrap();
    journal.close().await.unwrap();
    drop(journal);
    let copy = f.root.join("copy");
    fs::create_dir(&copy).unwrap();
    for entry in fs::read_dir(f.root.join("private")).unwrap() {
        let entry = entry.unwrap();
        if entry.path().is_file() {
            fs::copy(entry.path(), copy.join(entry.file_name())).unwrap();
        }
    }
    assert!(matches!(
        WorkerJournal::open(&copy, f.worker, f.host.clone(), f.key()).await,
        Err(Error::Conflict)
    ));
    assert!(matches!(
        WorkerJournal::open(
            &f.root.join("private"),
            Uuid::new_v4(),
            f.host.clone(),
            f.key()
        )
        .await,
        Err(Error::Ciphertext)
    ));
    assert!(matches!(
        WorkerJournal::open(
            &f.root.join("private"),
            f.worker,
            f.host.clone(),
            Arc::new(JobKey::new([54; 32]))
        )
        .await,
        Err(Error::Ciphertext)
    ));
    let mut host = f.host.clone();
    host.domain = Uuid::new_v4();
    assert!(matches!(
        WorkerJournal::open(&f.root.join("private"), f.worker, host, f.key()).await,
        Err(Error::Conflict)
    ));
    fs::rename(
        f.root.join("private/worker.db"),
        f.root.join("private/preserved.db"),
    )
    .unwrap();
    assert!(matches!(f.open().await, Err(Error::Io(_))));
    assert!(!f.root.join("private/worker.db").exists());
}

#[tokio::test]
async fn record_authentication() {
    let f = Fixture::new();
    let journal = f.create().await;
    let mut second = f.start();
    second.id.operation = Uuid::new_v4();
    journal.admit(&f.start(), &f.profile()).await.unwrap();
    journal.admit(&second, &f.profile()).await.unwrap();
    {
        let mut held = journal.connection.lock().await;
        let connection = held.as_mut().unwrap();
        sqlx::query("UPDATE worker_jobs SET sealed=(SELECT sealed FROM worker_jobs WHERE scope=? AND operation=?) WHERE scope=? AND operation=?")
            .bind(f.id.scope).bind(f.id.operation).bind(second.id.scope).bind(second.id.operation).execute(connection).await.unwrap();
    }
    assert!(matches!(
        journal.get(second.id).await,
        Err(Error::Ciphertext)
    ));
    assert!(journal.get(f.id).await.unwrap().is_some());
    journal.close().await.unwrap();
}

#[tokio::test]
async fn pending_pages() {
    let f = Fixture::new();
    let journal = f.create().await;
    let mut start = f.start();
    for operation in 1..=3 {
        start.id.operation = Uuid::from_u128(operation);
        journal.admit(&start, &f.profile()).await.unwrap();
    }
    let cancelled = JobId {
        scope: f.id.scope,
        operation: Uuid::from_u128(2),
    };
    journal.stop(cancelled).await.unwrap();
    let first = journal
        .pending(None, NonZeroUsize::new(1).unwrap())
        .await
        .unwrap();
    assert_eq!(first.len(), 1);
    assert_eq!(first[0].id().operation, Uuid::from_u128(1));
    let next = journal
        .pending(Some(first[0].id()), NonZeroUsize::new(1).unwrap())
        .await
        .unwrap();
    assert_eq!(next.len(), 1);
    assert_eq!(next[0].id().operation, Uuid::from_u128(3));
    assert!(
        journal
            .pending(Some(next[0].id()), NonZeroUsize::new(1).unwrap())
            .await
            .unwrap()
            .is_empty()
    );
    journal.close().await.unwrap();
    assert!(
        journal
            .pending(None, NonZeroUsize::new(1).unwrap())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn release_budget() {
    let f = Fixture::new();
    let journal = f.create().await;
    let mut start = f.start();
    start.request.timeout_ms = Some(1);
    journal.admit(&start, &f.profile()).await.unwrap();
    assert!(!journal.get(f.id).await.unwrap().unwrap().expired().unwrap());
    journal.spawn(f.id).await.unwrap();
    journal.bind(f.id, f.process()).await.unwrap();
    journal.release(f.id).await.unwrap();
    let released = journal
        .get(f.id)
        .await
        .unwrap()
        .unwrap()
        .content
        .plan
        .unwrap()
        .released_at;
    journal.close().await.unwrap();
    drop(journal);
    let journal = f.open().await.unwrap();
    assert!(!journal.release(f.id).await.unwrap());
    let record = journal.get(f.id).await.unwrap().unwrap();
    assert_eq!(record.content.plan.as_ref().unwrap().released_at, released);
    timeout(deadline(), async {
        while !record.expired().unwrap() {
            sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(record.remaining().unwrap(), Some(Duration::ZERO));
    journal.close().await.unwrap();
}

#[tokio::test]
async fn namespace_fencing() {
    let f = Fixture::new();
    let journal = f.create().await;
    journal.admit(&f.start(), &f.profile()).await.unwrap();
    journal.spawn(f.id).await.unwrap();
    let process = f.process();
    journal.bind(f.id, process.clone()).await.unwrap();
    let mut wrong = process.clone();
    wrong.start_ticks += 1;
    assert!(matches!(
        journal.bind(f.id, wrong.clone()).await,
        Err(Error::Conflict)
    ));
    assert!(matches!(
        journal.fence(f.id, &wrong).await,
        Err(Error::Conflict)
    ));
    let terminal = WorkerState::Drained {
        process: process.clone(),
        exit: crate::ExitStatus::Code(0),
        sequence: 0,
    };
    assert!(matches!(
        journal.finish(f.id, terminal.clone()).await,
        Err(Error::Conflict)
    ));
    journal.fence(f.id, &process).await.unwrap();
    journal.close().await.unwrap();
    drop(journal);
    let journal = f.open().await.unwrap();
    assert!(journal.get(f.id).await.unwrap().unwrap().fenced());
    journal.finish(f.id, terminal.clone()).await.unwrap();
    assert_eq!(
        journal.get(f.id).await.unwrap().unwrap().terminal(),
        Some(&terminal)
    );
    journal.close().await.unwrap();
}

#[tokio::test]
async fn resolved_input_bound() {
    let f = Fixture::new();
    let journal = f.create().await;
    let mut start = f.start();
    start.request.inherit_env = true;
    let mut profile = f.profile();
    profile.environment.insert(
        "PROFILE_SECRET".into(),
        "x".repeat(start.settings.max_body_bytes),
    );
    assert!(matches!(
        journal.admit(&start, &profile).await,
        Err(Error::Invalid)
    ));
    assert!(journal.get(start.id).await.unwrap().is_none());
    start.request.inherit_env = false;
    let record = journal.admit(&start, &profile).await.unwrap();
    assert!(!record.command().unwrap().env.contains_key("PROFILE_SECRET"));
    journal.close().await.unwrap();
}

#[tokio::test]
async fn full_store() {
    let f = Fixture::new();
    let journal = f.create().await;
    let page_size = {
        let mut held = journal.connection.lock().await;
        let connection = held.as_mut().unwrap();
        let pages: i64 = sqlx::query_scalar("PRAGMA page_count")
            .fetch_one(&mut *connection)
            .await
            .unwrap();
        let maximum: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
            "PRAGMA max_page_count={pages}"
        )))
        .fetch_one(connection)
        .await
        .unwrap();
        assert_eq!(pages, maximum);
        sqlx::query_scalar::<_, i64>("PRAGMA page_size")
            .fetch_one(held.as_mut().unwrap())
            .await
            .unwrap()
    };
    let mut start = f.start();
    start
        .request
        .argv
        .push("x".repeat(usize::try_from(page_size).unwrap() * 2));
    assert!(serde_json::to_vec(&start).unwrap().len() < start.settings.max_body_bytes);
    let error = journal.admit(&start, &f.profile()).await.unwrap_err();
    assert!(
        matches!(&error, Error::Database(error) if error.as_database_error().is_some_and(|database|database.code().as_deref()==Some("13"))),
        "{error:?}"
    );
    assert!(journal.get(start.id).await.unwrap().is_none());
    assert!(
        journal
            .pending(None, NonZeroUsize::new(1).unwrap())
            .await
            .unwrap()
            .is_empty()
    );
    journal.close().await.unwrap();
    drop(journal);
    let reopened = f.open().await.unwrap();
    assert!(reopened.get(start.id).await.unwrap().is_none());
    reopened.close().await.unwrap();
}

#[tokio::test]
#[ignore = "subprocess entry used by crash_recovery"]
async fn controller_child() {
    let path = PathBuf::from(
        std::env::var_os("CHOPIN_JOURNAL_FIXTURE").expect("journal fixture path required"),
    );
    let f: Fixture = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    let stage = std::env::var("CHOPIN_JOURNAL_STAGE").unwrap();
    let journal = f.create().await;
    if stage == "uncommitted" {
        let mut held = journal.connection.lock().await;
        let mut tx = held
            .as_mut()
            .unwrap()
            .begin_with("BEGIN IMMEDIATE")
            .await
            .unwrap();
        let record = WorkerRecord {
            id: f.id,
            revision: 1,
            content: Content {
                plan: Some(Plan {
                    start: f.start(),
                    namespace: f.profile(),
                    stage: LaunchStage::Accepted,
                    released_at: None,
                }),
                stopped: false,
                terminal: None,
                process: None,
                fenced: false,
            },
        };
        journal.insert(&mut tx, &record).await.unwrap();
        checkpoint(&f.root);
        std::future::pending::<()>().await;
        return;
    }
    journal.admit(&f.start(), &f.profile()).await.unwrap();
    match stage.as_str() {
        "accepted" => {}
        "spawn" => {
            assert!(journal.spawn(f.id).await.unwrap());
        }
        "release" => {
            assert!(journal.spawn(f.id).await.unwrap());
            journal.bind(f.id, f.process()).await.unwrap();
            assert!(journal.release(f.id).await.unwrap());
        }
        "stop" => {
            journal.stop(f.id).await.unwrap();
        }
        _ => panic!("unknown fixture stage"),
    }
    checkpoint(&f.root);
    std::future::pending::<()>().await;
}
fn checkpoint(root: &Path) {
    fs::write(root.join("checkpoint"), b"ready").unwrap();
    File::open(root.join("checkpoint"))
        .unwrap()
        .sync_all()
        .unwrap();
    File::open(root).unwrap().sync_all().unwrap();
}

#[tokio::test]
async fn crash_recovery() {
    for stage in ["uncommitted", "accepted", "spawn", "release", "stop"] {
        let f = Fixture::new();
        let fixture = f.root.join("fixture.json");
        fs::write(&fixture, serde_json::to_vec(&f).unwrap()).unwrap();
        let mut child = tokio::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                "runtime::journal::tests::controller_child",
                "--nocapture",
            ])
            .env("CHOPIN_JOURNAL_FIXTURE", fixture)
            .env("CHOPIN_JOURNAL_STAGE", stage)
            .stdout(Stdio::null())
            .stderr(File::create(f.root.join("controller.log")).unwrap())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        timeout(deadline(), async {
            while !f.root.join("checkpoint").exists() {
                assert!(
                    child.try_wait().unwrap().is_none(),
                    "controller failed at {stage}"
                );
                sleep(Duration::from_millis(1)).await;
            }
        })
        .await
        .unwrap();
        assert!(matches!(f.open().await, Err(Error::Conflict)));
        child.start_kill().unwrap();
        assert!(
            !timeout(deadline(), child.wait())
                .await
                .unwrap()
                .unwrap()
                .success()
        );
        let journal = f.open().await.unwrap();
        let record = journal.get(f.id).await.unwrap();
        if stage == "uncommitted" {
            assert!(record.is_none());
        } else {
            let record = record.unwrap();
            assert_eq!(record.start(), Some(&f.start()));
            match stage {
                "accepted" => assert_eq!(record.stage(), Some(LaunchStage::Accepted)),
                "spawn" => assert!(!journal.spawn(f.id).await.unwrap()),
                "release" => assert!(!journal.release(f.id).await.unwrap()),
                "stop" => assert_eq!(record.terminal(), Some(&WorkerState::Cancelled)),
                _ => unreachable!(),
            }
        }
        journal.close().await.unwrap();
    }
}
