//! Real producer interoperability, including persistent service storage.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::{path::PathBuf, process::Stdio, time::Duration};

use chopin_protocol::{
    ChordClient, ConnectionOptions, ConversationState, EngineCommand, GoalCommand, GoalGrant,
    GoalStatus, LoopSettingsPatch, ProtocolError, TlsConnector,
};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines},
    process::{Child, ChildStdin, ChildStdout, Command},
    time::timeout,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Startup {
    url: String,
    credential: String,
    timeout_ms: u64,
    large_bytes: usize,
}

struct Service {
    child: Child,
    input: ChildStdin,
    output: Lines<BufReader<ChildStdout>>,
    startup: Startup,
    directory: PathBuf,
}

impl Service {
    async fn open(directory: PathBuf) -> Self {
        Self::start(directory, None).await
    }

    async fn start(directory: PathBuf, review: Option<&str>) -> Self {
        std::fs::create_dir_all(&directory).unwrap();
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .to_path_buf();
        let log = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(directory.join("service.log"))
            .unwrap();
        let mut child = Command::new("node")
            .arg(root.join("packages/harness-pi/tests/fixtures/rust-service.mjs"))
            .env("CHOPIN_PROTOCOL_FIXTURE_DIR", &directory)
            .env("CHOPIN_HOME", directory.join("home"))
            .env(
                "CHOPIN_PROTOCOL_REVIEW",
                if review.is_some() { "durable" } else { "" },
            )
            .env("CHOPIN_PROTOCOL_REVIEW_MODEL", review.unwrap_or_default())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(log)
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let input = child.stdin.take().unwrap();
        let mut output = BufReader::new(child.stdout.take().unwrap()).lines();
        let line = output
            .next_line()
            .await
            .unwrap()
            .expect("producer did not start; inspect service.log");
        let startup = serde_json::from_str(&line).unwrap();
        Self {
            child,
            input,
            output,
            startup,
            directory,
        }
    }

    async fn new() -> Self {
        Self::open(std::env::temp_dir().join(format!("protocol-interop-{}", uuid::Uuid::new_v4())))
            .await
    }

    async fn client(&self) -> ChordClient {
        ChordClient::connect(&self.startup.url, &self.startup.credential)
            .await
            .unwrap()
    }

    fn deadline(&self) -> Duration {
        Duration::from_millis(self.startup.timeout_ms)
    }

    async fn control(&mut self, op: &str) {
        self.input
            .write_all(format!("{}\n", json!({ "op": op })).as_bytes())
            .await
            .unwrap();
        self.input.flush().await.unwrap();
    }

    async fn event(&mut self) -> Value {
        serde_json::from_str(&self.output.next_line().await.unwrap().unwrap()).unwrap()
    }

    async fn close(mut self) -> PathBuf {
        self.control("stop").await;
        assert!(
            timeout(self.deadline(), self.child.wait())
                .await
                .unwrap()
                .unwrap()
                .success()
        );
        self.directory.clone()
    }
    async fn kill(mut self) -> PathBuf {
        self.child.start_kill().unwrap();
        assert!(
            !timeout(self.deadline(), self.child.wait())
                .await
                .unwrap()
                .unwrap()
                .success()
        );
        self.directory.clone()
    }
}

