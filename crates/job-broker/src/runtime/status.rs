use std::{fs::File, io::Read, path::Path};

use serde::Deserialize;

use crate::{Error, ExitStatus, ProcessIdentity, Result};

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
struct Started {
    child_pid: u32,
    pid_namespace: u64,
    cgroup_namespace: Option<u64>,
    ipc_namespace: Option<u64>,
    mnt_namespace: Option<u64>,
    net_namespace: Option<u64>,
    uts_namespace: Option<u64>,
}
#[derive(Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
struct Ended {
    exit_code: i32,
}

/// Read the original launcher's retained exit report, bound to the gate's namespace identity.
/// A reported code uses launcher conventions; it is never guessed to be a particular signal.
/// Missing reports remain unknown, and a primary exit does not establish namespace drain.
pub fn read_exit(directory: &Path, process: &ProcessIdentity) -> Result<Option<ExitStatus>> {
    let mut maximum = format!("{{ \"child-pid\": {}", u32::MAX);
    for namespace in ["cgroup", "ipc", "mnt", "net", "pid", "uts"] {
        maximum.push_str(&format!(", \"{namespace}-namespace\": {}", u64::MAX));
    }
    maximum.push_str(&format!(" }}\n{{ \"exit-code\": {} }}\n", i32::MIN));
    let mut file = File::open(directory.join("launcher.jsonl"))?;
    let mut bytes = Vec::new();
    (&mut file)
        .take(maximum.len() as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > maximum.len() {
        return Err(Error::Invalid);
    }
    let mut started = false;
    let mut exit = None;
    for line in bytes.split_inclusive(|byte| *byte == b'\n') {
        if line.last() != Some(&b'\n') {
            if exit.is_some() {
                return Err(Error::Invalid);
            }
            break;
        }
        if !started {
            let record: Started = serde_json::from_slice(line)?;
            if record.child_pid != process.init_pid
                || record.pid_namespace != process.namespace_inode
                || [
                    record.cgroup_namespace,
                    record.ipc_namespace,
                    record.mnt_namespace,
                    record.net_namespace,
                    record.uts_namespace,
                ]
                .contains(&Some(0))
            {
                return Err(Error::Conflict);
            }
            started = true;
        } else if exit.is_none() {
            let record: Ended = serde_json::from_slice(line)?;
            let code = u8::try_from(record.exit_code).map_err(|_| Error::Invalid)?;
            exit = Some(ExitStatus::Code(i32::from(code)));
        } else {
            return Err(Error::Conflict);
        }
    }
    if exit.is_some() {
        file.sync_all()?;
    }
    Ok(exit)
}
