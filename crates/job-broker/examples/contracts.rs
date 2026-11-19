//! Export concrete command wire values from the Rust authority's actual types.

use std::{collections::BTreeMap, error::Error, path::Path};

use chopin_job_broker::{
    ExitStatus, GrantReference, OutputPage, Phase, ProcessIdentity, Request, Snapshot, Source,
    State, Stream,
};
use serde_json::json;
use uuid::Uuid;

fn main() -> Result<(), Box<dyn Error>> {
    let domain = Uuid::from_u128(1);
    let operation = Uuid::from_u128(2);
    let scope = Uuid::from_u128(3);
    let tool = Request {
        version: 1,
        domain,
        source: Source::Tool {
            goal_id: "original-goal".into(),
            conversation_id: 1,
            task_id: 2,
            call_id: "original-call".into(),
        },
        grant: GrantReference {
            id: Uuid::from_u128(4),
            version: 1,
        },
        argv: vec!["sh".into(), "-c".into(), "printf '%s' \"$MESSAGE\"".into()],
        cwd: "/workspace".into(),
        env: BTreeMap::from([("MESSAGE".into(), "hello 世界".into())]),
        inherit_env: false,
        timeout_ms: None,
        policy_revision: "fixture-policy".into(),
    };
    tool.validate()?;
    let learning = Request {
        source: Source::Learning {
            run_id: Uuid::from_u128(5),
        },
        timeout_ms: Some(1),
        ..tool.clone()
    };
    learning.validate()?;
    let snapshots: Vec<_> = [
        Phase::Pending,
        Phase::Reserved,
        Phase::Attached,
        Phase::Running,
        Phase::Exited,
        Phase::Drained,
    ]
    .into_iter()
    .map(|phase| {
        let attached = matches!(
            phase,
            Phase::Attached | Phase::Running | Phase::Exited | Phase::Drained
        );
        let released = matches!(phase, Phase::Running | Phase::Exited | Phase::Drained);
        let exited = matches!(phase, Phase::Exited | Phase::Drained);
        Snapshot {
            scope_id: scope,
            operation_id: operation,
            state: State {
                version: 1,
                phase,
                stop_requested: phase == Phase::Drained,
                worker: (phase != Phase::Pending).then_some(Uuid::from_u128(6)),
                process: attached.then_some(ProcessIdentity {
                    domain,
                    boot: Uuid::from_u128(7),
                    init_pid: 1,
                    start_ticks: 2,
                    namespace_inode: 3,
                }),
                released,
                started: released,
                primary_exit: exited.then_some(if phase == Phase::Drained {
                    ExitStatus::Signal(15)
                } else {
                    ExitStatus::Code(0)
                }),
                output_complete: phase == Phase::Drained,
                last_sequence: u64::from(released),
            },
        }
    })
    .collect();
    let output = [
        OutputPage {
            stream: Some(Stream::Stdout),
            data: "AP8K".into(),
            cursor: "original-cursor".into(),
            complete: false,
        },
        OutputPage {
            stream: Some(Stream::Stderr),
            data: "ZGlhZ25vc3RpYw".into(),
            cursor: "stderr-cursor".into(),
            complete: true,
        },
        OutputPage {
            stream: None,
            data: String::new(),
            cursor: "end-cursor".into(),
            complete: true,
        },
    ];
    let serialized = serde_json::to_string_pretty(&json!({
        "requests": [tool, learning], "snapshots": snapshots, "output": output,
    }))? + "\n";
    if std::env::args().any(|arg| arg == "--check") {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("contracts.json");
        if std::fs::read_to_string(path)? != serialized {
            return Err("regenerate command fixtures from the current Rust authority".into());
        }
    } else {
        print!("{serialized}");
    }
    Ok(())
}
