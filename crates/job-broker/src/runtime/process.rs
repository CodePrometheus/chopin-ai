use std::{
    fs,
    os::{
        fd::{AsRawFd, OwnedFd},
        unix::fs::MetadataExt,
    },
    path::Path,
};

use rustix::{
    event::{PollFd, PollFlags, Timespec, poll},
    io::Errno,
    process::{Pid, PidfdFlags, Signal, pidfd_open, pidfd_send_signal},
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{Error, ProcessIdentity, Result};

/// Physical context that must remain identical when reopening a worker's process records.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostIdentity {
    /// Independently assigned protection domain.
    pub domain: Uuid,
    /// Kernel boot identity.
    pub boot: Uuid,
    /// The worker's enclosing PID namespace, not a command's child namespace.
    pub pid_namespace_inode: u64,
}
impl HostIdentity {
    /// Capture the worker's current kernel context before admitting any process.
    pub fn current(domain: Uuid) -> Result<Self> {
        if domain.is_nil() {
            return Err(Error::Invalid);
        }
        Ok(Self {
            domain,
            boot: boot(Path::new("/proc"))?,
            pid_namespace_inode: fs::metadata("/proc/self/ns/pid")?.ino(),
        })
    }
    /// Refuse a moved or restored journal until the host provides independent fencing evidence.
    pub fn verify(&self) -> Result<()> {
        if Self::current(self.domain)? != *self {
            return Err(Error::Conflict);
        }
        Ok(())
    }
}

/// A kernel handle to one verified namespace init, immune to later PID reuse.
pub struct NamespaceProcess {
    identity: ProcessIdentity,
    host: HostIdentity,
    pidfd: OwnedFd,
}
impl std::fmt::Debug for NamespaceProcess {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NamespaceProcess")
            .field("identity", &self.identity)
            .finish_non_exhaustive()
    }
}
/// A successful kernel observation in the original physical context.
#[derive(Debug)]
pub enum ProcessObservation {
    /// The exact original namespace init is still alive.
    Alive(NamespaceProcess),
    /// The original namespace init is confirmed gone; its namespace cannot accept new processes.
    Exited,
}
impl NamespaceProcess {
    /// Reopen only in the recorded host context and verify identity before permitting a signal.
    /// Kernel-confirmed absence is distinct from failed observation; identity mismatches are refused.
    pub fn open(host: &HostIdentity, identity: &ProcessIdentity) -> Result<ProcessObservation> {
        host.verify()?;
        if identity.domain != host.domain
            || identity.boot != host.boot
            || identity.namespace_inode == host.pid_namespace_inode
            || identity.init_pid == 0
            || identity.start_ticks == 0
            || identity.namespace_inode == 0
        {
            return Err(Error::Conflict);
        }
        let pid = Pid::from_raw(i32::try_from(identity.init_pid).map_err(|_| Error::Invalid)?)
            .ok_or(Error::Invalid)?;
        let pidfd = match pidfd_open(pid, PidfdFlags::empty()) {
            Ok(fd) => fd,
            Err(Errno::SRCH) => return Ok(ProcessObservation::Exited),
            Err(error) => return Err(std::io::Error::from(error).into()),
        };
        if exited(&pidfd)? {
            return Ok(ProcessObservation::Exited);
        }
        let observed = inspect(Path::new("/proc"), identity.init_pid);
        if exited(&pidfd)? {
            return Ok(ProcessObservation::Exited);
        }
        let observed = observed?;
        if observed.start_ticks != identity.start_ticks
            || observed.namespace_inode != identity.namespace_inode
        {
            return Err(Error::Conflict);
        }
        if !observed.init {
            return Err(Error::Conflict);
        }
        Ok(ProcessObservation::Alive(Self {
            identity: identity.clone(),
            host: host.clone(),
            pidfd,
        }))
    }
    /// Original recorded identity.
    pub fn identity(&self) -> &ProcessIdentity {
        &self.identity
    }
    /// Observe this retained handle without rereading a potentially reused numeric PID.
    pub fn has_exited(&self) -> Result<bool> {
        self.host.verify()?;
        exited(&self.pidfd)
    }
    /// Terminate the exact namespace init; kernel PID namespace semantics terminate its descendants.
    pub fn terminate(&self) -> Result<()> {
        self.host.verify()?;
        match pidfd_send_signal(&self.pidfd, Signal::KILL) {
            Ok(()) | Err(Errno::SRCH) => Ok(()),
            Err(error) => Err(std::io::Error::from(error).into()),
        }
    }
    /// Wait for actual kernel exit. Cancelling this wait does not undo a signal or establish exit.
    pub async fn wait(&self) -> Result<()> {
        self.host.verify()?;
        let descriptor = async_io::Async::new_nonblocking(self.pidfd.try_clone()?)?;
        loop {
            descriptor.readable().await?;
            if exited(descriptor.get_ref())? {
                return Ok(());
            }
        }
    }
}

