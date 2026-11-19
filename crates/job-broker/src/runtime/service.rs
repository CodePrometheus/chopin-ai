//! Host-owned HTTP and recovery lifetime for one durable worker registration.

use std::{
    future::Future,
    num::{NonZeroU64, NonZeroUsize},
    sync::Arc,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tokio::{net::TcpListener, sync::watch};

use super::{LocalWorker, WorkerRecovery};
use crate::{Credential, Error, Result};

/// Explicit hosting bounds; the original command keeps its own admission policy.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkerServicePolicy {
    /// Maximum admission envelope consumed by the private control listener.
    pub max_body_bytes: NonZeroUsize,
    /// Maximum source records reconciled before checking shutdown again.
    pub recovery_page_size: NonZeroUsize,
    /// Fallback interval when no admission or stop notification arrives.
    pub recovery_interval_ms: NonZeroU64,
}

/// Serve and reconcile until shutdown, observing both task results before closing the journal.
/// Released commands and protected output capture outlive this controller process.
///
/// # Errors
/// Returns invalid-policy, listener, recovery, task-join or journal-close failures.
/// An error does not establish whether an admitted command ran or stopped.
///
/// # Cancellation
/// Drive this future to completion and request shutdown through `shutdown`.
/// Dropping it does not confirm task completion or journal closure and does not
/// stop released commands.
pub async fn serve_worker<F, R>(
    worker: LocalWorker,
    listener: TcpListener,
    credential: Credential,
    policy: WorkerServicePolicy,
    shutdown: F,
    report: R,
) -> Result<()>
where
    F: Future<Output = ()> + Send,
    R: Fn(WorkerRecovery) + Send + Sync + 'static,
{
    let interval = Duration::from_millis(policy.recovery_interval_ms.get());
    if std::time::Instant::now().checked_add(interval).is_none() {
        return Err(Error::Invalid);
    }
    let worker = Arc::new(worker);
    let (stop, stopped) = watch::channel(false);
    let mut http_stop = stopped.clone();
    let router = worker.clone().router(credential, policy.max_body_bytes);
    let mut http = tokio::spawn(async move {
        axum::serve(listener, router)
            .with_graceful_shutdown(async move {
                let _ = http_stop.wait_for(|stop| *stop).await;
            })
            .await
            .map_err(Error::Io)
    });
    let recovering = worker.clone();
    let mut recover_stop = stopped;
    let mut recovery = tokio::spawn(async move {
        loop {
            let mut after = None;
            loop {
                if *recover_stop.borrow() {
                    return Ok::<(), Error>(());
                }
                let page = recovering.recover(after, policy.recovery_page_size).await?;
                for result in page.results {
                    report(result);
                }
                let Some(next) = page.next else {
                    break;
                };
                after = Some(next);
            }
            tokio::select! {
                _ = recover_stop.wait_for(|stop| *stop) => return Ok::<(), Error>(()),
                _ = tokio::time::sleep(interval) => {},
                _ = recovering.changed() => {},
            }
        }
    });
    tokio::pin!(shutdown);
    let mut http_done = None;
    let mut recovery_done = None;
    tokio::select! {
        _ = &mut shutdown => {},
        result = &mut http => http_done = Some(result),
        result = &mut recovery => recovery_done = Some(result),
    }
    let unexpected = http_done.is_some() || recovery_done.is_some();
    let _ = stop.send(true);
    let http_result = match http_done {
        Some(result) => result,
        None => http.await,
    };
    let recovery_result = match recovery_done {
        Some(result) => result,
        None => recovery.await,
    };
    let worker = Arc::try_unwrap(worker).map_err(|_| Error::Conflict)?;
    let closed = worker.close().await;
    http_result.map_err(|error| Error::Io(std::io::Error::other(error)))??;
    recovery_result.map_err(|error| Error::Io(std::io::Error::other(error)))??;
    closed?;
    if unexpected {
        return Err(Error::Io(std::io::Error::other(
            "worker hosting task stopped unexpectedly",
        )));
    }
    Ok(())
}
