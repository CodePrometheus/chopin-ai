use std::{
    collections::BTreeMap,
    convert::Infallible,
    fs::{File, OpenOptions},
    io::{Read, Write},
    num::NonZeroUsize,
    os::unix::process::CommandExt,
    process::{Command, Stdio},
};

use base64::{Engine as _, prelude::BASE64_URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{HostIdentity, process};
use crate::{Error, ProcessIdentity, Result};

/// The command is sent only after the exact original process has received release authority.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GateCommand {
    /// Supported gate input version.
    pub version: u32,
    /// Original executable and arguments.
    pub argv: Vec<String>,
    /// Working directory inside the already established namespace.
    pub cwd: String,
    /// Complete approved environment; the gate never inherits its host's environment.
    pub env: BTreeMap<String, String>,
}
impl std::fmt::Debug for GateCommand {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GateCommand")
            .field("version", &self.version)
            .finish_non_exhaustive()
    }
}
impl GateCommand {
    /// Fingerprint the normalized immutable command, without retaining its secret fields in diagnostics.
    pub fn digest(&self) -> Result<String> {
        Ok(BASE64_URL_SAFE_NO_PAD.encode(Sha256::digest(serde_json::to_vec(self)?)))
    }
    fn validate(&self) -> Result<()> {
        if self.version != 1
            || self.argv.first().is_none_or(String::is_empty)
            || self.argv.iter().any(|arg| arg.contains('\0'))
            || self.cwd.is_empty()
            || self.cwd.contains('\0')
            || !crate::types::valid_environment(&self.env)
        {
            return Err(Error::Invalid);
        }
        Ok(())
    }
}

/// Private durable gate facts, written outside the command's visible filesystem.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum GateRecord {
    /// Isolation has been established and the gate is waiting for explicit release.
    Ready {
        /// Original namespace init, captured from the launcher's proc directory before reading input.
        process: ProcessIdentity,
    },
    /// The complete release message was received; executing it may now have taken effect.
    Released {
        /// Fingerprint of the approved command.
        digest: String,
    },
    /// The gate rejected its input before attempting the command.
    Refused,
}

/// Run the isolated gate. Inherited descriptors are consumed before user code can execute.
/// The input is byte 1, one bounded JSON command, and EOF. EOF without the byte never grants execution.
pub fn run_gate(
    maximum: NonZeroUsize,
    host: &HostIdentity,
    status_fd: i32,
    proc_fd: i32,
) -> Result<Infallible> {
    if status_fd < 3 || proc_fd < 3 || status_fd == proc_fd {
        return Err(Error::Invalid);
    }
    let mut status = OpenOptions::new()
        .append(true)
        .open(format!("/proc/self/fd/{status_fd}"))?;
    if !status.metadata()?.is_file() {
        return Err(Error::Invalid);
    }
    nix::unistd::close(status_fd).map_err(std::io::Error::from)?;
    let proc_root = File::open(format!("/proc/self/fd/{proc_fd}"))?;
    if !proc_root.metadata()?.is_dir() {
        return Err(Error::Invalid);
    }
    nix::unistd::close(proc_fd).map_err(std::io::Error::from)?;
    let process = process::parent(&process::descriptor_path(&proc_root), host)?;
    drop(proc_root);
    record(&mut status, &GateRecord::Ready { process })?;
    let parsed = read_command(maximum);
    let command = match parsed {
        Ok(command) => command,
        Err(error) => {
            record(&mut status, &GateRecord::Refused)?;
            return Err(error);
        }
    };
    record(
        &mut status,
        &GateRecord::Released {
            digest: command.digest()?,
        },
    )?;
    drop(status);
    let executable = command.argv.first().ok_or(Error::Invalid)?;
    Err(Command::new(executable)
        .args(&command.argv[1..])
        .current_dir(command.cwd)
        .env_clear()
        .envs(command.env)
        .stdin(Stdio::null())
        .exec()
        .into())
}
fn read_command(maximum: NonZeroUsize) -> Result<GateCommand> {
    let mut input = std::io::stdin().lock();
    let mut release = [0];
    input.read_exact(&mut release)?;
    if release != [1] {
        return Err(Error::Invalid);
    }
    let limit = u64::try_from(maximum.get())
        .map_err(|_| Error::Invalid)?
        .saturating_add(1);
    let mut bytes = Vec::new();
    input.take(limit).read_to_end(&mut bytes)?;
    if bytes.len() > maximum.get() {
        return Err(Error::Invalid);
    }
    let command: GateCommand = serde_json::from_slice(&bytes)?;
    command.validate()?;
    Ok(command)
}
fn record(file: &mut File, value: &GateRecord) -> Result<()> {
    let mut bytes = serde_json::to_vec(value)?;
    bytes.push(b'\n');
    file.write_all(&bytes)?;
    file.sync_all()?;
    Ok(())
}
