//! Configuration, trusted namespace policy and signal handling for the worker executable.

use std::{
    net::SocketAddr,
    num::{NonZeroU64, NonZeroUsize},
    path::PathBuf,
    sync::Arc,
    time::Duration,
};

use base64::{Engine as _, prelude::BASE64_URL_SAFE_NO_PAD};
use chopin_job_broker::{
    ControlClient, Credential, Error, JobKey, Result, TransportPolicy, WorkerStart,
    runtime::{
        HostIdentity, LocalWorker, NamespaceConfig, WorkerJournal, WorkerPolicy,
        WorkerServicePolicy, serve_worker,
    },
};
use serde::Deserialize;
use url::Url;
use uuid::Uuid;
use zeroize::Zeroizing;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Configuration {
    version: u32,
    worker: Uuid,
    scope: Uuid,
    domain: Uuid,
    policy_revision: String,
    callback_base: String,
    listen: SocketAddr,
    namespace: NamespaceConfig,
    service: WorkerServicePolicy,
    request_timeout_ms: NonZeroU64,
    response_bytes: NonZeroUsize,
    retry_after_ms: NonZeroU64,
    ca_file: Option<PathBuf>,
}

struct Policy {
    scope: Uuid,
    domain: Uuid,
    revision: String,
    callback: Url,
    namespace: NamespaceConfig,
}

#[async_trait::async_trait]
impl WorkerPolicy for Policy {
    async fn profile(&self, start: &WorkerStart) -> Result<NamespaceConfig> {
        let expected = self
            .callback
            .join(&format!("{}/worker", start.id.operation))
            .map_err(|_| Error::Invalid)?;
        if start.id.scope != self.scope
            || start.request.domain != self.domain
            || start.request.policy_revision != self.revision
            || Url::parse(&start.callback.url).map_err(|_| Error::Invalid)? != expected
        {
            return Err(Error::Forbidden);
        }
        self.namespace.validate()?;
        Ok(self.namespace.clone())
    }
}

pub(super) async fn run() -> Result<()> {
    let args = std::env::args_os().skip(1).collect::<Vec<_>>();
    let [mode, option, file] = args.as_slice() else {
        return Err(Error::Invalid);
    };
    if option != "--config" || !(mode == "init" || mode == "serve") {
        return Err(Error::Invalid);
    }
    let bytes = tokio::fs::read(file).await?;
    let config: Configuration = serde_json::from_slice(&bytes).map_err(|_| Error::Invalid)?;
    if config.version != 1
        || config.worker.is_nil()
        || config.scope.is_nil()
        || config.domain.is_nil()
        || config.policy_revision.is_empty()
    {
        return Err(Error::Invalid);
    }
    let mut callback = Url::parse(&config.callback_base).map_err(|_| Error::Invalid)?;
    if !matches!(callback.scheme(), "http" | "https")
        || !callback.username().is_empty()
        || callback.password().is_some()
        || callback.query().is_some()
        || callback.fragment().is_some()
    {
        return Err(Error::Invalid);
    }
    if !callback.path().ends_with('/') {
        callback.set_path(&format!("{}/", callback.path()));
    }
    config.namespace.validate()?;
    let journal_key = key("CHOPIN_WORKER_JOURNAL_KEY")?;
    let host = HostIdentity::current(config.domain)?;
    if mode == "init" {
        WorkerJournal::create(
            &config.namespace.private_root,
            config.worker,
            host,
            journal_key,
        )
        .await?
        .close()
        .await?;
        println!(
            "{}",
            serde_json::json!({"state":"initialized","worker":config.worker})
        );
        return Ok(());
    }
    let credential =
        Credential::new(std::env::var("CHOPIN_WORKER_TOKEN").map_err(|_| Error::Invalid)?)?;
    let output_key = key("CHOPIN_WORKER_OUTPUT_KEY")?;
    rustls::crypto::ring::default_provider()
        .install_default()
        .map_err(|_| Error::Invalid)?;
    let timeout = Duration::from_millis(config.request_timeout_ms.get());
    if std::time::Instant::now().checked_add(timeout).is_none() {
        return Err(Error::Invalid);
    }
    let mut client = reqwest::Client::builder().no_proxy().timeout(timeout);
    if let Some(path) = &config.ca_file {
        let pem = tokio::fs::read(path).await?;
        client = client.add_root_certificate(
            reqwest::Certificate::from_pem(&pem).map_err(|_| Error::Invalid)?,
        );
    }
    let control = ControlClient::new(
        client,
        TransportPolicy {
            response_bytes: config.response_bytes,
            retry_after_ms: config.retry_after_ms,
        },
    )?;
    let journal = WorkerJournal::open(
        &config.namespace.private_root,
        config.worker,
        host,
        journal_key,
    )
    .await?;
    let worker = LocalWorker::new(
        journal,
        Arc::new(Policy {
            scope: config.scope,
            domain: config.domain,
            revision: config.policy_revision,
            callback,
            namespace: config.namespace,
        }),
        control,
        output_key,
    );
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let mut interrupt = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())?;
    let listener = tokio::net::TcpListener::bind(config.listen).await?;
    println!(
        "{}",
        serde_json::json!({"state":"listening","worker":config.worker,"address":listener.local_addr()?})
    );
    serve_worker(
        worker,
        listener,
        credential,
        config.service,
        async move {
            tokio::select! { _ = terminate.recv() => {}, _ = interrupt.recv() => {} }
        },
        |result| {
            if let Err(error) = result.result {
                if let Error::Io(local) = &error {
                    eprintln!(
                        "worker operation {:?} remains unconfirmed: {error}; local I/O kind={:?} errno={:?}: {local}",
                        result.id, local.kind(), local.raw_os_error()
                    );
                } else {
                    eprintln!(
                        "worker operation {:?} remains unconfirmed: {error}",
                        result.id
                    );
                }
            }
        },
    )
    .await
}

fn key(name: &str) -> Result<Arc<JobKey>> {
    let encoded = Zeroizing::new(std::env::var(name).map_err(|_| Error::Invalid)?);
    let mut bytes = Zeroizing::new([0; 32]);
    if BASE64_URL_SAFE_NO_PAD
        .decode_slice(encoded.as_bytes(), bytes.as_mut_slice())
        .map_err(|_| Error::Invalid)?
        != bytes.len()
    {
        return Err(Error::Invalid);
    }
    Ok(Arc::new(JobKey::new(*bytes)))
}
