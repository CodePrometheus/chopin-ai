use std::{
    fs::File,
    io::{Seek, SeekFrom},
};

use libseccomp::{ScmpAction, ScmpArgCompare, ScmpCompareOp, ScmpFilterContext, ScmpSyscall};
use rustix::fs::{MemfdFlags, SealFlags, fcntl_add_seals, memfd_create};

use crate::Result;

pub(super) fn create() -> Result<File> {
    let mut filter = ScmpFilterContext::new(ScmpAction::Allow).map_err(std::io::Error::other)?;
    filter
        .set_act_badarch(ScmpAction::KillProcess)
        .map_err(std::io::Error::other)?;
    let denied = ScmpAction::Errno(nix::libc::EPERM);
    // pid_t uses the low 32 bits even when a caller supplies a wider syscall argument.
    for (name, argument) in [
        ("ptrace", 1),
        ("process_vm_readv", 0),
        ("process_vm_writev", 0),
    ] {
        let syscall = ScmpSyscall::from_name(name).map_err(std::io::Error::other)?;
        filter
            .add_rule_conditional(
                denied,
                syscall,
                &[ScmpArgCompare::new(
                    argument,
                    ScmpCompareOp::MaskedEqual(u64::from(u32::MAX)),
                    1,
                )],
            )
            .map_err(std::io::Error::other)?;
    }
    filter
        .add_rule(
            denied,
            ScmpSyscall::from_name("pidfd_getfd").map_err(std::io::Error::other)?,
        )
        .map_err(std::io::Error::other)?;
    let mut file = File::from(
        memfd_create(
            c"command-policy",
            MemfdFlags::CLOEXEC | MemfdFlags::ALLOW_SEALING,
        )
        .map_err(std::io::Error::from)?,
    );
    filter.export_bpf(&file).map_err(std::io::Error::other)?;
    file.seek(SeekFrom::Start(0))?;
    fcntl_add_seals(
        &file,
        SealFlags::SEAL | SealFlags::SHRINK | SealFlags::GROW | SealFlags::WRITE,
    )
    .map_err(std::io::Error::from)?;
    Ok(file)
}
