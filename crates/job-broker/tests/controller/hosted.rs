//! Production worker executable against actual namespaces, callbacks and transactional output.

use super::*;

#[tokio::test]
#[ignore = "requires real native isolation and an isolated transactional database"]
async fn executable_roundtrip() {
    roundtrip(NetworkMode::Isolated).await;
}

#[tokio::test]
#[ignore = "requires a verified provider-isolated network and an isolated transactional database"]
async fn inherited_network_roundtrip() {
    roundtrip(NetworkMode::Inherited).await;
}

async fn roundtrip(network: NetworkMode) {
    let mut f = Fixture::prepare_network(true, network).await;
    let id = Uuid::new_v4();
    let request = f.request(
        r#"import os,pathlib,sys
assert 'CHOPIN_WORKER_JOURNAL_KEY' not in os.environ
assert 'CHOPIN_WORKER_OUTPUT_KEY' not in os.environ
assert 'CHOPIN_WORKER_TOKEN' not in os.environ
pathlib.Path('/workspace/effect').write_text('once')
sys.stdout.buffer.write(bytes(range(256)))
sys.stderr.write(os.environ['PROFILE_VALUE'])
"#,
    );
    f.broker.submit(&f.caller, id, &request).await.unwrap();
    f.broker.submit(&f.caller, id, &request).await.unwrap();
    let original = f.done(id).await;
    let output = f.output(id).await;
    let startup = if original.state.primary_exit != Some(ExitStatus::Code(0)) {
        format!("{:?}", f.startup_output(id).await)
    } else {
        String::new()
    };
    assert_eq!(
        original.state.primary_exit,
        Some(ExitStatus::Code(0)),
        "launcher output: {}; retained startup capture: {startup}",
        String::from_utf8_lossy(&output.1)
    );
    assert!(original.state.output_complete && original.state.started);
    assert_eq!(output, ((0_u8..=255).collect(), b"original".to_vec()));
    f.graceful().await;
    f.start().await;
    assert_eq!(f.broker.get(&f.caller, id).await.unwrap(), original);
    assert_eq!(
        fs::read(f.config.root.join("workspace/effect")).unwrap(),
        b"once"
    );
    f.graceful().await;
    f.close().await;
}

#[tokio::test]
#[ignore = "requires real native isolation and an isolated transactional database"]
async fn executable_recovers_original_process() {
    recovery(NetworkMode::Isolated).await;
}

#[tokio::test]
#[ignore = "requires a verified provider-isolated network and an isolated transactional database"]
async fn inherited_network_recovery() {
    recovery(NetworkMode::Inherited).await;
}

async fn recovery(network: NetworkMode) {
    let mut f = Fixture::prepare_network(true, network).await;
    let id = Uuid::new_v4();
    rustix::fs::mkfifoat(
        rustix::fs::CWD,
        f.config.root.join("workspace/input"),
        rustix::fs::Mode::RUSR | rustix::fs::Mode::WUSR,
    )
    .unwrap();
    f.faults.lose_output.store(true, Ordering::SeqCst);
    let request = f.request(r#"import os,pathlib,sys; p=pathlib.Path('/workspace/effect'); p.write_text('once'); sys.stdout.write('before\n'); sys.stdout.flush(); data=open('/workspace/input','rb').read(); sys.stdout.buffer.write(data); sys.stderr.write(os.environ['PROFILE_VALUE'])"#);
    f.broker.submit(&f.caller, id, &request).await.unwrap();
    timeout(deadline(), f.faults.committed.notified())
        .await
        .unwrap();
    let before = f.broker.get(&f.caller, id).await.unwrap();
    let original = before.state.process.unwrap();
    assert_eq!(before.state.last_sequence, 1);
    f.kill().await;
    assert!(matches!(
        NamespaceProcess::open(&f.config.host, &original).unwrap(),
        ProcessObservation::Alive(_)
    ));
    f.config
        .profile
        .environment
        .insert("PROFILE_VALUE".into(), "replacement".into());
    f.config.profile.network = match network {
        NetworkMode::Isolated => NetworkMode::Inherited,
        NetworkMode::Inherited => NetworkMode::Isolated,
    };
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
    assert!(matches!(observation.state, WorkerState::Running { process } if process == original));
    let mut input = OpenOptions::new()
        .write(true)
        .open(f.config.root.join("workspace/input"))
        .unwrap();
    input.write_all(b"after restart").unwrap();
    drop(input);
    let done = f.done(id).await;
    assert_eq!(done.state.process, Some(original));
    assert_eq!(done.state.primary_exit, Some(ExitStatus::Code(0)));
    assert_eq!(
        f.output(id).await,
        (b"before\nafter restart".to_vec(), b"original".to_vec())
    );
    assert_eq!(
        fs::read(f.config.root.join("workspace/effect")).unwrap(),
        b"once"
    );
    f.graceful().await;
    f.close().await;
}