pub(super) fn parent(proc_root: &Path, host: &HostIdentity) -> Result<ProcessIdentity> {
    if host.domain.is_nil()
        || host.boot.is_nil()
        || host.pid_namespace_inode == 0
        || boot(proc_root)? != host.boot
    {
        return Err(Error::Conflict);
    }
    let current = stat(&fs::read(proc_root.join("self/stat"))?)?;
    let observed = inspect(proc_root, current.parent)?;
    if !observed.init || observed.namespace_inode == host.pid_namespace_inode {
        return Err(Error::Conflict);
    }
    Ok(ProcessIdentity {
        domain: host.domain,
        boot: host.boot,
        init_pid: current.parent,
        start_ticks: observed.start_ticks,
        namespace_inode: observed.namespace_inode,
    })
}
fn boot(proc_root: &Path) -> Result<Uuid> {
    Uuid::parse_str(fs::read_to_string(proc_root.join("sys/kernel/random/boot_id"))?.trim())
        .map_err(|_| Error::Invalid)
}
struct Information {
    start_ticks: u64,
    namespace_inode: u64,
    init: bool,
}
fn inspect(proc_root: &Path, pid: u32) -> Result<Information> {
    let root = proc_root.join(pid.to_string());
    let values = stat(&fs::read(root.join("stat"))?)?;
    if values.pid != pid {
        return Err(Error::Conflict);
    }
    let status = fs::read(root.join("status"))?;
    let nspid = status
        .split(|byte| *byte == b'\n')
        .find_map(|line| line.strip_prefix(b"NSpid:"))
        .ok_or(Error::Invalid)?;
    let init = nspid
        .split(|byte| byte.is_ascii_whitespace())
        .rfind(|value| !value.is_empty())
        == Some(b"1".as_slice());
    Ok(Information {
        start_ticks: values.start_ticks,
        namespace_inode: fs::metadata(root.join("ns/pid"))?.ino(),
        init,
    })
}
struct Stat {
    pid: u32,
    parent: u32,
    start_ticks: u64,
}
fn stat(bytes: &[u8]) -> Result<Stat> {
    let open = bytes
        .iter()
        .position(|byte| *byte == b'(')
        .ok_or(Error::Invalid)?;
    let close = bytes
        .iter()
        .rposition(|byte| *byte == b')')
        .filter(|close| *close > open)
        .ok_or(Error::Invalid)?;
    let pid = std::str::from_utf8(&bytes[..open])
        .map_err(|_| Error::Invalid)?
        .trim()
        .parse()
        .map_err(|_| Error::Invalid)?;
    // The first field after comm is field 3; parent and start time are fields 4 and 22.
    let fields = bytes[close + 1..]
        .split(|byte| byte.is_ascii_whitespace())
        .filter(|field| !field.is_empty())
        .collect::<Vec<_>>();
    let number = |index: usize| -> Result<u64> {
        std::str::from_utf8(fields.get(index).copied().ok_or(Error::Invalid)?)
            .map_err(|_| Error::Invalid)?
            .parse()
            .map_err(|_| Error::Invalid)
    };
    Ok(Stat {
        pid,
        parent: u32::try_from(number(1)?).map_err(|_| Error::Invalid)?,
        start_ticks: number(19)?,
    })
}
fn exited(fd: &OwnedFd) -> Result<bool> {
    let mut descriptors = [PollFd::new(fd, PollFlags::IN)];
    poll(
        &mut descriptors,
        Some(&Timespec {
            tv_sec: 0,
            tv_nsec: 0,
        }),
    )
    .map_err(std::io::Error::from)?;
    let flags = descriptors[0].revents();
    if flags.intersects(PollFlags::ERR | PollFlags::NVAL) {
        return Err(Error::Conflict);
    }
    Ok(flags.intersects(PollFlags::IN | PollFlags::HUP))
}

pub(super) fn descriptor_path(fd: &impl AsRawFd) -> std::path::PathBuf {
    format!("/proc/self/fd/{}", fd.as_raw_fd()).into()
}
