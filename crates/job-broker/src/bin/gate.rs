//! Explicit-release entry point inside a command's established namespace.

#[cfg(target_os = "linux")]
fn main() {
    if start().is_err() {
        eprintln!("command gate refused execution");
        std::process::exit(1);
    }
}
#[cfg(target_os = "linux")]
fn start() -> chopin_job_broker::Result<std::convert::Infallible> {
    use chopin_job_broker::{
        Error,
        runtime::{HostIdentity, run_gate},
    };
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let [maximum, host, status, proc_root] = args.as_slice() else {
        return Err(Error::Invalid);
    };
    let maximum = maximum.parse().map_err(|_| Error::Invalid)?;
    let host: HostIdentity = serde_json::from_str(host)?;
    let status = status.parse().map_err(|_| Error::Invalid)?;
    let proc_root = proc_root.parse().map_err(|_| Error::Invalid)?;
    run_gate(maximum, &host, status, proc_root)
}
#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("command isolation requires a supported operating system");
    std::process::exit(1);
}