#[tokio::test]
async fn conversation_recovery() {
    let service = Service::new().await;
    let conversation = timeout(service.deadline(), async {
        let mut client = service.client().await;
        let mut observer = service
            .client()
            .await
            .observe("chopin.conversations", json!({}))
            .await
            .unwrap();
        assert_eq!(observer.state().unwrap()["ids"], json!([]));
        let conversation = client
            .invoke("chopin.conversations", json!({}), "create", None)
            .await
            .unwrap();
        let change = observer.next().await.unwrap();
        assert_eq!(change.revision, 1);
        assert!(change.changed_paths.contains_key("ids"));
        assert_eq!(observer.state().unwrap()["ids"], json!([conversation]));
        client
            .invoke(
                "chopin.conversation",
                json!({"conversation":conversation}),
                "setName",
                Some(json!({"name":"Persistent conversation"})),
            )
            .await
            .unwrap();
        let state = client
            .state_snapshot("chopin.conversation", json!({"conversation":conversation}))
            .await
            .unwrap();
        assert_eq!(state["name"], "Persistent conversation");
        let models = client
            .invoke("chopin.conversations", json!({}), "models", None)
            .await
            .unwrap();
        assert!(!models["models"].as_array().unwrap().is_empty());
        observer.close().await.unwrap();
        client.close().await.unwrap();
        conversation
    })
    .await
    .unwrap();
    let directory = service.close().await;
    let reopened = Service::open(directory).await;
    timeout(reopened.deadline(), async {
        let mut client = reopened.client().await;
        let summaries = client
            .invoke("chopin.conversations", json!({}), "summaries", None)
            .await
            .unwrap();
        assert_eq!(summaries.as_array().unwrap().len(), 1);
        assert_eq!(summaries[0]["id"], conversation);
        assert_eq!(summaries[0]["name"], "Persistent conversation");
        client.close().await.unwrap();
    })
    .await
    .unwrap();
    reopened.close().await;
}

#[tokio::test]
async fn compressed_reply() {
    let service = Service::new().await;
    timeout(service.deadline(), async {
        let mut client = service.client().await;
        let changes = client
            .invoke("chopin.loop", json!({}), "changes", None)
            .await
            .unwrap();
        assert_eq!(
            changes[0]["text"].as_str().unwrap().len(),
            service.startup.large_bytes
        );
        client.close().await.unwrap();
        let options = ConnectionOptions {
            max_decoded_payload_size: Some(service.startup.large_bytes - 1),
            ..ConnectionOptions::default()
        };
        let mut bounded = ChordClient::connect_with(
            &service.startup.url,
            &service.startup.credential,
            TlsConnector::Plain,
            options,
        )
        .await
        .unwrap();
        assert!(matches!(
            bounded
                .invoke("chopin.loop", json!({}), "changes", None)
                .await,
            Err(ProtocolError::MessageTooLarge)
        ));
        assert!(matches!(
            bounded
                .invoke("chopin.loop", json!({}), "standing", None)
                .await,
            Err(ProtocolError::Interrupted)
        ));
    })
    .await
    .unwrap();
    service.close().await;
}

#[tokio::test]
async fn cancelled_call() {
    let mut service = Service::new().await;
    timeout(service.deadline(), async {
        let mut client = service.client().await;
        {
            let call = client.invoke("chopin.loop", json!({}), "undo", Some(json!({"id":"held"})));
            tokio::pin!(call);
            tokio::select! {
                result = &mut call => panic!("method completed before its release: {result:?}"),
                event = service.event() => assert_eq!(event, json!({"event":"method-started","calls":1})),
            }
        }
        assert!(matches!(client.invoke("chopin.loop", json!({}), "undo", Some(json!({"id":"held"}))).await, Err(ProtocolError::Interrupted)));
        service.control("release").await;
        assert_eq!(service.event().await, json!({"event":"released","calls":1}));
        client.close().await.unwrap();
    }).await.unwrap();
    service.close().await;
}

