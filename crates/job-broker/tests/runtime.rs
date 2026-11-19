//! Real namespace, gate and process-handle checks. No namespace observation is mocked.
#![cfg(all(feature = "worker", target_os = "linux"))]
#![allow(clippy::unwrap_used, clippy::expect_used)]

use base64::{Engine as _, prelude::BASE64_URL_SAFE_NO_PAD};
use chopin_job_broker::{
    Error, ExitStatus, JobId, JobKey, ProcessIdentity, Stream,
    runtime::{
        CaptureOptions, GateCommand, GateRecord, HostIdentity, Namespace, NamespaceConfig,
        NamespaceProcess, NetworkMode, OutputReader, ProcessObservation,
    },
};
use std::{collections::BTreeMap, fs, num::NonZeroUsize, path::PathBuf, sync::Arc, time::Duration};
use tokio::time::{sleep, timeout};
use uuid::Uuid;

#[cfg(feature = "transport")]
#[path = "runtime/delivery.rs"]
mod delivery;

fn deadline() -> Duration {
    let metadata: serde_json::Value =
        serde_json::from_str(include_str!("../../protocol/contracts.json")).unwrap();
    Duration::from_millis(metadata["callTimeoutMs"].as_u64().unwrap())
}
struct Fixture {
    base: PathBuf,
    host: HostIdentity,
    namespace: Namespace,
    process: Option<NamespaceProcess>,
    capture: CaptureOptions,
}
impl Fixture {
    fn new() -> Self {
        Self::limited(NonZeroUsize::new(4096).unwrap())
    }
    fn limited(maximum: NonZeroUsize) -> Self {
        Self::configured(maximum, |_, _| {})
    }
    fn configured(
        maximum: NonZeroUsize,
        configure: impl FnOnce(&std::path::Path, &mut NamespaceConfig),
    ) -> Self {
        Self::rooted(&std::env::temp_dir(), maximum, configure)
    }
    fn rooted(
        root: &std::path::Path,
        maximum: NonZeroUsize,
        configure: impl FnOnce(&std::path::Path, &mut NamespaceConfig),
    ) -> Self {
        assert_ne!(
            rustix::process::geteuid().as_raw(),
            0,
            "namespace checks must run without root privileges"
        );
        let base = root.join(format!("namespace-{}", Uuid::new_v4()));
        let private = base.join("private");
        let directory = private.join("operation");
        let workspace = base.join("workspace");
        fs::create_dir_all(&directory).unwrap();
        fs::create_dir_all(&workspace).unwrap();
        fs::write(private.join("canary"), b"private fixture data").unwrap();
        let read_only = ["/usr", "/bin", "/lib", "/lib64"]
            .into_iter()
            .map(PathBuf::from)
            .filter(|path| path.exists())
            .collect();
        let mut config = NamespaceConfig {
            network: NetworkMode::Isolated,
            launcher: "/usr/local/bin/bwrap".into(),
            gate: env!("CARGO_BIN_EXE_chopin-job-gate").into(),
            capture: env!("CARGO_BIN_EXE_chopin-job-capture").into(),
            private_root: private,
            workspace,
            read_only,
            environment: BTreeMap::new(),
        };
        configure(&base, &mut config);
        let host = HostIdentity::current(Uuid::new_v4()).unwrap();
        let capture = capture_options(
            JobId {
                scope: Uuid::new_v4(),
                operation: Uuid::new_v4(),
            },
            Uuid::new_v4(),
        );
        let namespace = Namespace::spawn(&config, &directory, &host, maximum, &capture).unwrap();
        Self {
            base,
            host,
            namespace,
            process: None,
            capture,
        }
    }
    async fn ready(&mut self) -> ProcessIdentity {
        timeout(deadline(), async {
            loop {
                let records = self.namespace.records().unwrap();
                if let Some(GateRecord::Ready { process }) = records.first() {
                    if !self.namespace.output_ready().unwrap() {
                        sleep(Duration::from_millis(1)).await;
                        continue;
                    }
                    let process = process.clone();
                    let ProcessObservation::Alive(handle) =
                        NamespaceProcess::open(&self.host, &process).unwrap()
                    else {
                        panic!("gate exited before release");
                    };
                    self.process = Some(handle);
                    return process;
                }
                if let Some(status) = self.namespace.try_wait().unwrap() {
                    panic!("launcher failed: {status}");
                }
                sleep(Duration::from_millis(1)).await;
            }
        })
        .await
        .unwrap()
    }
    fn command(&self, argv: Vec<String>) -> GateCommand {
        GateCommand {
            version: 1,
            argv,
            cwd: "/workspace".into(),
            env: BTreeMap::new(),
        }
    }
    async fn ended(&mut self) -> std::process::ExitStatus {
        timeout(deadline(), self.namespace.wait())
            .await
            .unwrap()
            .unwrap()
    }
    async fn stdout(&self) -> Vec<u8> {
        read_output(self.namespace.output(), Stream::Stdout).await
    }
}
fn capture_options(id: JobId, worker: Uuid) -> CaptureOptions {
    CaptureOptions {
        id,
        worker,
        frame_bytes: NonZeroUsize::new(4096).unwrap(),
        key: Arc::new(JobKey::new([42; 32])),
    }
}
async fn read_output(reader: &OutputReader, stream: Stream) -> Vec<u8> {
    let last = timeout(deadline(), async {
        loop {
            if let Some(last) = reader.complete().unwrap() {
                break last;
            }
            sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap();
    let mut bytes = Vec::new();
    for sequence in 1..=last {
        let frame = reader.frame(sequence).unwrap().unwrap();
        if frame.stream == stream {
            bytes.extend(BASE64_URL_SAFE_NO_PAD.decode(frame.data).unwrap());
        }
    }
    bytes
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.namespace.refuse();
        if let Some(process) = &self.process {
            let _ = process.terminate();
        }
    }
}

#[tokio::test]
async fn explicit_release() {
    let mut f = Fixture::new();
    let identity = f.ready().await;
    assert!(!f.base.join("workspace/executed").exists());
    let command = f.command(vec![
        "/bin/sh".into(),
        "-c".into(),
        "printf approved > executed; printf output".into(),
    ]);
    f.namespace.release(&command).await.unwrap();
    assert!(f.ended().await.success());
    timeout(deadline(), f.process.as_ref().unwrap().wait())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(f.stdout().await, b"output");
    assert_eq!(
        chopin_job_broker::runtime::read_exit(f.namespace.directory(), &identity).unwrap(),
        Some(ExitStatus::Code(0))
    );
    assert_eq!(
        fs::read(f.base.join("workspace/executed")).unwrap(),
        b"approved"
    );
    assert_eq!(
        f.namespace.records().unwrap(),
        vec![
            GateRecord::Ready {
                process: identity.clone()
            },
            GateRecord::Released {
                digest: command.digest().unwrap()
            }
        ]
    );
    assert!(matches!(
        NamespaceProcess::open(&f.host, &identity).unwrap(),
        ProcessObservation::Exited
    ));
}

#[tokio::test]
async fn network_boundary() {
    let original = fs::read_link("/proc/self/ns/net").unwrap();
    for network in [NetworkMode::Isolated, NetworkMode::Inherited] {
        let mut f = Fixture::configured(NonZeroUsize::new(4096).unwrap(), |_, config| {
            config.network = network;
        });
        f.ready().await;
        let command = f.command(vec!["/usr/bin/readlink".into(), "/proc/self/ns/net".into()]);
        f.namespace.release(&command).await.unwrap();
        assert!(f.ended().await.success());
        timeout(deadline(), f.process.as_ref().unwrap().wait())
            .await
            .unwrap()
            .unwrap();
        let observed = String::from_utf8(f.stdout().await).unwrap();
        assert_eq!(
            observed.trim() == original.to_str().unwrap(),
            network == NetworkMode::Inherited
        );
    }
}

#[tokio::test]
async fn closed_gate() {
    let mut f = Fixture::new();
    f.ready().await;
    f.namespace.refuse();
    assert!(!f.ended().await.success());
    assert!(matches!(
        f.namespace.records().unwrap().as_slice(),
        [GateRecord::Ready { .. }, GateRecord::Refused]
    ));
    timeout(deadline(), f.process.as_ref().unwrap().wait())
        .await
        .unwrap()
        .unwrap();
    assert!(f.stdout().await.is_empty());
}

#[tokio::test]
async fn private_state() {
    let mut f = Fixture::new();
    f.ready().await;
    assert!(std::env::var_os("PATH").is_some());
    let script = r#"import errno,json,os
fds=[]
for name in os.listdir('/proc/self/fd'):
 fd=int(name)
 try: os.fstat(fd)
 except OSError as error:
  if error.errno==errno.EBADF: continue
  raise
 if fd>2: fds.append(fd)
print(json.dumps({'fds':fds,'env':dict(os.environ),'stdin':os.readlink('/proc/self/fd/0'),'private':os.path.exists(os.environ['PRIVATE_PATH'])}))
"#;
    let mut command = f.command(vec!["/usr/bin/python3".into(), "-c".into(), script.into()]);
    command.env.insert("APP_ALLOWED".into(), "approved".into());
    command.env.insert(
        "PRIVATE_PATH".into(),
        f.base.join("private/canary").to_string_lossy().into_owned(),
    );
    f.namespace.release(&command).await.unwrap();
    assert!(f.ended().await.success());
    let observed: serde_json::Value = serde_json::from_slice(&f.stdout().await).unwrap();
    assert_eq!(observed["fds"], serde_json::json!([]));
    assert_eq!(observed["env"]["APP_ALLOWED"], "approved");
    assert!(observed["env"].get("PATH").is_none());
    assert!(observed["env"].get("PWD").is_none());
    assert_eq!(observed["stdin"], "/dev/null");
    assert_eq!(observed["private"], false);
    assert_eq!(
        fs::read(f.base.join("private/canary")).unwrap(),
        b"private fixture data"
    );
}

#[tokio::test]
async fn descendants() {
    let mut f = Fixture::new();
    let identity = f.ready().await;
    let script = r#"import os,signal
if os.fork()==0:
 os.setsid()
 if os.fork()==0:
  with open('/workspace/descendant','w') as f: f.write(str(os.getpid()))
  while True: signal.pause()
 os._exit(0)
os._exit(0)
"#;
    let command = f.command(vec!["/usr/bin/python3".into(), "-c".into(), script.into()]);
    f.namespace.release(&command).await.unwrap();
    assert!(f.ended().await.success());
    timeout(deadline(), async {
        while !f.base.join("workspace/descendant").exists() {
            sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap();
    let process = f.process.as_ref().unwrap();
    assert!(!process.has_exited().unwrap());
    assert_eq!(f.namespace.output().complete().unwrap(), None);
    assert!(matches!(
        NamespaceProcess::open(&f.host, &identity).unwrap(),
        ProcessObservation::Alive(_)
    ));
    process.terminate().unwrap();
    timeout(deadline(), process.wait()).await.unwrap().unwrap();
    assert!(f.stdout().await.is_empty());
    assert!(matches!(
        NamespaceProcess::open(&f.host, &identity).unwrap(),
        ProcessObservation::Exited
    ));
}

#[tokio::test]
async fn original_identity() {
    let mut f = Fixture::new();
    let identity = f.ready().await;
    let mut other = identity.clone();
    other.start_ticks += 1;
    assert!(matches!(
        NamespaceProcess::open(&f.host, &other),
        Err(Error::Conflict)
    ));
    let mut host = f.host.clone();
    host.pid_namespace_inode += 1;
    assert!(matches!(
        NamespaceProcess::open(&host, &identity),
        Err(Error::Conflict)
    ));
    let mut other = identity;
    other.domain = Uuid::new_v4();
    assert!(matches!(
        NamespaceProcess::open(&f.host, &other),
        Err(Error::Conflict)
    ));
    assert!(!f.process.as_ref().unwrap().has_exited().unwrap());
    f.namespace.refuse();
    f.ended().await;
}

fn gate_pid(identity: &ProcessIdentity) -> rustix::process::Pid {
    let children = fs::read_to_string(format!(
        "/proc/{}/task/{}/children",
        identity.init_pid, identity.init_pid
    ))
    .unwrap();
    let children = children.split_whitespace().collect::<Vec<_>>();
    assert_eq!(children.len(), 1);
    rustix::process::Pid::from_raw(children[0].parse().unwrap()).unwrap()
}
fn gate_input(pid: rustix::process::Pid) -> std::fs::File {
    std::fs::OpenOptions::new()
        .write(true)
        .open(format!("/proc/{}/fd/0", pid.as_raw_nonzero()))
        .unwrap()
}

#[tokio::test]
async fn malformed_release() {
    use std::io::Write;
    for kind in ["permission", "truncated", "extra", "bounded"] {
        let command = GateCommand {
            version: 1,
            argv: vec![
                "/bin/sh".into(),
                "-c".into(),
                "printf executed > executed".into(),
            ],
            cwd: "/workspace".into(),
            env: BTreeMap::new(),
        };
        let bytes = serde_json::to_vec(&command).unwrap();
        let bound = if kind == "bounded" {
            bytes.len() - 1
        } else {
            bytes.len() + 1
        };
        let mut f = Fixture::limited(NonZeroUsize::new(bound).unwrap());
        let identity = f.ready().await;
        let mut input = gate_input(gate_pid(&identity));
        f.namespace.refuse();
        let mut message = vec![if kind == "permission" { 0 } else { 1 }];
        message.extend_from_slice(&bytes);
        if kind == "truncated" {
            message.pop();
        }
        if kind == "extra" {
            message.push(b'!');
        }
        input.write_all(&message).unwrap();
        drop(input);
        assert!(!f.ended().await.success(), "accepted {kind} input");
        assert!(!f.base.join("workspace/executed").exists());
        assert!(matches!(
            f.namespace.records().unwrap().as_slice(),
            [GateRecord::Ready { .. }, GateRecord::Refused]
        ));
    }
}

#[tokio::test]
async fn cancelled_input() {
    use rustix::process::{PidfdFlags, Signal, pidfd_open, pidfd_send_signal};
    let capacity: usize = fs::read_to_string("/proc/sys/fs/pipe-max-size")
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    let mut command = GateCommand {
        version: 1,
        argv: vec![
            "/bin/sh".into(),
            "-c".into(),
            "printf executed > executed".into(),
        ],
        cwd: "/workspace".into(),
        env: BTreeMap::new(),
    };
    command.env.insert(
        "PAYLOAD".into(),
        "a".repeat(capacity.checked_mul(2).unwrap()),
    );
    let bytes = serde_json::to_vec(&command).unwrap().len();
    let mut f = Fixture::limited(NonZeroUsize::new(bytes).unwrap());
    let identity = f.ready().await;
    let pid = gate_pid(&identity);
    let descriptor = pidfd_open(pid, PidfdFlags::empty()).unwrap();
    pidfd_send_signal(&descriptor, Signal::STOP).unwrap();
    let pipe = std::fs::File::open(format!("/proc/{}/fd/0", pid.as_raw_nonzero())).unwrap();
    {
        let sending = f.namespace.release(&command);
        tokio::pin!(sending);
        timeout(deadline(),async {
            loop {
                tokio::select! {
                    result=&mut sending=>panic!("release completed while the gate was stopped: {result:?}"),
                    _=sleep(Duration::from_millis(1))=>{
                        let queued=rustix::io::ioctl_fionread(&pipe).unwrap();
                        if queued>1 { assert!(queued<(bytes+1) as u64);break; }
                    }
                }
            }
        }).await.unwrap();
    }
    drop(pipe);
    pidfd_send_signal(&descriptor, Signal::CONT).unwrap();
    assert!(!f.ended().await.success());
    assert!(!f.base.join("workspace/executed").exists());
    assert!(matches!(
        f.namespace.records().unwrap().as_slice(),
        [GateRecord::Ready { .. }, GateRecord::Refused]
    ));
    assert!(matches!(
        f.namespace.release(&command).await,
        Err(Error::Conflict)
    ));
}

#[tokio::test]
async fn cancelled_wait() {
    let mut f = Fixture::new();
    f.ready().await;
    let process = f.process.as_ref().unwrap();
    {
        let waiting = process.wait();
        tokio::pin!(waiting);
        assert!(futures_util::poll!(&mut waiting).is_pending());
    }
    assert!(!process.has_exited().unwrap());
    process.terminate().unwrap();
    timeout(deadline(), process.wait()).await.unwrap().unwrap();
    assert!(process.has_exited().unwrap());
}

#[tokio::test]
async fn pinned_workspace() {
    use std::os::unix::fs::PermissionsExt;
    let mut f = Fixture::configured(NonZeroUsize::new(4096).unwrap(), |base, config| {
        let workspace = serde_json::to_string(config.workspace.to_str().unwrap()).unwrap();
        let moved = serde_json::to_string(base.join("workspace-moved").to_str().unwrap()).unwrap();
        let private = serde_json::to_string(config.private_root.to_str().unwrap()).unwrap();
        fs::write(config.workspace.join("approved"), b"original workspace").unwrap();
        let launcher = base.join("launcher");
        fs::write(&launcher,format!("#!/usr/bin/python3\nimport os,sys\nos.rename({workspace},{moved})\nos.symlink({private},{workspace})\nos.execv('/usr/local/bin/bwrap',['bwrap',*sys.argv[1:]])\n")).unwrap();
        fs::set_permissions(&launcher, fs::Permissions::from_mode(0o755)).unwrap();
        config.launcher = launcher;
    });
    f.ready().await;
    let script = "import json,pathlib; print(json.dumps({'approved':pathlib.Path('/workspace/approved').read_text(),'private':pathlib.Path('/workspace/canary').exists()}))";
    let command = f.command(vec!["/usr/bin/python3".into(), "-c".into(), script.into()]);
    f.namespace.release(&command).await.unwrap();
    assert!(f.ended().await.success());
    let result: serde_json::Value = serde_json::from_slice(&f.stdout().await).unwrap();
    assert_eq!(
        result,
        serde_json::json!({"approved":"original workspace","private":false})
    );
    assert_eq!(
        fs::read(f.base.join("private/canary")).unwrap(),
        b"private fixture data"
    );
}

#[tokio::test]
async fn readonly_mount() {
    let mut readonly = PathBuf::new();
    let mut f = Fixture::rooted(
        std::path::Path::new("/var/tmp"),
        NonZeroUsize::new(4096).unwrap(),
        |base, config| {
            readonly = base.join("readonly");
            fs::create_dir(&readonly).unwrap();
            fs::write(readonly.join("input"), b"approved data").unwrap();
            config.read_only.push(readonly.clone());
        },
    );
    f.ready().await;
    let script = r#"import errno,json,pathlib,sys
path=pathlib.Path(sys.argv[1])
value=path.read_text()
try:
 path.write_text('changed')
 error=0
except OSError as failure: error=failure.errno
print(json.dumps({'value':value,'readonly':error==errno.EROFS}))
"#;
    let command = f.command(vec![
        "/usr/bin/python3".into(),
        "-c".into(),
        script.into(),
        readonly.join("input").to_string_lossy().into_owned(),
    ]);
    f.namespace.release(&command).await.unwrap();
    assert!(f.ended().await.success());
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&f.stdout().await).unwrap(),
        serde_json::json!({"value":"approved data","readonly":true})
    );
    assert_eq!(fs::read(readonly.join("input")).unwrap(), b"approved data");
    fs::write(readonly.join("input"), b"host still owns this file").unwrap();
}

#[tokio::test]
async fn private_network() {
    use std::os::unix::fs::MetadataExt;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let host_namespace = fs::metadata("/proc/self/ns/net").unwrap().ino();
    let mut f = Fixture::new();
    f.ready().await;
    let script = r#"import errno,json,os,socket,sys
try:
 connection=socket.create_connection(('127.0.0.1',int(sys.argv[1])),timeout=float(sys.argv[2]))
 connection.close()
 blocked=False
except OSError as error:
 blocked=error.errno in (errno.ECONNREFUSED,errno.ENETUNREACH,errno.EHOSTUNREACH)
print(json.dumps({'namespace':os.stat('/proc/self/ns/net').st_ino,'blocked':blocked}))
"#;
    let command = f.command(vec![
        "/usr/bin/python3".into(),
        "-c".into(),
        script.into(),
        port.to_string(),
        deadline().as_secs_f64().to_string(),
    ]);
    f.namespace.release(&command).await.unwrap();
    assert!(f.ended().await.success());
    let observed: serde_json::Value = serde_json::from_slice(&f.stdout().await).unwrap();
    assert_ne!(observed["namespace"].as_u64().unwrap(), host_namespace);
    assert_eq!(observed["blocked"], true);
}

#[tokio::test]
async fn gate_record_integrity() {
    use std::io::Write;
    let mut f = Fixture::new();
    f.ready().await;
    f.namespace.refuse();
    f.ended().await;
    let file = f.namespace.directory().join("gate.jsonl");
    let mut handle = fs::OpenOptions::new().append(true).open(&file).unwrap();
    handle.write_all(b"{").unwrap();
    handle.sync_all().unwrap();
    assert!(matches!(f.namespace.records(), Err(Error::Invalid)));
}

#[derive(serde::Serialize, serde::Deserialize)]
struct RestartRecord {
    base: PathBuf,
    host: HostIdentity,
    process: ProcessIdentity,
    id: JobId,
    worker: Uuid,
}

#[tokio::test]
#[ignore = "subprocess entry used by controller_restart"]
async fn controller_child() {
    let record = PathBuf::from(
        std::env::var_os("CHOPIN_TEST_CONTROL_RECORD").expect("controller fixture path required"),
    );
    let mut f = Fixture::new();
    let process = f.ready().await;
    nix::unistd::mkfifo(
        &f.base.join("workspace/input"),
        nix::sys::stat::Mode::S_IRUSR | nix::sys::stat::Mode::S_IWUSR,
    )
    .unwrap();
    let script = "import pathlib,sys; pathlib.Path('/workspace/started').write_text('running'); data=open('/workspace/input','rb').read(); sys.stdout.buffer.write(data); sys.stdout.buffer.flush()";
    let command = f.command(vec!["/usr/bin/python3".into(), "-c".into(), script.into()]);
    f.namespace.release(&command).await.unwrap();
    let data = RestartRecord {
        base: f.base.clone(),
        host: f.host.clone(),
        process,
        id: f.capture.id,
        worker: f.capture.worker,
    };
    let temporary = record.with_extension("pending");
    fs::write(&temporary, serde_json::to_vec(&data).unwrap()).unwrap();
    fs::File::open(&temporary).unwrap().sync_all().unwrap();
    fs::rename(&temporary, &record).unwrap();
    fs::File::open(record.parent().unwrap())
        .unwrap()
        .sync_all()
        .unwrap();
    std::future::pending::<()>().await;
}

struct ProcessCleanup(NamespaceProcess);
impl Drop for ProcessCleanup {
    fn drop(&mut self) {
        let _ = self.0.terminate();
    }
}

#[tokio::test]
async fn controller_restart() {
    use std::{io::Write, process::Stdio};
    let evidence = std::env::temp_dir().join(format!("controller-{}", Uuid::new_v4()));
    fs::create_dir(&evidence).unwrap();
    let record = evidence.join("ready.json");
    let mut child = tokio::process::Command::new(std::env::current_exe().unwrap())
        .args(["--ignored", "--exact", "controller_child", "--nocapture"])
        .env("CHOPIN_TEST_CONTROL_RECORD", &record)
        .stdout(Stdio::null())
        .stderr(fs::File::create(evidence.join("controller.log")).unwrap())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let data: RestartRecord = timeout(deadline(), async {
        loop {
            if record.exists() {
                break serde_json::from_slice(&fs::read(&record).unwrap()).unwrap();
            }
            assert!(
                child.try_wait().unwrap().is_none(),
                "controller exited before recording its process"
            );
            sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap();
    let ProcessObservation::Alive(handle) =
        NamespaceProcess::open(&data.host, &data.process).unwrap()
    else {
        panic!("original namespace missing");
    };
    let _cleanup = ProcessCleanup(handle);
    timeout(deadline(), async {
        while !data.base.join("workspace/started").exists() {
            sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap();
    child.start_kill().unwrap();
    assert!(
        !timeout(deadline(), child.wait())
            .await
            .unwrap()
            .unwrap()
            .success()
    );
    let ProcessObservation::Alive(recovered) =
        NamespaceProcess::open(&data.host, &data.process).unwrap()
    else {
        panic!("controller death terminated the command");
    };
    let mut input = fs::OpenOptions::new()
        .write(true)
        .open(data.base.join("workspace/input"))
        .unwrap();
    input.write_all(b"output after controller restart").unwrap();
    drop(input);
    timeout(deadline(), recovered.wait())
        .await
        .unwrap()
        .unwrap();
    let output = OutputReader::open(
        &data.base.join("private/operation"),
        &capture_options(data.id, data.worker),
    )
    .unwrap();
    assert_eq!(
        read_output(&output, Stream::Stdout).await,
        b"output after controller restart"
    );
    let facts =
        chopin_job_broker::runtime::read_records(&data.base.join("private/operation")).unwrap();
    assert!(
        matches!(facts.as_slice(),[GateRecord::Ready { process },GateRecord::Released { .. }] if process==&data.process)
    );
}

#[tokio::test]
async fn protected_init() {
    let mut f = Fixture::new();
    f.ready().await;
    let script = r#"import ctypes,errno,json,os
lib=ctypes.CDLL(None,use_errno=True)
resolver=ctypes.CDLL('libseccomp.so.2')
resolver.seccomp_syscall_resolve_name.argtypes=[ctypes.c_char_p]
resolver.seccomp_syscall_resolve_name.restype=ctypes.c_int
lib.syscall.restype=ctypes.c_long
def error(name,*args):
 number=resolver.seccomp_syscall_resolve_name(name.encode())
 assert number>=0
 ctypes.set_errno(0)
 result=lib.syscall(ctypes.c_long(number),*[ctypes.c_uint64(value) for value in args])
 return ctypes.get_errno() if result==-1 else 0
protected=[]
for pid in (1,(1<<32)+1):
 protected.append(error('ptrace',2,pid,0,0)==errno.EPERM)
 protected.append(error('process_vm_readv',pid,0,1,0,1,0)==errno.EPERM)
 protected.append(error('process_vm_writev',pid,0,1,0,1,0)==errno.EPERM)
protected.append(error('pidfd_getfd',(1<<64)-1,0,0)==errno.EPERM)
self_read=error('process_vm_readv',os.getpid(),0,1,0,1,0)==errno.EFAULT
print(json.dumps({'proc_one_hidden':os.listdir('/proc/1')==[],'self_visible':os.path.isfile('/proc/self/status'),'self_read':self_read,'protected':protected}))
"#;
    let command = f.command(vec!["/usr/bin/python3".into(), "-c".into(), script.into()]);
    f.namespace.release(&command).await.unwrap();
    assert!(f.ended().await.success());
    let result: serde_json::Value = serde_json::from_slice(&f.stdout().await).unwrap();
    assert_eq!(result["proc_one_hidden"], true, "{result}");
    assert_eq!(result["self_visible"], true);
    assert_eq!(result["self_read"], true);
    assert!(
        result["protected"]
            .as_array()
            .unwrap()
            .iter()
            .all(|value| value == true)
    );
}

#[tokio::test]
async fn captured_bytes() {
    let mut f = Fixture::new();
    f.ready().await;
    let script = "import sys; sys.stdout.buffer.write(bytes(range(256))*37+b'private output fixture'); sys.stderr.buffer.write(bytes(reversed(range(256)))*19)";
    let command = f.command(vec!["/usr/bin/python3".into(), "-c".into(), script.into()]);
    f.namespace.release(&command).await.unwrap();
    assert!(f.ended().await.success());
    let expected: Vec<_> = (0..37)
        .flat_map(|_| 0_u8..=255)
        .chain(b"private output fixture".iter().copied())
        .collect();
    assert_eq!(f.stdout().await, expected);
    assert_eq!(
        read_output(f.namespace.output(), Stream::Stderr).await,
        (0..19).flat_map(|_| (0_u8..=255).rev()).collect::<Vec<_>>()
    );
    let last = f.namespace.output().complete().unwrap().unwrap();
    let reopened = OutputReader::open(f.namespace.directory(), &f.capture).unwrap();
    for sequence in 1..=last {
        let frame = reopened.frame(sequence).unwrap().unwrap();
        assert_eq!(
            Some(&frame),
            f.namespace.output().frame(sequence).unwrap().as_ref()
        );
        assert!(
            BASE64_URL_SAFE_NO_PAD.decode(&frame.data).unwrap().len()
                <= f.capture.frame_bytes.get()
        );
    }
    assert_eq!(reopened.frame(last + 1).unwrap(), None);
    for entry in fs::read_dir(f.namespace.directory().join("output")).unwrap() {
        let bytes = fs::read(entry.unwrap().path()).unwrap();
        assert!(
            !bytes
                .windows(b"private output fixture".len())
                .any(|value| value == b"private output fixture")
        );
    }
    for changed in ["operation", "scope", "worker", "key", "policy"] {
        let mut options = f.capture.clone();
        match changed {
            "operation" => options.id.operation = Uuid::new_v4(),
            "scope" => options.id.scope = Uuid::new_v4(),
            "worker" => options.worker = Uuid::new_v4(),
            "key" => options.key = Arc::new(JobKey::new([43; 32])),
            "policy" => options.frame_bytes = NonZeroUsize::new(8192).unwrap(),
            _ => unreachable!(),
        }
        let wrong = OutputReader::open(f.namespace.directory(), &options).unwrap();
        assert!(wrong.ready().is_err(), "accepted changed {changed}");
    }
}

#[tokio::test]
async fn output_tampering() {
    let mut f = Fixture::new();
    f.ready().await;
    let script = r#"import errno,os,stat
os.write(1,b'original ')
alias=os.dup(1)
assert stat.S_ISFIFO(os.fstat(alias).st_mode)
try: os.ftruncate(alias,0)
except OSError as e: assert e.errno==errno.EINVAL
else: raise AssertionError('output was truncatable')
os.close(alias)
os.write(1,b'preserved')
"#;
    let command = f.command(vec!["/usr/bin/python3".into(), "-c".into(), script.into()]);
    f.namespace.release(&command).await.unwrap();
    assert!(f.ended().await.success());
    assert_eq!(f.stdout().await, b"original preserved");
    let last = f.namespace.output().complete().unwrap().unwrap();
    for fault in ["changed", "missing", "sequence"] {
        let copy = f.base.join(fault);
        fs::create_dir(&copy).unwrap();
        fs::create_dir(copy.join("output")).unwrap();
        for entry in fs::read_dir(f.namespace.directory().join("output")).unwrap() {
            let entry = entry.unwrap();
            if entry.file_name() == "0000000000000001" {
                continue;
            }
            fs::copy(entry.path(), copy.join("output").join(entry.file_name())).unwrap();
        }
        let mut bytes = fs::read(f.namespace.directory().join("output/0000000000000001")).unwrap();
        match fault {
            "changed" => {
                *bytes.last_mut().unwrap() ^= 1;
                fs::write(copy.join("output/0000000000000001"), bytes).unwrap();
            }
            "sequence" => {
                fs::write(copy.join("output/0000000000000001"), &bytes).unwrap();
                fs::write(
                    copy.join("output").join(format!("{:016x}", last + 1)),
                    bytes,
                )
                .unwrap();
            }
            "missing" => {}
            _ => unreachable!(),
        }
        let reader = OutputReader::open(&copy, &f.capture).unwrap();
        let sequence = if fault == "sequence" { last + 1 } else { 1 };
        assert!(reader.frame(sequence).is_err(), "accepted {fault} output");
    }
}

#[tokio::test]
async fn capture_write_failure() {
    use std::os::unix::fs::PermissionsExt;
    let mut f = Fixture::rooted(
        std::path::Path::new("/tmp"),
        NonZeroUsize::new(4096).unwrap(),
        |_, _| {},
    );
    f.ready().await;
    fs::set_permissions(
        f.namespace.directory().join("output"),
        fs::Permissions::from_mode(0o500),
    )
    .unwrap();
    assert_eq!(
        fs::write(f.namespace.directory().join("output/probe"), b"probe")
            .unwrap_err()
            .kind(),
        std::io::ErrorKind::PermissionDenied
    );
    let command = f.command(vec![
        "/bin/sh".into(),
        "-c".into(),
        "printf undurable".into(),
    ]);
    f.namespace.release(&command).await.unwrap();
    f.ended().await;
    assert!(
        timeout(deadline(), f.namespace.wait_output())
            .await
            .unwrap()
            .is_err()
    );
    assert_eq!(f.namespace.output().frame(1).unwrap(), None);
    assert_eq!(f.namespace.output().complete().unwrap(), None);
    assert!(!f.namespace.directory().join("output/complete").exists());
}

#[tokio::test]
async fn capture_required() {
    let mut f = Fixture::configured(NonZeroUsize::new(4096).unwrap(), |_, config| {
        config.capture = "/bin/false".into();
    });
    timeout(deadline(), async {
        while f.namespace.output_ready().is_ok() {
            sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap();
    timeout(deadline(), async {
        while !matches!(
            f.namespace.records().unwrap().as_slice(),
            [GateRecord::Ready { .. }]
        ) {
            assert!(f.namespace.try_wait().unwrap().is_none());
            sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap();
    let command = f.command(vec![
        "/bin/sh".into(),
        "-c".into(),
        "printf forbidden > executed".into(),
    ]);
    assert!(f.namespace.release(&command).await.is_err());
    f.namespace.refuse();
    assert!(!f.ended().await.success());
    assert!(!f.base.join("workspace/executed").exists());
}

#[tokio::test]
async fn separate_eof() {
    let mut f = Fixture::new();
    f.ready().await;
    let command = f.command(vec![
        "/usr/bin/python3".into(),
        "-c".into(),
        "import os; os.close(1); os.write(2,b'error after stdout closed'*1024)".into(),
    ]);
    f.namespace.release(&command).await.unwrap();
    assert!(f.ended().await.success());
    timeout(deadline(), f.namespace.wait_output())
        .await
        .unwrap()
        .unwrap();
    assert!(f.stdout().await.is_empty());
    assert_eq!(
        read_output(f.namespace.output(), Stream::Stderr).await,
        b"error after stdout closed".repeat(1024)
    );
}

#[tokio::test]
async fn retained_exit() {
    use std::io::Write;
    let mut f = Fixture::new();
    let process = f.ready().await;
    assert_eq!(
        chopin_job_broker::runtime::read_exit(f.namespace.directory(), &process).unwrap(),
        None
    );
    let command = f.command(vec![
        "/usr/bin/python3".into(),
        "-c".into(),
        "import pathlib,signal; pathlib.Path('/workspace/started').touch(); signal.pause()".into(),
    ]);
    f.namespace.release(&command).await.unwrap();
    timeout(deadline(), async {
        while !f.base.join("workspace/started").exists() {
            sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap();
    f.process.as_ref().unwrap().terminate().unwrap();
    let status = f.ended().await;
    assert!(!status.success());
    assert_eq!(
        chopin_job_broker::runtime::read_exit(f.namespace.directory(), &process).unwrap(),
        Some(ExitStatus::Code(status.code().unwrap()))
    );
    let mut wrong = process.clone();
    wrong.init_pid += 1;
    assert!(matches!(
        chopin_job_broker::runtime::read_exit(f.namespace.directory(), &wrong),
        Err(Error::Conflict)
    ));
    let mut file = fs::OpenOptions::new()
        .append(true)
        .open(f.namespace.directory().join("launcher.jsonl"))
        .unwrap();
    file.write_all(b"{").unwrap();
    file.sync_all().unwrap();
    assert!(matches!(
        chopin_job_broker::runtime::read_exit(f.namespace.directory(), &process),
        Err(Error::Invalid)
    ));
}
