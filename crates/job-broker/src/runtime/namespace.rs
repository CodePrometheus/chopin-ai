use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::Read,
    num::NonZeroUsize,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Component, Path, PathBuf},
    process::Stdio,
};

use command_fds::{CommandFdExt, FdMapping};
use nix::fcntl::OFlag;
use serde::{Deserialize, Serialize};
use tokio::{
    io::AsyncWriteExt,
    process::{Child, ChildStdin},
};

use super::{
    CaptureOptions, GateCommand, GateRecord, HostIdentity, OutputReader, capture::Capture,
};
use crate::{Error, Result};

/// Host-selected network boundary, independent of command-supplied arguments.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NetworkMode {
    /// A new command network namespace with no external interfaces.
    #[default]
    Isolated,
    /// The provider's already isolated network; its local services must authenticate every call.
    Inherited,
}

/// Trusted execution profile. User requests cannot change mounts or namespace options.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NamespaceConfig {
    /// Verified namespace-launcher executable.
    pub launcher: PathBuf,
    /// Verified explicit-release gate executable.
    pub gate: PathBuf,
    /// Verified protected output-capture executable, outside all writable command mounts.
    pub capture: PathBuf,
    /// Complete private metadata and credential root, excluded from every command mount.
    pub private_root: PathBuf,
    /// Approved contents of this protection domain's workspace.
    pub workspace: PathBuf,
    /// Immutable system paths, mounted read-only at the same absolute location.
    pub read_only: Vec<PathBuf>,
    /// Explicit provider networking; omitted historical profiles retain their isolated network.
    #[serde(default)]
    pub network: NetworkMode,
    /// Explicit published environment inherited only when the request allows it; never the controller's environment.
    pub environment: BTreeMap<String, String>,
}
impl std::fmt::Debug for NamespaceConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NamespaceConfig").finish_non_exhaustive()
    }
}
impl NamespaceConfig {
    /// Validate real objects and protected-root separation before creating a process.
    pub fn validate(&self) -> Result<()> {
        self.resolve().map(|_| ())
    }

    fn resolve(&self) -> Result<Resolved> {
        if !crate::types::valid_environment(&self.environment) {
            return Err(Error::Invalid);
        }
        let private = pin(&self.private_root)?;
        let workspace = pin(&self.workspace)?;
        if !private.file.metadata()?.is_dir()
            || !workspace.file.metadata()?.is_dir()
            || overlap(&private.path, &workspace.path)
        {
            return Err(Error::Invalid);
        }
        let launcher = pin(&self.launcher)?;
        let gate = pin(&self.gate)?;
        let capture = pin(&self.capture)?;
        for program in [&launcher, &gate, &capture] {
            if !program.file.metadata()?.is_file() || program.path.starts_with(&workspace.path) {
                return Err(Error::Invalid);
            }
        }
        let mut read_only = Vec::with_capacity(self.read_only.len());
        for path in &self.read_only {
            if !path.is_absolute()
                || path
                    .components()
                    .any(|part| matches!(part, Component::ParentDir))
                || path == Path::new("/")
            {
                return Err(Error::Invalid);
            }
            if ["/proc", "/dev", "/tmp", "/run", "/workspace"]
                .iter()
                .any(|reserved| path.starts_with(reserved))
            {
                return Err(Error::Invalid);
            }
            let source = pin(path)?;
            let metadata = source.file.metadata()?;
            if !(metadata.is_file() || metadata.is_dir())
                || overlap(&private.path, &source.path)
                || overlap(&workspace.path, &source.path)
            {
                return Err(Error::Invalid);
            }
            read_only.push((source, path.clone()));
        }
        Ok(Resolved {
            private,
            workspace,
            launcher,
            gate,
            capture,
            read_only,
        })
    }
}
struct Pinned {
    file: File,
    path: PathBuf,
}
struct Resolved {
    private: Pinned,
    workspace: Pinned,
    launcher: Pinned,
    gate: Pinned,
    capture: Pinned,
    read_only: Vec<(Pinned, PathBuf)>,
}
fn pin(path: &Path) -> Result<Pinned> {
    if !path.is_absolute() {
        return Err(Error::Invalid);
    }
    let file = File::from(
        rustix::fs::open(
            path,
            rustix::fs::OFlags::PATH | rustix::fs::OFlags::CLOEXEC,
            rustix::fs::Mode::empty(),
        )
        .map_err(std::io::Error::from)?,
    );
    let path = fs::canonicalize(super::process::descriptor_path(&file))?;
    Ok(Pinned { file, path })
}