#[tokio::test]
async fn remote_errors() {
    let service = Service::new().await;
    timeout(service.deadline(), async {
        assert!(
            ChordClient::connect(&service.startup.url, "wrong-fixture-credential")
                .await
                .is_err()
        );
        let mut client = service.client().await;
        let refused = client
            .invoke(
                "chopin.conversations",
                json!({}),
                "fork",
                Some(json!({"conversation":0,"at":0})),
            )
            .await
            .unwrap_err();
        assert!(matches!(refused, ProtocolError::Method { .. }));
        assert_eq!(
            client
                .invoke("chopin.conversations", json!({}), "summaries", None)
                .await
                .unwrap(),
            json!([])
        );
        let error = client
            .invoke(
                "chopin.conversation",
                json!({"conversation":0}),
                "abort",
                Some(json!({})),
            )
            .await
            .unwrap_err();
        assert!(matches!(error, ProtocolError::Method { .. }));
        let error = ProtocolError::Method {
            member: "submit".into(),
            error: json!({"message":"private content"}),
        };
        assert!(!format!("{error:?}").contains("private content"));
        assert!(!format!("{error}").contains("private content"));
    })
    .await
    .unwrap();
    service.close().await;
}

#[tokio::test]
async fn history_pages() {
    let mut service = Service::new().await;
    service.control("history").await;
    let history = service.event().await;
    let conversation = history["conversation"].as_u64().unwrap();
    let ids = history["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|id| id.as_u64().unwrap())
        .collect::<Vec<_>>();
    timeout(service.deadline(), async {
        let mut client = service.client().await;
        let summaries = client.summaries().await.unwrap();
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].id, conversation);
        assert!(!client.models().await.unwrap().models.is_empty());
        let observer = service
            .client()
            .await
            .observe_conversation(conversation)
            .await
            .unwrap();
        let state: ConversationState =
            serde_json::from_value(observer.state().unwrap().clone()).unwrap();
        assert_eq!(state.view.entries.len(), ids.len());
        observer.close().await.unwrap();
        let mut cursor = None;
        let mut read = Vec::new();
        loop {
            let page = client.entries(conversation, 1, cursor, None).await.unwrap();
            assert!(page.entries.len() <= 1);
            for entry in page.entries {
                assert_eq!(entry.conversation_id, conversation);
                assert_eq!(entry.kind, "fixture.entry");
                read.push(entry.id);
            }
            let Some(next) = page.cursor else {
                break;
            };
            cursor = Some(next);
        }
        assert_eq!(read, ids.iter().rev().copied().collect::<Vec<_>>());
        let page = client
            .entries(conversation, 1, None, Some(ids[1]))
            .await
            .unwrap();
        assert_eq!(page.entries[0].id, ids[1]);
        assert_eq!(page.entries[0].data.as_ref().unwrap()["text"], "second");
        let empty = client
            .entries(conversation, 1, None, Some(0))
            .await
            .unwrap();
        assert!(empty.entries.is_empty());
        let other = client
            .invoke("chopin.conversations", json!({}), "create", None)
            .await
            .unwrap()
            .as_u64()
            .unwrap();
        if let Some(cursor) = page.cursor {
            assert!(matches!(
                client.entries(other, 1, Some(cursor), None).await,
                Err(ProtocolError::Method { .. })
            ));
        }
        client.close().await.unwrap();
    })
    .await
    .unwrap();
    service.close().await;
}

