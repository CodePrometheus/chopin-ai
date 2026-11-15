use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    num::NonZeroUsize,
    os::{
        fd::OwnedFd,
        unix::fs::{FileTypeExt, OpenOptionsExt},
    },
    path::Path,
    process::Stdio,
    sync::Arc,
};

use base64::{Engine as _, prelude::BASE64_URL_SAFE_NO_PAD};
use command_fds::{CommandFdExt, FdMapping};
use rustix::{
    event::{PollFd, PollFlags, poll},
    fs::{MemfdFlags, SealFlags, fcntl_add_seals, memfd_create},
    pipe::{PipeFlags, pipe_with},
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use tokio::process::Child;
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::{Error, JobId, JobKey, Result, Stream};

/// Immutable output policy and identity, persisted by the worker before launching capture.
#[derive(Clone, Debug)]
pub struct CaptureOptions {
    /// Original operation whose output is being captured.
    pub id: JobId,
    /// Original worker reservation, never a replacement chosen during recovery.
    pub worker: Uuid,
    /// Original host policy's maximum bytes per frame.
    pub frame_bytes: NonZeroUsize,
    /// Dedicated output key; transferred through a private descriptor, never an argument or environment.
    pub key: Arc<JobKey>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Spec {
    version: u32,
    id: JobId,
    worker: Uuid,
    frame_bytes: NonZeroUsize,
}
impl CaptureOptions {
    fn spec(&self) -> Result<Spec> {
        if self.id.scope.is_nil() || self.id.operation.is_nil() || self.worker.is_nil() {
            return Err(Error::Invalid);
        }
        Ok(Spec {
            version: 1,
            id: self.id,
            worker: self.worker,
            frame_bytes: self.frame_bytes,
        })
    }
}

/// One immutable, authenticated frame. Repeated delivery preserves these exact bytes and sequence.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OutputFrame {
    /// Contiguous sequence beginning at one, shared by both channels.
    pub sequence: u64,
    /// Original output channel.
    pub stream: Stream,
    /// URL-safe unpadded base64 of the original bytes, including non-text output.
    pub data: String,
}
impl std::fmt::Debug for OutputFrame {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OutputFrame")
            .field("sequence", &self.sequence)
            .field("stream", &self.stream)
            .finish_non_exhaustive()
    }
}