/// One namespace launch, retaining private facts independently of the controller's lifetime.
/// Dropping this handle closes an unreleased gate, but never cancels an admitted command.
pub struct Namespace {
    child: Child,
    input: Option<ChildStdin>,
    directory: PathBuf,
    maximum: NonZeroUsize,
    capture: Capture,
}
impl std::fmt::Debug for Namespace {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Namespace")
            .field("input_open", &self.input.is_some())
            .finish_non_exhaustive()
    }
}
impl Namespace {
    /// Create a gated namespace in an already reserved private operation directory.
    /// Every file is new; callers reconcile an existing directory instead of overwriting it.
    pub fn spawn(
        config: &NamespaceConfig,
        directory: &Path,
        host: &HostIdentity,
        maximum: NonZeroUsize,
        output: &CaptureOptions,
    ) -> Result<Self> {
        let resolved = config.resolve()?;
        host.verify()?;
        let directory = fs::canonicalize(directory)?;
        let private = &resolved.private.path;
        if directory == *private || !directory.starts_with(private) {
            return Err(Error::Invalid);
        }
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))?;
        let launcher = fresh(&directory.join("launcher.jsonl"))?;
        let gate = fresh(&directory.join("gate.jsonl"))?;
        File::open(&directory)?.sync_all()?;
        let (capture, pipes) = Capture::spawn(&resolved.capture.path, &directory, output)?;
        let mut command = std::process::Command::new(&resolved.launcher.path);
        command.env_clear().args([
            "--unshare-user",
            "--unshare-pid",
            "--unshare-ipc",
            "--unshare-uts",
            "--new-session",
            "--cap-drop",
            "ALL",
            "--clearenv",
        ]);
        if config.network == NetworkMode::Isolated {
            command.arg("--unshare-net");
        }
        let mut mappings = vec![
            FdMapping {
                parent_fd: launcher.into(),
                child_fd: 3,
            },
            FdMapping {
                parent_fd: super::filter::create()?.into(),
                child_fd: 4,
            },
            FdMapping {
                parent_fd: gate.into(),
                child_fd: 5,
            },
            FdMapping {
                parent_fd: File::open("/proc")?.into(),
                child_fd: 6,
            },
        ];
        let mut next = 7_i32;
        for (source, target) in resolved.read_only {
            command
                .arg("--ro-bind-fd")
                .arg(next.to_string())
                .arg(target);
            mappings.push(FdMapping {
                parent_fd: source.file.into(),
                child_fd: next,
            });
            next = next.checked_add(1).ok_or(Error::Invalid)?;
        }
        command
            .args([
                "--proc",
                "/proc",
                "--tmpfs",
                "/proc/1",
                "--remount-ro",
                "/proc/1",
                "--dev",
                "/dev",
                "--tmpfs",
                "/tmp",
                "--dir",
                "/run",
                "--bind-fd",
            ])
            .arg(next.to_string())
            .arg("/workspace");
        mappings.push(FdMapping {
            parent_fd: resolved.workspace.file.into(),
            child_fd: next,
        });
        next = next.checked_add(1).ok_or(Error::Invalid)?;
        command
            .arg("--ro-bind-fd")
            .arg(next.to_string())
            .arg("/run/command-gate");
        mappings.push(FdMapping {
            parent_fd: resolved.gate.file.into(),
            child_fd: next,
        });
        command
            .args([
                "--chdir",
                "/",
                "--json-status-fd",
                "3",
                "--seccomp",
                "4",
                "--",
                "/run/command-gate",
            ])
            .arg(maximum.get().to_string())
            .arg(serde_json::to_string(host)?)
            .args(["5", "6"]);
        command
            .stdin(Stdio::piped())
            .stdout(pipes.stdout)
            .stderr(pipes.stderr);
        command.fd_mappings(mappings).map_err(|_| Error::Invalid)?;
        let mut child = tokio::process::Command::from(command).spawn()?;
        let input = child.stdin.take().ok_or(Error::Invalid)?;
        Ok(Self {
            child,
            input: Some(input),
            directory,
            maximum,
            capture,
        })
    }
    /// Read private complete gate records; a torn final write is not promoted to a completed record.
    pub fn records(&self) -> Result<Vec<GateRecord>> {
        read_records(&self.directory)
    }
    /// Whether protected output capture has initialized before the command can be released.
    pub fn output_ready(&mut self) -> Result<bool> {
        self.capture.ready()
    }
    /// Original encrypted output, independent of the launcher's primary-process exit.
    pub fn output(&self) -> &OutputReader {
        self.capture.reader()
    }
    /// Observe the capture process's completion. This waits for both output pipes, not namespace drain.
    /// Cancelling the wait leaves capture running; errors never synthesize an output completion record.
    pub async fn wait_output(&mut self) -> Result<()> {
        self.capture.wait().await
    }
    /// Send the only release message after host authorization for the recorded process.
    /// The caller persists its release intent first; an interrupted send leaves the outcome unknown.
    pub async fn release(&mut self, command: &GateCommand) -> Result<()> {
        if !matches!(self.records()?.as_slice(), [GateRecord::Ready { .. }])
            || !self.capture.ready()?
        {
            return Err(Error::Conflict);
        }
        let bytes = serde_json::to_vec(command)?;
        if bytes.len() > self.maximum.get() {
            return Err(Error::Invalid);
        }
        let mut input = self.input.take().ok_or(Error::Conflict)?;
        input.write_all(&[1]).await?;
        input.write_all(&bytes).await?;
        input.shutdown().await?;
        Ok(())
    }
    /// Refuse an unreleased gate by closing its input without the release byte.
    pub fn refuse(&mut self) {
        self.input.take();
    }
    /// Observe the launcher's primary-process result; this does not establish namespace drain.
    pub async fn wait(&mut self) -> Result<std::process::ExitStatus> {
        Ok(self.child.wait().await?)
    }
    /// Check the launcher without waiting; absence of a result does not imply an idle namespace.
    pub fn try_wait(&mut self) -> Result<Option<std::process::ExitStatus>> {
        Ok(self.child.try_wait()?)
    }
    /// Original private directory for the trusted output and recovery components.
    pub fn directory(&self) -> &Path {
        &self.directory
    }
}