#[tokio::test]
async fn learning_policy() {
    let service = Service::new().await;
    timeout(service.deadline(), async {
        let mut client = service.client().await;
        assert_eq!(client.loop_standing().await.unwrap().version, 1);
        assert_eq!(client.loop_changes().await.unwrap()[0].id, "large");
        assert!(client.loop_corrections().await.unwrap().is_empty());
        assert!(client.loop_held().await.unwrap().is_empty());
        let changed = client
            .set_loop_settings(&LoopSettingsPatch {
                weekly_budget_usd: Some(Some(3.5)),
                regular_model: Some(Some("provider/regular".into())),
                strong_model: Some(Some("provider/strong".into())),
                hold_for_review: Some(false),
            })
            .await
            .unwrap();
        assert_eq!(changed.weekly_budget_usd, Some(3.5));
        let cleared = client
            .set_loop_settings(&LoopSettingsPatch {
                regular_model: Some(None),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(cleared.regular_model, None);
        assert_eq!(cleared.strong_model, changed.strong_model);
        assert_eq!(cleared.weekly_budget_usd, changed.weekly_budget_usd);
        assert!(!cleared.hold_for_review);
        assert!(matches!(
            client
                .set_loop_settings(&LoopSettingsPatch {
                    weekly_budget_usd: Some(Some(f64::NAN)),
                    ..Default::default()
                })
                .await,
            Err(ProtocolError::InvalidArguments)
        ));
        assert_eq!(client.loop_settings().await.unwrap(), cleared);
        client.decide_loop_change("candidate", false).await.unwrap();
        client
            .answer_loop_correction("correction", false)
            .await
            .unwrap();
        client.close().await.unwrap();
    })
    .await
    .unwrap();
    service.close().await;
}

#[tokio::test]
async fn goal_lifecycle() {
    let mut service = Service::new().await;
    service.control("goal-wait").await;
    assert_eq!(service.event().await["event"], "goal-wait");
    timeout(service.deadline(), async {
        let mut client = service.client().await;
        let envelope = EngineCommand::new(
            uuid::Uuid::new_v4().to_string(),
            GoalCommand::submit(
                "Return checked answer".into(),
                vec!["Deliver Goal answer".into()],
                GoalGrant {
                    id: "delegation".into(),
                    version: 1,
                },
            ),
        );
        assert!(
            client
                .request(&envelope.request_id)
                .await
                .unwrap()
                .is_none()
        );
        let receipt = client.execute(&envelope).await.unwrap();
        assert_eq!(client.execute(&envelope).await.unwrap(), receipt);
        assert_eq!(
            client.request(&envelope.request_id).await.unwrap(),
            Some(receipt.clone())
        );
        let mut observer = service
            .client()
            .await
            .observe_goal(&receipt.goal_id)
            .await
            .unwrap();
        loop {
            if observer.state().unwrap()["snapshot"]["status"] == "waiting_user" {
                break;
            }
            observer.next().await.unwrap();
        }
        observer.close().await.unwrap();
        let waiting = client.snapshot(&receipt.goal_id).await.unwrap();
        assert_eq!(waiting.status, GoalStatus::WaitingUser);
        assert_eq!(
            client
                .goal_for_conversation(waiting.conversation_id)
                .await
                .unwrap(),
            Some(waiting.clone())
        );
        assert_eq!(
            client.goals(1, None).await.unwrap().goals,
            vec![waiting.clone()]
        );
        assert!(
            client
                .summaries()
                .await
                .unwrap()
                .iter()
                .any(|summary| summary.id == waiting.conversation_id)
        );
        let bypass = client
            .invoke(
                "chopin.conversation",
                json!({"conversation":waiting.conversation_id}),
                "submit",
                Some(json!({"text":"bypass"})),
            )
            .await
            .unwrap_err();
        assert!(matches!(bypass, ProtocolError::Method { .. }));
        let changed = EngineCommand::new(
            envelope.request_id.clone(),
            GoalCommand::submit(
                "Different objective".into(),
                vec![],
                GoalGrant {
                    id: "delegation".into(),
                    version: 1,
                },
            ),
        );
        let error = client.execute(&changed).await.unwrap_err();
        assert_eq!(
            error.command_rejection().unwrap().as_str(),
            "request_conflict"
        );
        service.control("goal-continue").await;
        assert_eq!(service.event().await["event"], "goal-continue");
        let answer = EngineCommand::new(
            uuid::Uuid::new_v4().to_string(),
            GoalCommand::Input {
                goal_id: waiting.goal_id.clone(),
                expected_version: waiting.version,
                text: "Confirmed".into(),
                question_id: waiting.waiting.unwrap().question_id,
                grant: None,
            },
        );
        client.execute(&answer).await.unwrap();
        let mut finished = service
            .client()
            .await
            .observe_goal(&receipt.goal_id)
            .await
            .unwrap();
        loop {
            if finished.state().unwrap()["snapshot"]["status"] == "completed" {
                break;
            }
            finished.next().await.unwrap();
        }
        finished.close().await.unwrap();
        let result = client.snapshot(&receipt.goal_id).await.unwrap();
        assert_eq!(result.status, GoalStatus::Completed);
        assert_eq!(result.result.unwrap().evidence.len(), 1);
        assert!(
            client
                .request(&envelope.request_id)
                .await
                .unwrap()
                .is_some()
        );
        client.resume().await.unwrap();
        client.wake().await.unwrap();
        client.close().await.unwrap();
    })
    .await
    .unwrap();
    service.close().await;
}

#[tokio::test]
async fn goal_recovery() {
    let mut service = Service::new().await;
    service.control("goal-wait").await;
    service.event().await;
    let envelope = EngineCommand::new(
        uuid::Uuid::new_v4().to_string(),
        GoalCommand::submit(
            "Return checked answer".into(),
            vec!["Deliver Goal answer".into()],
            GoalGrant {
                id: "delegation".into(),
                version: 1,
            },
        ),
    );
    let mut client = service.client().await;
    let receipt = client.execute(&envelope).await.unwrap();
    let mut source = service
        .client()
        .await
        .observe_goal(&receipt.goal_id)
        .await
        .unwrap();
    timeout(service.deadline(), async {
        while source.state().unwrap()["snapshot"]["status"] != "waiting_user" {
            source.next().await.unwrap();
        }
    })
    .await
    .unwrap();
    let original = client.snapshot(&receipt.goal_id).await.unwrap();
    let directory = service.kill().await;
    let _ = source.close().await;
    let _ = client.close().await;
    let reopened = Service::open(directory).await;
    timeout(reopened.deadline(), async {
        let mut client = reopened.client().await;
        assert_eq!(client.snapshot(&receipt.goal_id).await.unwrap(), original);
        assert_eq!(client.execute(&envelope).await.unwrap(), receipt);
        client
            .execute(&EngineCommand::new(
                uuid::Uuid::new_v4().to_string(),
                GoalCommand::Input {
                    goal_id: receipt.goal_id.clone(),
                    expected_version: original.version,
                    text: "Confirmed after restart".into(),
                    question_id: original.waiting.unwrap().question_id,
                    grant: None,
                },
            ))
            .await
            .unwrap();
        let mut observer = reopened
            .client()
            .await
            .observe_goal(&receipt.goal_id)
            .await
            .unwrap();
        while observer.state().unwrap()["snapshot"]["status"] != "completed" {
            observer.next().await.unwrap();
        }
        observer.close().await.unwrap();
        let goal = client.snapshot(&receipt.goal_id).await.unwrap();
        assert_eq!(goal.conversation_id, original.conversation_id);
        assert_eq!(goal.objective, original.objective);
        client.close().await.unwrap();
    })
    .await
    .unwrap();
    reopened.close().await;
}

#[tokio::test]
async fn review_recovery() {
    let directory = std::env::temp_dir().join(format!("review-interop-{}", uuid::Uuid::new_v4()));
    let mut service = Service::start(directory, Some("reviewer")).await;
    let envelope = EngineCommand::new(
        uuid::Uuid::new_v4().to_string(),
        GoalCommand::submit(
            "Return checked answer".into(),
            vec!["Deliver Goal answer".into()],
            GoalGrant {
                id: "delegation".into(),
                version: 1,
            },
        ),
    );
    let mut client = service.client().await;
    let receipt = client.execute(&envelope).await.unwrap();
    let ready = timeout(service.deadline(), service.event()).await.unwrap();
    assert_eq!(ready["event"], "review-ready");
    assert_eq!(ready["workerCalls"], 1);
    assert_eq!(ready["reviewerCalls"], 2);
    assert_eq!(ready["model"], "reviewer");
    let original = client.snapshot(&receipt.goal_id).await.unwrap();
    assert_eq!(original.status, GoalStatus::Running);
    let directory = service.kill().await;
    let _ = client.close().await;
    let mut reopened = Service::start(directory, Some("replacement")).await;
    timeout(reopened.deadline(), async {
        let mut client = reopened.client().await;
        assert_eq!(client.execute(&envelope).await.unwrap(), receipt);
        let resumed = reopened.event().await;
        assert_eq!(resumed["event"], "review-ready");
        assert_eq!(resumed["entry"], ready["entry"]);
        assert_eq!(resumed["workerCalls"], 0);
        assert_eq!(resumed["reviewerCalls"], 1);
        assert_eq!(resumed["model"], "reviewer");
        reopened.control("review-release").await;
        assert_eq!(reopened.event().await["event"], "review-released");
        let mut observer = reopened
            .client()
            .await
            .observe_goal(&receipt.goal_id)
            .await
            .unwrap();
        while observer.state().unwrap()["snapshot"]["status"] != "completed" {
            observer.next().await.unwrap();
        }
        observer.close().await.unwrap();
        let goal = client.snapshot(&receipt.goal_id).await.unwrap();
        assert_eq!(goal.conversation_id, original.conversation_id);
        assert_eq!(goal.objective, original.objective);
        assert_eq!(goal.result.unwrap().evidence.len(), 1);
        client.close().await.unwrap();
    })
    .await
    .unwrap();
    reopened.close().await;
}

#[tokio::test]
async fn review_retry() {
    let directory = std::env::temp_dir().join(format!("review-retry-{}", uuid::Uuid::new_v4()));
    let mut service = Service::start(directory, Some("reviewer")).await;
    service.control("review-retry").await;
    assert_eq!(service.event().await["event"], "review-retry");
    let envelope = EngineCommand::new(
        uuid::Uuid::new_v4().to_string(),
        GoalCommand::submit(
            "Return checked answer".into(),
            vec!["Deliver Goal answer".into()],
            GoalGrant {
                id: "delegation".into(),
                version: 1,
            },
        ),
    );
    let mut client = service.client().await;
    let receipt = client.execute(&envelope).await.unwrap();
    let mut observer = service
        .client()
        .await
        .observe_goal(&receipt.goal_id)
        .await
        .unwrap();
    timeout(service.deadline(), async {
        while observer.state().unwrap()["snapshot"]["status"] != "waiting_dependency" {
            observer.next().await.unwrap();
        }
    })
    .await
    .unwrap();
    let original = client.snapshot(&receipt.goal_id).await.unwrap();
    assert!(original.waiting.as_ref().unwrap().until.is_some());
    let directory = service.kill().await;
    let _ = client.close().await;
    let _ = observer.close().await;
    let mut reopened = Service::start(directory, Some("replacement")).await;
    let mut client = reopened.client().await;
    assert_eq!(client.execute(&envelope).await.unwrap(), receipt);
    let pending = client.snapshot(&receipt.goal_id).await.unwrap();
    assert_eq!(pending.waiting, original.waiting);
    let ready = timeout(reopened.deadline(), reopened.event())
        .await
        .unwrap();
    assert_eq!(ready["event"], "review-ready");
    assert_eq!(ready["workerCalls"], 0);
    assert_eq!(ready["reviewerCalls"], 2);
    assert_eq!(ready["model"], "reviewer");
    reopened.control("review-release").await;
    assert_eq!(reopened.event().await["event"], "review-released");
    let mut observer = reopened
        .client()
        .await
        .observe_goal(&receipt.goal_id)
        .await
        .unwrap();
    timeout(reopened.deadline(), async {
        while observer.state().unwrap()["snapshot"]["status"] != "completed" {
            observer.next().await.unwrap();
        }
    })
    .await
    .unwrap();
    assert_eq!(
        client
            .snapshot(&receipt.goal_id)
            .await
            .unwrap()
            .conversation_id,
        original.conversation_id
    );
    observer.close().await.unwrap();
    client.close().await.unwrap();
    reopened.close().await;
}
