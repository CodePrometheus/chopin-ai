//! Private command-worker service with explicit initialization and original-journal recovery.

#[cfg(target_os = "linux")]
#[path = "worker/service.rs"]
mod service;

#[cfg(target_os = "linux")]
#[tokio::main]
async fn main() -> std::process::ExitCode {
    match service::run().await {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("command worker failed: {error}");
            std::process::ExitCode::FAILURE
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn main() -> std::process::ExitCode {
    eprintln!("command worker requires Linux");
    std::process::ExitCode::FAILURE
}