/// Read a launcher's original gate facts without opening a new namespace or sending a command.
pub fn read_records(directory: &Path) -> Result<Vec<GateRecord>> {
    let maximum = record_bound()?;
    let mut bytes = Vec::new();
    File::open(directory.join("gate.jsonl"))?
        .take(maximum as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > maximum {
        return Err(Error::Invalid);
    }
    let mut records = Vec::new();
    let mut terminal = false;
    for line in bytes.split_inclusive(|byte| *byte == b'\n') {
        if line.last() != Some(&b'\n') {
            if terminal {
                return Err(Error::Invalid);
            }
            break;
        }
        let record: GateRecord = serde_json::from_slice(line)?;
        match (&record, records.is_empty(), terminal) {
            (GateRecord::Ready { .. }, true, false) => {}
            (GateRecord::Released { .. } | GateRecord::Refused, false, false) => terminal = true,
            _ => return Err(Error::Invalid),
        }
        records.push(record);
    }
    Ok(records)
}
fn record_bound() -> Result<usize> {
    let ready = GateRecord::Ready {
        process: crate::ProcessIdentity {
            domain: uuid::Uuid::nil(),
            boot: uuid::Uuid::nil(),
            init_pid: u32::MAX,
            start_ticks: u64::MAX,
            namespace_inode: u64::MAX,
        },
    };
    let released = GateRecord::Released {
        digest: base64::Engine::encode(&base64::prelude::BASE64_URL_SAFE_NO_PAD, [0; 32]),
    };
    Ok(serde_json::to_vec(&ready)?.len()
        + serde_json::to_vec(&released)?
            .len()
            .max(serde_json::to_vec(&GateRecord::Refused)?.len())
        + 2)
}
fn overlap(left: &Path, right: &Path) -> bool {
    left.starts_with(right) || right.starts_with(left)
}
fn fresh(path: &Path) -> Result<File> {
    let file = OpenOptions::new()
        .create_new(true)
        .append(true)
        .mode(0o600)
        .custom_flags(OFlag::O_DSYNC.bits())
        .open(path)?;
    file.sync_all()?;
    Ok(file)
}