/// Reads the original durable output without starting a command or capture process.
#[derive(Debug)]
pub struct OutputReader {
    root: File,
    spec: Spec,
    key: Arc<JobKey>,
}
impl OutputReader {
    /// Open an existing private capture directory using the originally recorded identity and policy.
    /// Missing storage is an error; it never means empty output or a completed command.
    pub fn open(directory: &Path, options: &CaptureOptions) -> Result<Self> {
        let root = File::open(directory.join("output"))?;
        if !root.metadata()?.is_dir() {
            return Err(Error::Invalid);
        }
        Ok(Self {
            root,
            spec: options.spec()?,
            key: options.key.clone(),
        })
    }
    /// Whether the capture process has durably initialized its original output stream.
    pub fn ready(&self) -> Result<bool> {
        let size = serde_json::to_vec(&self.spec)?.len();
        match self.read::<Spec>("ready", "ready", 0, size)? {
            None => Ok(false),
            Some(spec) if spec == self.spec => Ok(true),
            Some(_) => Err(Error::Conflict),
        }
    }
    /// Read one original frame. Absence is provisional unless the final sequence is known.
    /// Published files are synchronized before a reader can acknowledge their content remotely.
    pub fn frame(&self, sequence: u64) -> Result<Option<OutputFrame>> {
        if sequence == 0 || !self.ready()? {
            return Err(Error::Conflict);
        }
        let encoded = self
            .spec
            .frame_bytes
            .get()
            .div_ceil(3)
            .checked_mul(4)
            .ok_or(Error::Invalid)?;
        let overhead = serde_json::to_vec(&OutputFrame {
            sequence: u64::MAX,
            stream: Stream::Stderr,
            data: String::new(),
        })?
        .len();
        let maximum = encoded.checked_add(overhead).ok_or(Error::Invalid)?;
        let frame: Option<OutputFrame> =
            self.read(&format!("{sequence:016x}"), "frame", sequence, maximum)?;
        if let Some(frame) = &frame {
            let data = BASE64_URL_SAFE_NO_PAD
                .decode(&frame.data)
                .map_err(|_| Error::Invalid)?;
            if frame.sequence != sequence
                || data.is_empty()
                || data.len() > self.spec.frame_bytes.get()
                || BASE64_URL_SAFE_NO_PAD.encode(data) != frame.data
            {
                return Err(Error::Conflict);
            }
        } else if self.complete()?.is_some_and(|last| sequence <= last) {
            return Err(Error::Conflict);
        }
        Ok(frame)
    }
    /// Final sequence, published only after both pipes reached EOF and every frame was synchronized.
    /// Missing completion remains incomplete even if the capture process has exited.
    pub fn complete(&self) -> Result<Option<u64>> {
        if !self.ready()? {
            return Ok(None);
        }
        self.read("complete", "complete", 0, u64::MAX.to_string().len())
    }
    /// Reconcile the committed prefix and deliver original frames through the authenticated callback.
    /// An error or cancellation leaves the original frames available for the next explicit attempt.
    /// Output completion does not establish primary exit or namespace drain.
    #[cfg(feature = "transport")]
    pub async fn deliver(
        &self,
        client: &crate::ControlClient,
        callback: &crate::Callback,
    ) -> Result<crate::Snapshot> {
        let mut snapshot = client
            .event(
                callback,
                self.spec.id,
                self.spec.worker,
                &crate::WorkerEvent::Read,
            )
            .await?;
        if snapshot.state.last_sequence > 0 && self.frame(snapshot.state.last_sequence)?.is_none() {
            return Err(Error::Conflict);
        }
        loop {
            let sequence = snapshot
                .state
                .last_sequence
                .checked_add(1)
                .ok_or(Error::Invalid)?;
            let Some(frame) = self.frame(sequence)? else {
                break;
            };
            snapshot = client
                .event(
                    callback,
                    self.spec.id,
                    self.spec.worker,
                    &crate::WorkerEvent::Output {
                        sequence: frame.sequence,
                        stream: frame.stream,
                        data: frame.data,
                    },
                )
                .await?;
        }
        match self.complete()? {
            Some(last) if last == snapshot.state.last_sequence => {
                client
                    .event(
                        callback,
                        self.spec.id,
                        self.spec.worker,
                        &crate::WorkerEvent::OutputComplete { sequence: last },
                    )
                    .await
            }
            Some(_) => Err(Error::Conflict),
            None if snapshot.state.output_complete => Err(Error::Conflict),
            None => Ok(snapshot),
        }
    }
    fn read<T: DeserializeOwned>(
        &self,
        name: &str,
        purpose: &str,
        sequence: u64,
        maximum: usize,
    ) -> Result<Option<T>> {
        let mut file = match File::open(super::process::descriptor_path(&self.root).join(name)) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        if !file.metadata()?.is_file() {
            return Err(Error::Invalid);
        }
        let maximum = maximum.checked_add(24 + 16).ok_or(Error::Invalid)?;
        let mut bytes = Vec::new();
        (&mut file)
            .take(maximum as u64 + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() > maximum {
            return Err(Error::Invalid);
        }
        let result = self.key.open(&aad(&self.spec, purpose, sequence), &bytes)?;
        file.sync_all()?;
        self.root.sync_all()?;
        Ok(Some(result))
    }
}

pub(super) struct Capture {
    child: Child,
    reader: OutputReader,
}
pub(super) struct Pipes {
    pub stdout: OwnedFd,
    pub stderr: OwnedFd,
}
impl Capture {
    pub(super) fn spawn(
        program: &Path,
        directory: &Path,
        options: &CaptureOptions,
    ) -> Result<(Self, Pipes)> {
        let spec = options.spec()?;
        fs::create_dir(directory.join("output"))?;
        File::open(directory)?.sync_all()?;
        let reader = OutputReader::open(directory, options)?;
        let (stdout, output) = pipe_with(PipeFlags::CLOEXEC).map_err(std::io::Error::from)?;
        let (stderr, error) = pipe_with(PipeFlags::CLOEXEC).map_err(std::io::Error::from)?;
        let mut key = File::from(
            memfd_create(
                c"capture-key",
                MemfdFlags::CLOEXEC | MemfdFlags::ALLOW_SEALING,
            )
            .map_err(std::io::Error::from)?,
        );
        options.key.transfer(&mut key)?;
        key.seek(SeekFrom::Start(0))?;
        fcntl_add_seals(
            &key,
            SealFlags::SEAL | SealFlags::GROW | SealFlags::SHRINK | SealFlags::WRITE,
        )
        .map_err(std::io::Error::from)?;
        let mut command = std::process::Command::new(program);
        command
            .env_clear()
            .arg(serde_json::to_string(&spec)?)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        command
            .fd_mappings(vec![
                FdMapping {
                    parent_fd: reader.root.try_clone()?.into(),
                    child_fd: 3,
                },
                FdMapping {
                    parent_fd: stdout,
                    child_fd: 4,
                },
                FdMapping {
                    parent_fd: stderr,
                    child_fd: 5,
                },
                FdMapping {
                    parent_fd: key.into(),
                    child_fd: 6,
                },
            ])
            .map_err(|_| Error::Invalid)?;
        let child = tokio::process::Command::from(command).spawn()?;
        Ok((
            Self { child, reader },
            Pipes {
                stdout: output,
                stderr: error,
            },
        ))
    }
    pub(super) fn reader(&self) -> &OutputReader {
        &self.reader
    }
    pub(super) fn ready(&mut self) -> Result<bool> {
        if self.child.try_wait()?.is_some() {
            return Err(Error::Conflict);
        }
        self.reader.ready()
    }
    pub(super) async fn wait(&mut self) -> Result<()> {
        if !self.child.wait().await?.success() || self.reader.complete()?.is_none() {
            return Err(Error::Conflict);
        }
        Ok(())
    }
}

/// Capture entry point with private descriptors: directory 3, stdout 4, stderr 5, key 6.
/// It survives controller death. A failed capture never writes a completion record or restarts work.
pub fn run_capture(spec: &str) -> Result<()> {
    let spec: Spec = serde_json::from_str(spec)?;
    if spec.version != 1
        || spec.id.scope.is_nil()
        || spec.id.operation.is_nil()
        || spec.worker.is_nil()
    {
        return Err(Error::Invalid);
    }
    let root = inherited(3)?;
    let mut stdout = inherited(4)?;
    let mut stderr = inherited(5)?;
    let mut source = inherited(6)?;
    if !root.metadata()?.is_dir()
        || !stdout.metadata()?.file_type().is_fifo()
        || !stderr.metadata()?.file_type().is_fifo()
        || source.metadata()?.len() != 32
    {
        return Err(Error::Invalid);
    }
    let mut material = Zeroizing::new([0_u8; 32]);
    source.read_exact(&mut *material)?;
    drop(source);
    let key = JobKey::new(*material);
    drop(material);
    publish(&root, "ready", &key.seal(&aad(&spec, "ready", 0), &spec)?)?;
    let mut output_open = true;
    let mut error_open = true;
    let mut sequence = 0_u64;
    let mut bytes = Zeroizing::new(vec![0_u8; spec.frame_bytes.get()]);
    while output_open || error_open {
        let mut descriptors = Vec::new();
        if output_open {
            descriptors.push(PollFd::new(&stdout, PollFlags::IN));
        }
        if error_open {
            descriptors.push(PollFd::new(&stderr, PollFlags::IN));
        }
        match poll(&mut descriptors, None) {
            Ok(_) => {}
            Err(rustix::io::Errno::INTR) => continue,
            Err(error) => return Err(std::io::Error::from(error).into()),
        }
        let flags = descriptors.iter().map(PollFd::revents).collect::<Vec<_>>();
        drop(descriptors);
        let mut index = 0;
        for (stream, file, open) in [
            (Stream::Stdout, &mut stdout, &mut output_open),
            (Stream::Stderr, &mut stderr, &mut error_open),
        ] {
            if !*open {
                continue;
            }
            let ready = flags[index];
            index += 1;
            if ready.intersects(PollFlags::ERR | PollFlags::NVAL) {
                return Err(Error::Conflict);
            }
            if !ready.intersects(PollFlags::IN | PollFlags::HUP) {
                continue;
            }
            let count = match file.read(&mut bytes) {
                Ok(count) => count,
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(error.into()),
            };
            if count == 0 {
                *open = false;
                continue;
            }
            sequence = sequence.checked_add(1).ok_or(Error::Invalid)?;
            let frame = OutputFrame {
                sequence,
                stream,
                data: BASE64_URL_SAFE_NO_PAD.encode(&bytes[..count]),
            };
            publish(
                &root,
                &format!("{sequence:016x}"),
                &key.seal(&aad(&spec, "frame", sequence), &frame)?,
            )?;
        }
    }
    publish(
        &root,
        "complete",
        &key.seal(&aad(&spec, "complete", 0), &sequence)?,
    )
}
fn inherited(number: i32) -> Result<File> {
    let file = File::open(format!("/proc/self/fd/{number}"))?;
    nix::unistd::close(number).map_err(std::io::Error::from)?;
    Ok(file)
}
fn aad(spec: &Spec, purpose: &str, sequence: u64) -> Vec<u8> {
    format!(
        "command-capture/{}:{}:{}:{}:{purpose}:{sequence}",
        spec.version, spec.id.scope, spec.id.operation, spec.worker
    )
    .into_bytes()
}
fn publish(root: &File, name: &str, bytes: &[u8]) -> Result<()> {
    let directory = super::process::descriptor_path(root);
    let temporary = directory.join(format!("pending-{}", Uuid::new_v4()));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(&temporary)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    fs::hard_link(&temporary, directory.join(name))?;
    root.sync_all()?;
    Ok(())
}
