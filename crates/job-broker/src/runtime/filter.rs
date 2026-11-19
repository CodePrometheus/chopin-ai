use std::{
    collections::BTreeMap,
    fs::File,
    io::{Seek, SeekFrom, Write},
};

use rustix::fs::{MemfdFlags, SealFlags, fcntl_add_seals, memfd_create};
use seccompiler::{
    BpfProgram, SeccompAction, SeccompCmpArgLen, SeccompCmpOp, SeccompCondition, SeccompFilter,
    SeccompRule,
};

use crate::Result;

pub(super) fn create() -> Result<File> {
    if !cfg!(target_endian = "little") {
        return Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "command filtering requires a supported little-endian architecture",
        )
        .into());
    }
    let mut rules = BTreeMap::new();
    // pid_t uses the low 32 bits even when a caller supplies a wider syscall argument.
    for (syscall, argument) in [
        (nix::libc::SYS_ptrace, 1),
        (nix::libc::SYS_process_vm_readv, 0),
        (nix::libc::SYS_process_vm_writev, 0),
    ] {
        let condition =
            SeccompCondition::new(argument, SeccompCmpArgLen::Dword, SeccompCmpOp::Eq, 1)
                .map_err(std::io::Error::other)?;
        rules.insert(
            syscall,
            vec![SeccompRule::new(vec![condition]).map_err(std::io::Error::other)?],
        );
    }
    rules.insert(nix::libc::SYS_pidfd_getfd, Vec::new());
    let filter = SeccompFilter::new(
        rules,
        SeccompAction::Allow,
        SeccompAction::Errno(nix::libc::EPERM as u32),
        std::env::consts::ARCH
            .try_into()
            .map_err(std::io::Error::other)?,
    )
    .map_err(std::io::Error::other)?;
    // Compilation does not query optional kernel discovery APIs. Installation remains mandatory at the gate.
    let program: BpfProgram = filter.try_into().map_err(std::io::Error::other)?;
    #[cfg(target_arch = "x86_64")]
    let program = reject_compatibility_abi(program);
    let mut bytes = Vec::with_capacity(std::mem::size_of_val(program.as_slice()));
    for instruction in program {
        bytes.extend_from_slice(&instruction.code.to_ne_bytes());
        bytes.extend([instruction.jt, instruction.jf]);
        bytes.extend_from_slice(&instruction.k.to_ne_bytes());
    }
    let mut file = File::from(
        memfd_create(
            c"command-policy",
            MemfdFlags::CLOEXEC | MemfdFlags::ALLOW_SEALING,
        )
        .map_err(std::io::Error::from)?,
    );
    file.write_all(&bytes)?;
    file.seek(SeekFrom::Start(0))?;
    fcntl_add_seals(
        &file,
        SealFlags::SEAL | SealFlags::SHRINK | SealFlags::GROW | SealFlags::WRITE,
    )
    .map_err(std::io::Error::from)?;
    Ok(file)
}

#[cfg(target_arch = "x86_64")]
fn reject_compatibility_abi(mut program: BpfProgram) -> BpfProgram {
    use seccompiler::sock_filter as Instruction;

    // x32 shares the audit architecture but has different syscall numbers. Preserve the -1 tracer sentinel.
    drop(program.splice(
        0..0,
        [
            Instruction {
                code: (nix::libc::BPF_LD | nix::libc::BPF_W | nix::libc::BPF_ABS) as u16,
                jt: 0,
                jf: 0,
                k: 0,
            },
            Instruction {
                code: (nix::libc::BPF_JMP | nix::libc::BPF_JEQ | nix::libc::BPF_K) as u16,
                jt: 2,
                jf: 0,
                k: u32::MAX,
            },
            Instruction {
                code: (nix::libc::BPF_JMP | nix::libc::BPF_JGE | nix::libc::BPF_K) as u16,
                jt: 0,
                jf: 1,
                k: 0x4000_0000,
            },
            Instruction {
                code: (nix::libc::BPF_RET | nix::libc::BPF_K) as u16,
                jt: 0,
                jf: 0,
                k: nix::libc::SECCOMP_RET_KILL_PROCESS,
            },
        ],
    ));
    program
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use command_fds::{CommandFdExt, FdMapping};
    #[cfg(target_arch = "x86_64")]
    use std::os::unix::process::ExitStatusExt;
    use std::process::{Command, Output};

    const PROBE: &str = r#"import ctypes,errno,os,sys
class Instruction(ctypes.Structure):
    _fields_=[('code',ctypes.c_ushort),('jt',ctypes.c_ubyte),('jf',ctypes.c_ubyte),('k',ctypes.c_uint)]
class Program(ctypes.Structure):
    _fields_=[('length',ctypes.c_ushort),('instructions',ctypes.POINTER(Instruction))]
with os.fdopen(3,'rb') as policy:
    data=policy.read()
assert len(data)%ctypes.sizeof(Instruction)==0
instructions=(Instruction*(len(data)//ctypes.sizeof(Instruction))).from_buffer_copy(data)
program=Program(len(instructions),instructions)
libc=ctypes.CDLL(None,use_errno=True)
libc.prctl.argtypes=[ctypes.c_int,ctypes.c_ulong,ctypes.c_void_p,ctypes.c_ulong,ctypes.c_ulong]
libc.syscall.restype=ctypes.c_long
if sys.argv[1]!='baseline':
    assert libc.prctl(38,1,None,0,0)==0,ctypes.get_errno()
    assert libc.prctl(22,2,ctypes.byref(program),0,0)==0,ctypes.get_errno()
result=libc.syscall(ctypes.c_long(int(sys.argv[2])))
if sys.argv[1]=='sentinel':
    assert result==-1 and ctypes.get_errno()==errno.ENOSYS
print('returned',flush=True)
"#;

    fn run(mode: &str, syscall: i64) -> Output {
        assert_ne!(rustix::process::geteuid().as_raw(), 0);
        let file = create().expect("the actual command policy must compile");
        let mut command = Command::new("/usr/bin/python3");
        command
            .env_clear()
            .args(["-c", PROBE, mode])
            .arg(syscall.to_string());
        command
            .fd_mappings(vec![FdMapping {
                parent_fd: file.into(),
                child_fd: 3,
            }])
            .expect("the original policy descriptor must be inherited");
        command
            .output()
            .expect("the isolated syscall probe must run")
    }

    #[test]
    #[ignore = "requires non-root Linux and Python"]
    fn tracer_sentinel() {
        let result = run("sentinel", -1);
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        assert_eq!(result.stdout, b"returned\n");
    }

    #[test]
    #[cfg(target_arch = "x86_64")]
    #[ignore = "requires non-root Linux and Python"]
    fn native_abi() {
        let syscall = nix::libc::SYS_getpid | 0x4000_0000;
        let baseline = run("baseline", syscall);
        assert!(
            baseline.status.success(),
            "the outer profile must permit the paired baseline: {}",
            String::from_utf8_lossy(&baseline.stderr)
        );
        assert_eq!(baseline.stdout, b"returned\n");
        let filtered = run("filtered", syscall);
        assert_eq!(
            filtered.status.signal(),
            Some(nix::libc::SIGSYS),
            "{}",
            String::from_utf8_lossy(&filtered.stderr)
        );
        assert!(filtered.stdout.is_empty());
    }
}
