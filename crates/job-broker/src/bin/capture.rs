//! Protected output capture, independent of the command controller's lifetime.

#[cfg(target_os = "linux")]
fn main() {
    if start().is_err() {
        eprintln!("command output capture failed");
        std::process::exit(1);
    }
}
#[cfg(target_os = "linux")]
fn start() -> chopin_job_broker::Result<()> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let [spec] = args.as_slice() else {
        return Err(chopin_job_broker::Error::Invalid);
    };
    chopin_job_broker::runtime::run_capture(spec)
}
#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("command output capture requires a supported operating system");
    std::process::exit(1);
}
